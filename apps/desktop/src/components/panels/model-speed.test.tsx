import type { ModelCall, ModelStat } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    return Promise.resolve(f(params));
  },
}));
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { formatContext, loadsDominate, ModelPerformance } from "./ModelPerformance";
import { ModelSpeedSettings } from "./SettingsSections";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const ts = "2026-11-07T10:00:00.000Z";
function stat(over: Partial<ModelStat>): ModelStat {
  return {
    providerId: "ollama",
    model: "qwen2.5-coder:7b",
    calls: 6,
    errors: 0,
    avgTokensPerSec: 9.4,
    medianTtftMs: 1800,
    lastAt: ts,
    lastError: null,
    contextLength: 16384,
    coldLoads: 1,
    medianLoadMs: 6500,
    loadMsTotal: 6500,
    busyMsTotal: 60_000,
    keptLoaded: true,
    avgPromptTokensPerSec: 420,
    cachedPromptTokens: null,
    ...over,
  };
}
function modelCall(over: Partial<ModelCall>): ModelCall {
  return {
    ts,
    providerId: "ollama",
    providerKind: "ollama",
    model: "qwen2.5-coder:7b",
    ok: true,
    error: null,
    errorKind: null,
    promptTokens: 1200,
    completionTokens: 40,
    ttftMs: 8000,
    durationMs: 12_000,
    tokensPerSec: 9.4,
    projectId: "prj_1",
    taskId: "tsk_1",
    agent: "coder@1.0.0",
    loadMs: 6500,
    coldLoad: true,
    promptTokensPerSec: 400,
    contextLength: 16384,
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ settingsOpen: false });
});
afterEach(cleanup);

test("per model: load time, kept loaded, reading and writing speed, and the context length", async () => {
  responses["models.stats"] = () => ({
    models: [
      stat({}),
      stat({
        model: "qwen2.5-coder:3b",
        coldLoads: 0,
        medianLoadMs: null,
        loadMsTotal: 0,
        keptLoaded: true,
        avgPromptTokensPerSec: null,
        avgTokensPerSec: 31,
        contextLength: 8192,
        errors: 1,
        lastError: "Ollama is not running.",
      }),
    ],
    calls: [modelCall({}), modelCall({ coldLoad: false, loadMs: 20, ts: "2026-11-07T10:01:00.000Z" })],
  });
  wrap(<ModelPerformance />);
  const table = await screen.findByRole("table", { name: "Speed per model" });
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual(["Model", "Calls", "Load", "Reading", "Writing", "First token"]);
  const rows = within(table).getAllByRole("row").slice(1);
  const seven = rows[0] as HTMLElement;
  expect(within(seven).getByText("16k context")).toBeTruthy();
  expect(within(seven).getByText("6.5 s")).toBeTruthy();
  expect(within(seven).getByText("kept loaded")).toBeTruthy();
  expect(within(seven).getByText("420 tok/s")).toBeTruthy();
  expect(within(seven).getByText("9.4 tok/s")).toBeTruthy();
  const three = rows[1] as HTMLElement;
  expect(within(three).getByText("Kept loaded")).toBeTruthy();
  expect(within(three).getByText("8k context")).toBeTruthy();
  expect(within(three).getByText("1 failed").getAttribute("title")).toBe("Ollama is not running.");
  // A call that had to load the model says so.
  const recent = screen.getByRole("list", { name: "Recent model calls" });
  expect(within(recent).getByText(/loaded in 6\.5 s/)).toBeTruthy();
  expect(within(recent).getAllByText(/loaded in/)).toHaveLength(1);
  // Loads are a small share of the time here: no hint.
  expect(screen.queryByRole("note")).toBeNull();
});

test("when loads take most of the time, a short hint points to the setting", async () => {
  responses["models.stats"] = () => ({
    models: [
      stat({ coldLoads: 3, loadMsTotal: 40_000, busyMsTotal: 60_000, keptLoaded: false }),
      stat({
        model: "gpt-oss:20b",
        coldLoads: 2,
        loadMsTotal: 30_000,
        busyMsTotal: 50_000,
        keptLoaded: false,
      }),
    ],
    calls: [],
  });
  wrap(<ModelPerformance />);
  const note = await screen.findByRole("note");
  expect(note.textContent).toContain(
    "Most time goes to loading models. Keep them loaded longer or use one model for more roles.",
  );
  fireEvent.click(within(note).getByRole("button", { name: "Open settings" }));
  expect(useUi.getState().settingsOpen).toBe(true);
});

test("loadsDominate needs two loads and a large share; formatContext rounds to k", () => {
  expect(loadsDominate([stat({ coldLoads: 1, loadMsTotal: 50_000, busyMsTotal: 60_000 })])).toBe(false);
  expect(loadsDominate([stat({ coldLoads: 2, loadMsTotal: 20_000, busyMsTotal: 60_000 })])).toBe(false);
  expect(loadsDominate([stat({ coldLoads: 2, loadMsTotal: 30_000, busyMsTotal: 60_000 })])).toBe(true);
  // Stats from an older engine have no load fields.
  expect(
    loadsDominate([
      {
        providerId: "o",
        model: "m",
        calls: 1,
        errors: 0,
        avgTokensPerSec: 1,
        medianTtftMs: 1,
        lastAt: ts,
        lastError: null,
      },
    ]),
  ).toBe(false);
  expect(formatContext(16384)).toBe("16k");
  expect(formatContext(32768)).toBe("32k");
  expect(formatContext(null)).toBeNull();
});

test("settings: keep models loaded for, and load the next model early", async () => {
  const store: Record<string, unknown> = {};
  responses["settings.get"] = (p) => {
    const key = (p as { key: string }).key;
    return { key, value: store[key] ?? null };
  };
  responses["settings.set"] = (p) => {
    const { key, value } = p as { key: string; value: unknown };
    store[key] = value;
    return { key, value };
  };
  wrap(<ModelSpeedSettings />);
  const select = (await screen.findByLabelText("Keep models loaded for")) as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe("30m");
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "5 minutes",
    "30 minutes",
    "2 hours",
    "Until Depo closes",
  ]);
  fireEvent.change(select, { target: { value: "-1" } });
  await waitFor(() => expect(store["models.keep_alive"]).toBe("-1"));
  const early = screen.getByLabelText("Load the next model early") as HTMLInputElement;
  await waitFor(() => expect(early.disabled).toBe(false));
  expect(early.checked).toBe(true);
  fireEvent.click(early);
  await waitFor(() => expect(store["models.preload"]).toBe(false));
});

test("settings: a value set elsewhere shows as a custom choice", async () => {
  responses["settings.get"] = (p) => {
    const key = (p as { key: string }).key;
    return { key, value: key === "models.keep_alive" ? "45m" : null };
  };
  wrap(<ModelSpeedSettings />);
  const select = (await screen.findByLabelText("Keep models loaded for")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("45m"));
  expect(select.selectedOptions[0]?.textContent).toBe("Custom (45m)");
});

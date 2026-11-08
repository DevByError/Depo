import type { ChangeSet, MemoryFact } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { DiffReviewPanel } from "./DiffReviewPanel";
import { MemoryPanel } from "./MemoryPanel";
import { MemorySetting, StepUpSetting } from "./SettingsSections";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = new Date().toISOString();
function fact(id: string, text: string, source: MemoryFact["source"]): MemoryFact {
  return {
    id,
    projectId: "prj_1",
    kind: "fact",
    text,
    signature: null,
    source,
    uses: 0,
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", changeSetId: null });
});
afterEach(cleanup);

test("settings: the memory toggle reads and saves memory.auto", async () => {
  const store: Record<string, unknown> = {};
  responses["settings.get"] = (p) => ({ key: (p as { key: string }).key, value: null });
  responses["settings.set"] = (p) => {
    const { key, value } = p as { key: string; value: unknown };
    store[key] = value;
    return { key, value };
  };
  wrap(<MemorySetting />);
  const box = (await screen.findByLabelText(/Remember what each task teaches/)) as HTMLInputElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  await waitFor(() => expect(store["memory.auto"]).toBe(false));
});

test("settings: the small-model step-up toggle reads and saves agent.step_up", async () => {
  const store: Record<string, unknown> = {};
  responses["settings.get"] = (p) => ({ key: (p as { key: string }).key, value: null });
  responses["settings.set"] = (p) => {
    const { key, value } = p as { key: string; value: unknown };
    store[key] = value;
    return { key, value };
  };
  wrap(<StepUpSetting />);
  const box = (await screen.findByLabelText(/Let a larger model take a step/)) as HTMLInputElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  await waitFor(() => expect(store["agent.step_up"]).toBe(false));
});

test("memory panel: items Depo saved by itself carry an auto badge and can be deleted", async () => {
  let facts = [
    fact("mem_1", "Stack: Python with FastAPI; pytest", "auto"),
    fact("mem_2", "The API listens on port 8000", "user"),
  ];
  responses["memory.get"] = () => ({ markdown: "", facts });
  responses["memory.deleteFact"] = (p) => {
    facts = facts.filter((f) => f.id !== (p as { id: string }).id);
    return { ok: true };
  };
  wrap(<MemoryPanel />);
  const auto = await screen.findByText("Stack: Python with FastAPI; pytest");
  const row = auto.closest("li") as HTMLElement;
  expect(row.textContent).toContain("auto");
  const userRow = screen.getByText("The API listens on port 8000").closest("li") as HTMLElement;
  expect(userRow.textContent).not.toMatch(/\bauto\b/);

  const del = row.querySelector('button[aria-label="Delete"]') as HTMLButtonElement;
  fireEvent.click(del);
  await waitFor(() =>
    expect(
      calls.some((c) => c.method === "memory.deleteFact" && (c.params as { id: string }).id === "mem_1"),
    ).toBe(true),
  );
});

test("diff review: discard asks first and sends the optional reason", async () => {
  const cs: ChangeSet = {
    id: "cs_1",
    projectId: "prj_1",
    taskId: "tsk_1",
    status: "pending",
    title: "Add a health endpoint",
    files: [
      {
        path: "app/main.py",
        kind: "modified",
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" a", "+b"] }],
        baseHash: null,
        conflict: false,
        status: "pending",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  responses["changes.list"] = () => ({ changeSets: [cs] });
  responses["checkpoints.list"] = () => ({ checkpoints: [] });
  responses["changes.discard"] = () => ({ ...cs, status: "discarded" });
  wrap(<DiffReviewPanel />);

  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  expect(calls.some((c) => c.method === "changes.discard")).toBe(false);
  // Keep closes the question without discarding.
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(screen.queryByLabelText(/Tell Depo why/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  fireEvent.change(screen.getByLabelText(/Tell Depo why/), { target: { value: "  Keep the old routes  " } });
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => {
    const c = calls.find((x) => x.method === "changes.discard");
    expect(c?.params).toEqual({ id: "cs_1", reason: "Keep the old routes" });
  });
});

test("diff review: discarding without a reason sends no reason", async () => {
  const cs = {
    id: "cs_2",
    projectId: "prj_1",
    taskId: null,
    status: "pending",
    title: "Tweak",
    files: [],
    createdAt: now,
    updatedAt: now,
  } satisfies ChangeSet;
  responses["changes.list"] = () => ({ changeSets: [cs] });
  responses["checkpoints.list"] = () => ({ checkpoints: [] });
  responses["changes.discard"] = () => ({ ...cs, status: "discarded" });
  wrap(<DiffReviewPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => {
    const c = calls.find((x) => x.method === "changes.discard");
    expect(c?.params).toEqual({ id: "cs_2" });
  });
});

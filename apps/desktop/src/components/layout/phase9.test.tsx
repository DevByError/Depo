import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useNotifications } from "@/store/notifications";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    try {
      return Promise.resolve(f(params));
    } catch (e) {
      return Promise.reject(e);
    }
  },
  setTheme: (t: string) => {
    useUi.getState().setTheme(t as "dark" | "light");
    return Promise.resolve();
  },
}));
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { NotificationSetting, TeamSettings, UpdateSetting } from "../panels/SettingsSections";
import { CommandPalette } from "./CommandPalette";
import { NotificationBell } from "./NotificationBell";
import { OnboardingDialog } from "./OnboardingDialog";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({
    centerTab: "overview",
    paletteOpen: false,
    onboardingOpen: false,
    settingsOpen: false,
    projectId: "prj_1",
    projectDialog: null,
    taskId: null,
  });
  useNotifications.setState({ items: [], enabled: true });
});
afterEach(cleanup);

test("palette: opens, filters as you type, moves with the arrow keys and runs with Enter", async () => {
  responses["search.everything"] = (p) => ({ query: (p as { query: string }).query, groups: [], tookMs: 1 });
  wrap(<CommandPalette />);
  act(() => useUi.getState().setPaletteOpen(true));
  const input = await screen.findByRole("combobox", { name: "Type a command" });
  fireEvent.change(input, { target: { value: "agent lab" } });
  const options = screen.getAllByRole("option");
  expect(options[0]?.textContent).toContain("Agent Lab");
  expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useUi.getState().centerTab).toBe("agent-lab");
  expect(useUi.getState().paletteOpen).toBe(false);

  act(() => useUi.getState().setPaletteOpen(true));
  const input2 = await screen.findByRole("combobox", { name: "Type a command" });
  expect((input2 as HTMLInputElement).value).toBe("");
  fireEvent.change(input2, { target: { value: "go to" } });
  fireEvent.keyDown(input2, { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input2, { key: "ArrowUp" });
  expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.change(input2, { target: { value: "qqqq" } });
  expect(await screen.findByText("Nothing matches.")).toBeTruthy();
});

test("palette: actions work too (theme, settings)", async () => {
  wrap(<CommandPalette />);
  act(() => useUi.getState().setPaletteOpen(true));
  const options = await screen.findAllByRole("option");
  fireEvent.click(options.find((o) => o.textContent?.includes("Switch between dark")) as HTMLElement);
  expect(useUi.getState().theme).toBe("light");
  act(() => useUi.getState().setPaletteOpen(true));
  const box = await screen.findByRole("combobox", { name: "Type a command" });
  fireEvent.change(box, { target: { value: "open settings" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(useUi.getState().settingsOpen).toBe(true);
});

test("bell: counts new notices, lists them, clears the count when opened and jumps to the task", () => {
  wrap(<NotificationBell />);
  expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  act(() => {
    useNotifications
      .getState()
      .push({ title: "Needs your approval", text: "Run npm install?", level: "attention", taskId: "tsk_9" });
    useNotifications
      .getState()
      .push({ title: "Changes are ready to review", text: "3 files", level: "info", taskId: "tsk_9" });
  });
  fireEvent.click(screen.getByRole("button", { name: "Notifications, 2 new" }));
  expect(screen.getByText("Run npm install?")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  fireEvent.click(screen.getByText("Changes are ready to review"));
  expect(useUi.getState().taskId).toBe("tsk_9");
  expect(useUi.getState().centerTab).toBe("diff");
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(useNotifications.getState().items).toHaveLength(0);
});

const profile = {
  os: { platform: "win32", release: "11", arch: "x64" },
  cpu: { model: "Test CPU", threads: 8, avx: true, avx2: true, avx512: false },
  ramGB: 16,
  unifiedMemory: false,
  gpus: [{ name: "GTX 1650", vendor: "nvidia", vramGB: 4, source: "nvidia-smi" }],
  diskFreeGB: 120,
  benchmark: null,
  profiledAt: new Date().toISOString(),
};

test("onboarding: walks through the steps, shows the hardware, and saves that it was seen", async () => {
  responses["hardware.get"] = () => ({ profile });
  responses["models.installed"] = () => ({ models: [] });
  responses["settings.set"] = (p) => ({ key: (p as { key: string }).key, value: true });
  wrap(<OnboardingDialog />);
  act(() => useUi.getState().setOnboardingOpen(true));
  expect(await screen.findByText("Welcome to Depo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText(/GTX 1650 \(4 GB video memory\)/)).toBeTruthy();
  expect(screen.getByText(/No model is installed yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByText("Welcome to Depo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open Chat" }));
  expect(useUi.getState().centerTab).toBe("chat");
  expect(useUi.getState().onboardingOpen).toBe(false);
  await waitFor(() =>
    expect(calls.find((c) => c.method === "settings.set")?.params).toEqual({
      key: "ui.onboarded",
      value: true,
    }),
  );
});

test("onboarding: skipping also counts as seen, and the project buttons open the right dialog", async () => {
  responses["hardware.get"] = () => ({ profile: null });
  responses["models.installed"] = () => ({ models: [{ name: "m" }] });
  responses["settings.set"] = (p) => ({ key: (p as { key: string }).key, value: true });
  wrap(<OnboardingDialog />);
  act(() => useUi.getState().setOnboardingOpen(true));
  fireEvent.click(await screen.findByRole("button", { name: "Skip the tour" }));
  expect(useUi.getState().onboardingOpen).toBe(false);
  await waitFor(() => expect(calls.some((c) => c.method === "settings.set")).toBe(true));
  act(() => useUi.getState().setOnboardingOpen(true));
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Import a project" }));
  expect(useUi.getState().projectDialog).toEqual({ kind: "import" });
});

test("settings: team options are read and saved; notifications and update check work", async () => {
  const store: Record<string, unknown> = { "team.reviews": "key", "team.fix_loops": 3 };
  responses["settings.get"] = (p) => ({
    key: (p as { key: string }).key,
    value: store[(p as { key: string }).key] ?? null,
  });
  responses["settings.set"] = (p) => {
    const { key, value } = p as { key: string; value: unknown };
    store[key] = value;
    return { key, value };
  };
  responses["app.checkUpdate"] = () => ({
    status: "available",
    current: "0.1.0",
    latest: "0.2.0",
    url: "https://github.com/acme/depo/releases/tag/v0.2.0",
    notes: "",
    message: "Version 0.2.0 is available.",
  });
  wrap(
    <>
      <TeamSettings />
      <NotificationSetting />
      <UpdateSetting />
    </>,
  );
  const reviews = (await screen.findByLabelText(/Reviews/)) as HTMLSelectElement;
  await waitFor(() => expect(reviews.value).toBe("key"));
  fireEvent.change(reviews, { target: { value: "off" } });
  await waitFor(() => expect(store["team.reviews"]).toBe("off"));
  fireEvent.click(screen.getByLabelText(/Show me the plan/));
  await waitFor(() => expect(store["team.approve_plan"]).toBe(false));
  fireEvent.click(screen.getByLabelText(/Tell me when a task/));
  await waitFor(() => expect(store["notify.enabled"]).toBe(false));
  expect(useNotifications.getState().enabled).toBe(false);

  fireEvent.change(screen.getByLabelText("Release repository"), { target: { value: " acme/depo " } });
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText(/Version 0.2.0 is available/)).toBeTruthy();
  expect(store["update.repo"]).toBe("acme/depo");
  const link = screen.getByRole("link", { name: "Open the download page" }) as HTMLAnchorElement;
  expect(link.href).toBe("https://github.com/acme/depo/releases/tag/v0.2.0");
  expect(link.rel).toContain("noopener");
});

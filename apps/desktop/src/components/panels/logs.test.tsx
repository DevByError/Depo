import type { DepoEvent, LogLine } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

// jsdom has no layout, so the virtual list would render nothing: render every row instead.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getTotalSize: () => o.count * 30,
    getVirtualItems: () =>
      Array.from({ length: o.count }, (_, i) => ({ index: i, key: o.getItemKey?.(i) ?? i, start: i * 30 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

const line = (id: string, level: LogLine["level"], msg: string, extra: Partial<LogLine> = {}): LogLine => ({
  id,
  ts: "2026-11-07T10:00:00.000Z",
  level,
  component: "tools",
  msg,
  projectId: "prj_1",
  taskId: null,
  agent: null,
  durationMs: null,
  err: null,
  data: {},
  ...extra,
});

const calls: { method: string; params: Record<string, unknown> }[] = [];
let tailLines: LogLine[] = [];
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    switch (method) {
      case "logs.query":
        return Promise.resolve({
          lines: [
            line("q1", "info", "tool call", { taskId: "tsk_1", durationMs: 12, data: { tool: "read_file" } }),
            line("q2", "error", "task crashed", {
              component: "tasks",
              err: { name: "Error", message: "boom", stack: "Error: boom\n    at run (tasks.ts:1)" },
            }),
          ],
          next: "2026-11-07T10:00:00.000Z|2",
          cursor: 5,
          scannedBytes: 2048,
          truncated: false,
          counts: { debug: 0, info: 1, warn: 0, error: 1 },
        });
      case "logs.tail": {
        const lines = tailLines;
        tailLines = [];
        return Promise.resolve({ lines, cursor: 6, reset: false });
      }
      case "logs.components":
        return Promise.resolve({ components: ["api", "models", "tasks", "tools"] });
      case "settings.get":
        return Promise.resolve({ key: params.key, value: "info" });
      case "settings.set":
        return Promise.resolve({ key: params.key, value: params.value });
      case "logs.export":
        return Promise.resolve({
          path: "C:\\Users\\me\\Downloads\\depo-diagnostics-20261107-100000.zip",
          bytes: 1000,
          files: [],
        });
      case "logs.openFolder":
        return Promise.resolve({ ok: true, path: "C:\\Users\\me\\AppData\\Local\\Depo\\logs" });
      case "tasks.list":
        return Promise.resolve({
          tasks: [
            {
              id: "tsk_1",
              projectId: "prj_1",
              title: "add a /health endpoint",
              prompt: "",
              status: "done",
              mode: "single",
              model: null,
              summary: null,
              error: null,
              createdAt: "",
              updatedAt: "",
            },
          ],
        });
      case "projects.list":
        return Promise.resolve({ projects: [{ id: "prj_1", name: "shop-api" }] });
      default:
        return Promise.reject(new Error(`unmocked ${method}`));
    }
  },
}));

import { ActivityFeed } from "./ActivityFeed";
import { LogsPanel } from "./LogsPanel";

beforeEach(() => {
  calls.length = 0;
  tailLines = [];
  useEngine.setState({ status: "open", events: [], heartbeats: [], info: null });
  useUi.setState({ projectId: "prj_1", taskId: null, logsTaskId: null, bottomTab: "engine", feedQuery: "" });
});
afterEach(cleanup);

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const lastQuery = () => calls.filter((c) => c.method === "logs.query").at(-1)?.params;

test("Logs: shows lines with counts, filters by level, search and task, and expands a stack", async () => {
  useUi.setState({ taskId: "tsk_1" });
  mount(<LogsPanel />);
  const log = await screen.findByRole("log", { name: "Engine logs" });
  await within(log).findByText("tool call");
  expect(await within(log).findByText("add a /health endpoint")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Errors\s*1/ }).getAttribute("aria-pressed")).toBe("true");
  expect(lastQuery()).toEqual({ limit: 500 });

  // Turning a chip off asks again with the levels that are still on.
  fireEvent.click(screen.getByRole("button", { name: /Debug/ }));
  await waitFor(() => expect(lastQuery()).toEqual({ limit: 500, levels: ["error", "warn", "info"] }));

  // Search waits for typing to pause.
  fireEvent.change(screen.getByRole("textbox", { name: "Search logs" }), { target: { value: "boom" } });
  await waitFor(() => expect(lastQuery()?.text).toBe("boom"));

  fireEvent.change(screen.getByRole("combobox", { name: "Component" }), { target: { value: "tasks" } });
  await waitFor(() => expect(lastQuery()?.component).toBe("tasks"));

  const scope = screen.getByRole("radiogroup", { name: "Show logs from" });
  fireEvent.click(within(scope).getByRole("radio", { name: "This task" }));
  await waitFor(() => expect(lastQuery()?.taskId).toBe("tsk_1"));
  expect(useUi.getState().logsTaskId).toBe("tsk_1");
  expect(screen.getByText(/Showing lines for/)).toBeTruthy();

  // Expanding a row shows its fields and the stack.
  const crashed = await within(log).findByText("task crashed");
  fireEvent.click(crashed.closest("button") as HTMLElement);
  expect(await within(log).findByText(/at run \(tasks\.ts:1\)/)).toBeTruthy();
  expect(within(log).getByText(/"component": "tasks"/)).toBeTruthy();
});

test("Logs: the live tail adds new lines, and export shows where the file went", async () => {
  mount(<LogsPanel />);
  const log = await screen.findByRole("log", { name: "Engine logs" });
  await within(log).findByText("tool call");
  tailLines = [line("live#6", "warn", "model call retry", { component: "agent" })];
  await within(log).findByText("model call retry", {}, { timeout: 3000 });
  const tail = calls.find((c) => c.method === "logs.tail");
  expect(tail?.params).toEqual({ cursor: 5, limit: 1000 });
  expect(screen.getByRole("button", { name: /Warnings\s*1/ })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  expect(await screen.findByText(/Saved to C:\\Users\\me\\Downloads\\depo-diagnostics/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));
  await waitFor(() => expect(calls.some((c) => c.method === "logs.openFolder")).toBe(true));

  fireEvent.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(lastQuery()?.before).toBe("2026-11-07T10:00:00.000Z|2"));
});

const ev = (id: string, type: DepoEvent["type"], extra: Partial<DepoEvent> = {}): DepoEvent =>
  ({
    id,
    seq: 1,
    ts: "2026-11-07T10:00:00.000Z",
    projectId: "prj_1",
    taskId: "tsk_1",
    agent: "backend@1.0.0",
    type,
    text: `${type} text`,
    details: null,
    status: "info",
    durationMs: null,
    ephemeral: false,
    ...extra,
  }) as DepoEvent;

test("Activity feed: task header, category chips, errors only, agent badges and a task logs link", async () => {
  useEngine.setState({
    events: [
      ev("e1", "reading_file"),
      ev("e2", "running_command", { status: "failed" }),
      ev("e3", "test_result", { status: "succeeded", agent: "testing@1.0.0" }),
      ev("e4", "client_connected", { projectId: null, taskId: null, agent: "engine" }),
    ],
  });
  useUi.setState({ taskId: "tsk_1" });
  mount(<ActivityFeed />);
  const feed = screen.getByRole("log", { name: "Activity feed" });
  expect(await within(feed).findByText("add a /health endpoint")).toBeTruthy();
  expect(within(feed).getByText("shop-api")).toBeTruthy();
  expect(within(feed).getAllByText("BE")).toHaveLength(2);
  expect(within(feed).getByText("TE")).toBeTruthy();
  expect(within(feed).getByText("reading_file text")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(within(feed).queryByText("running_command text")).toBeNull();
  expect(within(feed).getByText("reading_file text")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Files" }));

  fireEvent.click(screen.getByRole("button", { name: "Errors only" }));
  expect(within(feed).getByText("running_command text")).toBeTruthy();
  expect(within(feed).queryByText("test_result text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Tests" }));
  expect(within(feed).getByText("No activity matches this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Errors only" }));
  fireEvent.click(screen.getByRole("button", { name: "Tests" }));

  // Absolute time on hover.
  const time = within(feed).getAllByText(/\d\d:\d\d:\d\d/)[0] as HTMLElement;
  expect(time.getAttribute("title")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Open logs for this task" }));
  expect(useUi.getState().bottomTab).toBe("logs");
  expect(useUi.getState().logsTaskId).toBe("tsk_1");
});

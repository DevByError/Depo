import type {
  DepoEvent,
  DiagnosticsResult,
  RuntimeProblem,
  TerminalOutputDetails,
  TerminalRun,
  TestRun,
} from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEngine } from "@/store/engine";
import { useNav } from "@/store/nav";
import { useTerminal } from "@/store/terminal";
import { useUi } from "@/store/ui";

const calls: { method: string; params: Record<string, unknown> }[] = [];
let responses: Record<string, (p: Record<string, unknown>) => unknown> = {};

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    try {
      return Promise.resolve(f(params));
    } catch (e) {
      return Promise.reject(e);
    }
  },
}));

import { ProblemsPanel } from "@/components/panels/ProblemsPanel";
import { TerminalPanel } from "./TerminalPanel";
import { TestResultsPanel } from "./TestResultsPanel";

const TS = "2026-11-07T10:00:00.000Z";

function run(over: Partial<TerminalRun> = {}): TerminalRun {
  return {
    id: "job_1",
    projectId: "prj_1",
    taskId: null,
    target: "Your project",
    command: "npm test",
    category: "test",
    state: "running",
    exitCode: null,
    startedAt: TS,
    endedAt: null,
    durationMs: null,
    lines: 0,
    ...over,
  };
}

let evN = 0;
function output(details: TerminalOutputDetails): DepoEvent {
  return {
    id: `ev_out_${++evN}`,
    seq: evN,
    ts: TS,
    projectId: "prj_1",
    taskId: null,
    agent: "user",
    type: "terminal_output",
    text: "",
    details,
    status: "info",
    durationMs: null,
    ephemeral: true,
  } as DepoEvent;
}

const task = (id: string, status: string, title = "add a /health endpoint") => ({
  id,
  projectId: "prj_1",
  title,
  prompt: "",
  status,
  mode: "single",
  model: null,
  summary: null,
  error: null,
  createdAt: TS,
  updatedAt: TS,
});

const TARGETS = {
  targets: [
    { taskId: null, label: "Project folder", status: null },
    { taskId: "tsk_1", label: "add a /health endpoint", status: "review" },
  ],
};

beforeEach(() => {
  calls.length = 0;
  responses = {
    "preview.targets": () => TARGETS,
    "tasks.list": () => ({ tasks: [task("tsk_1", "review")] }),
    "tasks.send": (p) => ({ ...task("tsk_new", "queued", String(p.text).slice(0, 20)) }),
  };
  useEngine.setState({ status: "open", events: [], heartbeats: [], info: null });
  useUi.setState({ projectId: "prj_1", taskId: null, centerTab: "files", bottomTab: "terminal" });
  useTerminal.setState({ outputs: {}, selected: {}, target: {} });
  useNav.setState({ file: null });
});
afterEach(cleanup);

function mount(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const paramsOf = (method: string) => calls.filter((c) => c.method === method).at(-1)?.params;

test("Terminal: runs a command, streams output, recalls history, stops, and offers a fix when it fails", async () => {
  responses["terminal.list"] = () => ({ runs: [] });
  responses["terminal.history"] = () => ({ commands: ["npm run build"] });
  responses["terminal.run"] = (p) => ({ run: run({ command: String(p.command) }) });
  responses["terminal.kill"] = () => ({ killed: true });
  mount(<TerminalPanel />);

  expect(
    screen.getByText(/Commands that wait for input are not supported\. Add flags like -y\./),
  ).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;

  // Up and Down go through the history and come back to what was typed.
  await waitFor(() => expect(calls.some((c) => c.method === "terminal.history")).toBe(true));
  fireEvent.change(input, { target: { value: "np" } });
  await waitFor(() => {
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("npm run build");
  });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("np");

  fireEvent.change(input, { target: { value: "npm test" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(paramsOf("terminal.run")).toEqual({ projectId: "prj_1", command: "npm test" }));
  await waitFor(() => expect(input.value).toBe(""));

  // Live output arrives as events and stays out of the activity feed.
  act(() => {
    useEngine.getState().receive(
      output({
        runId: "job_1",
        lines: [
          { seq: 1, stream: "out", text: "PASS src/a.test.ts" },
          { seq: 2, stream: "err", text: "FAIL src/b.test.ts", tone: "danger" },
        ],
      }),
    );
  });
  const log = screen.getByRole("log", { name: "Terminal output" });
  expect(await within(log).findByText("FAIL src/b.test.ts")).toBeTruthy();
  expect(within(log).getByText("FAIL src/b.test.ts").className).toContain("text-danger");
  expect(useEngine.getState().events).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(paramsOf("terminal.kill")).toEqual({ runId: "job_1" }));

  act(() => {
    useEngine.getState().receive(
      output({
        runId: "job_1",
        lines: [{ seq: 3, stream: "out", text: "Tests: 1 failed, 1 passed" }],
        run: run({ state: "failed", exitCode: 1, durationMs: 2500, endedAt: TS, lines: 3 }),
      }),
    );
  });
  expect((await screen.findAllByText(/Exit code 1, took 2\.5s/)).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  const recent = screen.getByRole("list", { name: "Recent runs" });
  expect(within(recent).getByText("npm test")).toBeTruthy();
  expect(within(recent).getByText("Failed:")).toBeTruthy();

  // Fix with an agent drafts the request from the output and starts a new task.
  fireEvent.click(screen.getByRole("button", { name: "Fix with an agent" }));
  const dialog = await screen.findByRole("dialog", { name: "Fix with an agent" });
  const box = within(dialog).getByRole("textbox", { name: "Request" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toContain("This command failed with exit code 1"));
  expect(box.value).toContain("npm test");
  expect(box.value).toContain("FAIL src/b.test.ts");
  expect(box.value).toContain("Where: my project folder.");
  expect(within(dialog).getByText("This starts a new task.")).toBeTruthy();
  fireEvent.change(box, { target: { value: `${box.value}\nKeep the public API as it is.` } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
  await waitFor(() => expect(useUi.getState().centerTab).toBe("chat"));
  const sent = paramsOf("tasks.send") as { projectId: string; text: string; taskId?: string };
  expect(sent.projectId).toBe("prj_1");
  expect(sent.taskId).toBeUndefined();
  expect(sent.text).toContain("Keep the public API as it is.");
  expect(useUi.getState().taskId).toBe("tsk_new");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Terminal: a refused command shows why, a task copy target is passed, and a listed run is read back", async () => {
  responses["terminal.list"] = () => ({
    runs: [
      run({ id: "job_9", command: "pytest -q", state: "succeeded", exitCode: 0, durationMs: 800, lines: 2 }),
    ],
  });
  responses["terminal.history"] = () => ({ commands: [] });
  responses["terminal.read"] = () => ({
    run: run({
      id: "job_9",
      command: "pytest -q",
      state: "succeeded",
      exitCode: 0,
      durationMs: 800,
      lines: 2,
    }),
    lines: [
      { seq: 1, stream: "out", text: "..." },
      { seq: 2, stream: "out", text: "2 passed in 0.12s", tone: "success" },
    ],
    next: 2,
    dropped: false,
  });
  responses["terminal.run"] = () => {
    throw new Error("This command is not allowed: shuts down the computer.");
  };
  mount(<TerminalPanel />);

  // The newest run is shown, and its output comes from the engine's buffer.
  const log = screen.getByRole("log", { name: "Terminal output" });
  expect(await within(log).findByText("2 passed in 0.12s")).toBeTruthy();
  expect(paramsOf("terminal.read")).toEqual({ runId: "job_9" });
  expect(screen.queryByRole("button", { name: "Fix with an agent" })).toBeNull();

  // Clear hides what is there.
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(within(log).queryByText("2 passed in 0.12s")).toBeNull();

  const where = screen.getByRole("combobox", { name: "Where" }) as HTMLSelectElement;
  await within(where).findByText("Task copy: add a /health endpoint (not applied yet)");
  fireEvent.change(where, { target: { value: "tsk_1" } });
  expect(useTerminal.getState().target.prj_1).toBe("tsk_1");

  const input = screen.getByRole("textbox", { name: "Command" });
  fireEvent.change(input, { target: { value: "shutdown /s" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This command is not allowed: shuts down the computer.",
  );
  expect(paramsOf("terminal.run")).toEqual({ projectId: "prj_1", command: "shutdown /s", taskId: "tsk_1" });
});

test("Terminal: lines that never arrived are read again from the engine", async () => {
  responses["terminal.list"] = () => ({ runs: [] });
  responses["terminal.history"] = () => ({ commands: [] });
  responses["terminal.read"] = () => ({
    run: run({ id: "job_5", command: "cargo build" }),
    lines: Array.from({ length: 6 }, (_, i) => ({
      seq: i + 1,
      stream: "out" as const,
      text: `line ${i + 1}`,
    })),
    next: 6,
    dropped: false,
  });
  mount(<TerminalPanel />);
  // The UI connected mid-run: the first event it sees starts at line 5.
  act(() => {
    useEngine.getState().receive(
      output({
        runId: "job_5",
        lines: [
          { seq: 5, stream: "out", text: "line 5" },
          { seq: 6, stream: "out", text: "line 6" },
        ],
        run: run({ id: "job_5", command: "cargo build" }),
      }),
    );
  });
  const log = screen.getByRole("log", { name: "Terminal output" });
  expect(await within(log).findByText("line 1")).toBeTruthy();
  expect(within(log).getByText("line 6")).toBeTruthy();
  expect(useTerminal.getState().outputs.job_5?.gap).toBe(false);
});

const failing: TestRun = {
  id: "ev_1",
  source: "agent",
  projectId: "prj_1",
  taskId: "tsk_1",
  target: "add a /health endpoint",
  by: "testing@1.0.0",
  command: "pytest -q",
  at: TS,
  durationMs: 4200,
  ok: false,
  exitCode: 1,
  passed: 3,
  failed: 1,
  summary: "1 failed, 3 passed",
  format: "pytest",
  failures: [
    {
      name: "tests/test_api.py::test_health",
      file: "tests/test_api.py",
      line: 12,
      message: "assert 404 == 200",
    },
  ],
  outputTail: "FAILED tests/test_api.py::test_health - assert 404 == 200",
};
const passing: TestRun = {
  ...failing,
  id: "job_2",
  source: "terminal",
  taskId: null,
  target: "Your project",
  by: "user",
  command: "bun test",
  ok: true,
  exitCode: 0,
  passed: 10,
  failed: 0,
  summary: "10 pass, 0 fail",
  format: "bun",
  failures: [],
};

test("Test results: runs with counts, failures with file links, run again in the Terminal, fix continues the task", async () => {
  responses["tests.runs"] = () => ({ runs: [failing, passing] });
  responses["terminal.run"] = (p) => ({
    run: run({ id: "job_7", command: String(p.command), taskId: (p.taskId as string) ?? null }),
  });
  mount(<TestResultsPanel />);

  expect(await screen.findByText("3 passed, 1 failed")).toBeTruthy();
  const list = screen.getByRole("list", { name: "Test runs" });
  expect(within(list).getByText("10 passed")).toBeTruthy();
  expect(within(list).getByText(/Testing in add a \/health endpoint/)).toBeTruthy();
  expect(within(list).getByText(/You in Your project/)).toBeTruthy();
  expect(within(list).getByText("Failed")).toBeTruthy();
  expect(within(list).getByText("Passed")).toBeTruthy();

  // Opening the failing run shows its failures; the file link opens the Files tab at the line.
  const toggle = within(list).getByText("pytest -q").closest("button") as HTMLButtonElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("assert 404 == 200")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "tests/test_api.py:12" }));
  expect(useNav.getState().file).toMatchObject({ path: "tests/test_api.py", line: 12 });
  expect(useUi.getState().centerTab).toBe("files");

  // Run again: the same command, on the same target, shown in the Terminal.
  fireEvent.click(screen.getByRole("button", { name: "Run again: pytest -q" }));
  await waitFor(() =>
    expect(paramsOf("terminal.run")).toEqual({ projectId: "prj_1", command: "pytest -q", taskId: "tsk_1" }),
  );
  await waitFor(() => expect(useUi.getState().bottomTab).toBe("terminal"));
  expect(useTerminal.getState().target.prj_1).toBe("tsk_1");
  expect(useTerminal.getState().selected.prj_1).toBe("job_7");

  // The task is in review, so the fix continues it.
  expect(screen.queryByRole("button", { name: "Fix with an agent: bun test" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fix with an agent: pytest -q" }));
  const dialog = await screen.findByRole("dialog", { name: "Fix with an agent" });
  const box = within(dialog).getByRole("textbox", { name: "Request" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toContain("1 test failed when the Testing agent ran `pytest -q`"));
  expect(box.value).toContain("tests/test_api.py::test_health (tests/test_api.py:12): assert 404 == 200");
  expect(box.value).toContain('the private copy of the task "add a /health endpoint"');
  expect(
    await within(dialog).findByText(
      'This continues the task "add a /health endpoint" in the same private copy.',
    ),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
  await waitFor(() => expect(paramsOf("tasks.send")?.taskId).toBe("tsk_1"));
  await waitFor(() => expect(useUi.getState().centerTab).toBe("chat"));
});

test("Test results: says what shows up here when there are no runs", async () => {
  responses["tests.runs"] = () => ({ runs: [] });
  mount(<TestResultsPanel />);
  expect(await screen.findByText(/No test runs yet/)).toBeTruthy();
});

const checked: DiagnosticsResult = {
  projectId: "prj_1",
  taskId: null,
  target: "Your project",
  at: TS,
  durationMs: 3100,
  tools: ["tsc", "biome", "ruff"],
  skipped: ["mypy"],
  notes: [{ tool: "mypy", reason: "mypy is not installed on this PC." }],
  counts: { error: 1, warning: 2, info: 0 },
  problems: [
    {
      file: "src/a.ts",
      line: 3,
      column: 7,
      severity: "error",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      tool: "tsc",
    },
    {
      file: "app/main.py",
      line: 1,
      column: 8,
      severity: "warning",
      code: "F401",
      message: "`os` imported but unused",
      tool: "ruff",
    },
    {
      file: "src/a.ts",
      line: 9,
      column: 1,
      severity: "warning",
      code: "lint/style/useConst",
      message: "This let declares a variable that is only assigned once.",
      tool: "biome",
    },
  ],
  truncated: false,
  runs: [],
  by: "user",
};
const crash: RuntimeProblem = {
  file: "app/main.py",
  line: 20,
  column: null,
  severity: "error",
  code: null,
  message: "ZeroDivisionError: division by zero",
  tool: "preview",
  source: "preview",
  at: TS,
  excerpt:
    'Traceback (most recent call last):\n  File "app/main.py", line 20, in total\nZeroDivisionError: division by zero',
  ref: "prv_1",
  count: 2,
};

test("Problems: Check now, groups by file with counts, opens a file, runtime and agent problems, filters", async () => {
  let latest: DiagnosticsResult | null = null;
  responses["diagnostics.latest"] = () => ({ result: latest });
  responses["diagnostics.runtime"] = () => ({ problems: [crash] });
  responses["diagnostics.run"] = () => {
    latest = checked;
    return { result: checked };
  };
  responses["files.read"] = () => ({
    path: "src/a.ts",
    text: "import x from 'x';\n\nconst n: number = 'two';\nexport { n };\n",
    binary: false,
    size: 60,
    truncated: false,
  });
  useEngine.setState({
    events: [
      {
        id: "ev_err",
        seq: 1,
        ts: TS,
        projectId: "prj_1",
        taskId: "tsk_1",
        agent: "backend@1.0.0",
        type: "error",
        text: "The model stopped answering.",
        details: null,
        status: "failed",
        durationMs: null,
        ephemeral: false,
      } as DepoEvent,
    ],
  });
  mount(<ProblemsPanel />);

  expect(await screen.findByText("Not checked yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check now" }));
  await waitFor(() => expect(paramsOf("diagnostics.run")).toEqual({ projectId: "prj_1" }));
  expect(await screen.findByText("Checked just now with tsc, biome and ruff")).toBeTruthy();

  // Grouped by file, the file with an error first, each with its counts.
  const byFile = screen.getByRole("list", { name: "Problems by file" });
  const headers = within(byFile)
    .getAllByRole("button", { expanded: true })
    .map((b) => b.textContent);
  expect(headers).toEqual(["src/a.ts1 error, 1 warning", "app/main.py1 warning"]);
  expect(screen.getByText("Not checked with mypy: mypy is not installed on this PC.")).toBeTruthy();

  // Severity is written, not only coloured, and a click opens the file at the line.
  const inA = screen.getByRole("list", { name: "Problems in src/a.ts" });
  expect(within(inA).getAllByText("Error")).toHaveLength(1);
  expect(within(inA).getAllByText("Warning")).toHaveLength(1);
  fireEvent.click(within(inA).getByText("Type 'string' is not assignable to type 'number'."));
  expect(useNav.getState().file).toMatchObject({ path: "src/a.ts", line: 3 });
  expect(useUi.getState().centerTab).toBe("files");

  // Runtime and agent problems.
  expect(await screen.findByText("ZeroDivisionError: division by zero")).toBeTruthy();
  expect(screen.getByText("App crash")).toBeTruthy();
  expect(screen.getByText("2 times")).toBeTruthy();
  expect(screen.getByText("The model stopped answering.")).toBeTruthy();

  // Fix one problem: the draft has the place, the message and the code around it.
  fireEvent.click(screen.getByRole("button", { name: "Fix with an agent: src/a.ts:3:7" }));
  const dialog = await screen.findByRole("dialog", { name: "Fix with an agent" });
  const box = within(dialog).getByRole("textbox", { name: "Request" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toContain("Fix this error that tsc found in src/a.ts:3:7"));
  expect(box.value).toContain("TS2322: Type 'string' is not assignable to type 'number'.");
  expect(box.value).toContain("> 3 | const n: number = 'two';");
  expect(paramsOf("files.read")).toEqual({ projectId: "prj_1", path: "src/a.ts" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Filters: errors off hides the tsc error and the agent error; runtime off hides the crash.
  const errors = screen.getByRole("button", { name: "Errors 2" });
  fireEvent.click(errors);
  expect(errors.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByText("Type 'string' is not assignable to type 'number'.")).toBeNull();
  expect(screen.queryByText("The model stopped answering.")).toBeNull();
  expect(screen.getByText("`os` imported but unused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runtime 1" }));
  expect(screen.queryByText("ZeroDivisionError: division by zero")).toBeNull();
});

test("Problems: a file group's fix lists its problems, and a clean check says so", async () => {
  responses["diagnostics.latest"] = () => ({ result: checked });
  responses["diagnostics.runtime"] = () => ({ problems: [] });
  mount(<ProblemsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Fix with an agent: all problems in src/a.ts" }));
  const dialog = await screen.findByRole("dialog", { name: "Fix with an agent" });
  const box = within(dialog).getByRole("textbox", { name: "Request" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toContain("Fix the problems that tsc and biome found in src/a.ts:"));
  expect(box.value).toContain("- line 3:7 error TS2322: Type 'string' is not assignable to type 'number'.");
  expect(box.value).toContain("- line 9:1 warning lint/style/useConst:");
  expect(
    screen.getByText("No crashes in running previews, and no console errors in page checks."),
  ).toBeTruthy();
  cleanup();

  responses["diagnostics.latest"] = () => ({
    result: { ...checked, problems: [], counts: { error: 0, warning: 0, info: 0 } },
  });
  mount(<ProblemsPanel />);
  expect(await screen.findByText("No problems found by tsc, biome and ruff.")).toBeTruthy();
});

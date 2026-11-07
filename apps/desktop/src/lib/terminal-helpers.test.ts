import type { Problem, TerminalLine, TerminalRun, TestRun } from "@depo/shared";
import { expect, test } from "vitest";
import { appendLines, MAX_TERMINAL_LINES, useTerminal } from "@/store/terminal";
import {
  codeExcerpt,
  draftForFile,
  draftForProblem,
  draftForRuntime,
  draftForTerminalRun,
  draftForTestRun,
  fixDestination,
  headExcerpt,
  MAX_EXCERPT_LINES,
  tailExcerpt,
} from "./fix-request";
import { countsLabel, groupByFile, listWords, position, severityShown, uniqueKeys } from "./problems";
import { historyStep, newestRun, pushHistory, runFailed, runStateText, shortDuration } from "./terminal";

const TS = "2026-11-07T10:00:00.000Z";
const run = (over: Partial<TerminalRun> = {}): TerminalRun => ({
  id: "job_1",
  projectId: "prj_1",
  taskId: null,
  target: "Your project",
  command: "npm run build",
  category: "build",
  state: "running",
  exitCode: null,
  startedAt: TS,
  endedAt: null,
  durationMs: null,
  lines: 0,
  ...over,
});
const line = (seq: number, text = `line ${seq}`): TerminalLine => ({ seq, stream: "out", text });

test("history: Up goes back, Down comes forward to the line being typed", () => {
  const h = ["c", "b", "a"];
  let s = historyStep(h, -1, "up", "dra");
  expect(s).toEqual({ index: 0, value: "c" });
  s = historyStep(h, s.index, "up", "dra");
  s = historyStep(h, s.index, "up", "dra");
  expect(s).toEqual({ index: 2, value: "a" });
  // The oldest stays put.
  expect(historyStep(h, 2, "up", "dra")).toEqual({ index: 2, value: "a" });
  expect(historyStep(h, 2, "down", "dra")).toEqual({ index: 1, value: "b" });
  expect(historyStep(h, 0, "down", "dra")).toEqual({ index: -1, value: "dra" });
  expect(historyStep([], -1, "up", "x")).toEqual({ index: -1, value: "x" });
  expect(pushHistory(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  expect(pushHistory(["a", "b"], "z", 2)).toEqual(["z", "a"]);
});

test("run state text and which runs can be sent to an agent", () => {
  expect(shortDuration(450)).toBe("0.5s");
  expect(shortDuration(83_000)).toBe("1m 23s");
  expect(runStateText(run({ state: "succeeded", exitCode: 0, durationMs: 1200 }))).toBe(
    "Exit code 0, took 1.2s",
  );
  expect(runStateText(run({ state: "failed", exitCode: 2, durationMs: 3000 }))).toBe(
    "Exit code 2, took 3.0s",
  );
  expect(runStateText(run({ state: "timed_out", durationMs: 600_000 }))).toBe(
    "Stopped at the time limit after 10m 0s",
  );
  expect(runStateText(run(), new Date(TS).getTime() + 4000)).toBe("Running for 4.0s");
  expect(runFailed(run({ state: "failed", exitCode: 1 }))).toBe(true);
  expect(runFailed(run({ state: "timed_out" }))).toBe(true);
  expect(runFailed(run({ state: "stopped" }))).toBe(false);
  expect(runFailed(run({ state: "succeeded" }))).toBe(false);
  // A finished listed copy beats a live copy that still says running (its last event was missed).
  const done = run({ state: "failed", exitCode: 1 });
  expect(newestRun(done, run())).toBe(done);
  const live = run({ state: "succeeded" });
  expect(newestRun(run(), live)).toBe(live);
});

test("terminal store: appends new lines, notes gaps, keeps the newest 2000, and merges a read", () => {
  const empty = { lines: [], lastSeq: 0, run: null, gap: false, dropped: false, clearedAt: 0, touched: 0 };
  let out = appendLines(empty, [line(1), line(2)]);
  expect(out.lastSeq).toBe(2);
  expect(out.gap).toBe(false);
  // Repeats are ignored.
  expect(appendLines(out, [line(2)])).toBe(out);
  out = appendLines(out, [line(5)]);
  expect(out.gap).toBe(true);

  const many = Array.from({ length: MAX_TERMINAL_LINES + 10 }, (_, i) => line(i + 1));
  const big = appendLines(empty, many);
  expect(big.lines).toHaveLength(MAX_TERMINAL_LINES);
  expect(big.lines[0]?.seq).toBe(11);
  expect(big.dropped).toBe(true);

  useTerminal.setState({ outputs: {}, selected: {}, target: {} });
  const t = useTerminal.getState();
  t.merge(run({ id: "job_2", state: "succeeded" }), [line(1)]);
  // A later read that still says running does not undo the finished state.
  t.merge(run({ id: "job_2" }), [line(1), line(2), line(3)]);
  const o = useTerminal.getState().outputs.job_2;
  expect(o?.run?.state).toBe("succeeded");
  expect(o?.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  useTerminal.getState().clear("job_2");
  expect(useTerminal.getState().outputs.job_2?.clearedAt).toBe(3);
});

const problem = (over: Partial<Problem> = {}): Problem => ({
  file: "src/a.ts",
  line: 3,
  column: 7,
  severity: "error",
  code: "TS2322",
  message: "Type 'string' is not assignable to type 'number'.",
  tool: "tsc",
  ...over,
});

test("excerpts are at most 40 lines, numbered around the line for code", () => {
  const text = Array.from({ length: 100 }, (_, i) => `out ${i + 1}`).join("\n");
  const tail = tailExcerpt(text).split("\n");
  expect(tail).toHaveLength(MAX_EXCERPT_LINES);
  expect(tail.at(-1)).toBe("out 100");
  expect(headExcerpt(text).split("\n")[0]).toBe("out 1");
  expect(tailExcerpt(`${"x".repeat(400)}\n`)).toHaveLength(301);

  const file = Array.from({ length: 30 }, (_, i) => `code ${i + 1}`).join("\n");
  const code = codeExcerpt(file, 10).split("\n");
  expect(code[0]).toBe("   4 | code 4");
  expect(code).toContain("> 10 | code 10");
  expect(code.at(-1)).toBe("  16 | code 16");
  expect(codeExcerpt(file, 1, 100).split("\n")).toHaveLength(30);
});

test("drafts say what failed, where, and how to check, with fenced excerpts", () => {
  const where = { taskId: null, target: "Your project" };
  const one = draftForProblem(problem(), where, "> 3 | const n: number = `x`;");
  expect(one).toContain("Fix this error that tsc found in src/a.ts:3:7:\nTS2322: Type");
  expect(one).toContain("Code around line 3:\n```\n> 3 | const n: number = `x`;\n```");
  expect(one).toContain("Where: my project folder.");
  expect(one).toContain("run diagnostics");
  // A fence inside the excerpt does not close the draft's fence.
  expect(draftForProblem(problem(), where, "```js\nx\n```")).toContain("````\n```js");

  const noFile = draftForProblem(problem({ file: null, line: null, column: null, severity: "warning" }), {
    taskId: "tsk_1",
    target: "add login",
  });
  expect(noFile).toContain("Fix this warning that tsc found:");
  expect(noFile).toContain(
    'Where: the private copy of the task "add login" (its changes are not applied yet).',
  );

  const many = Array.from({ length: 45 }, (_, i) => problem({ line: i + 1 }));
  const file = draftForFile("src/a.ts", many, where);
  expect(file.split("\n").filter((l) => l.startsWith("- line"))).toHaveLength(40);
  expect(file).toContain("- and 5 more");

  const rt = draftForRuntime(
    {
      ...problem({ tool: "preview", code: null, line: 20, column: null, file: "app/main.py" }),
      message: "ZeroDivisionError: division by zero",
      source: "preview",
      at: TS,
      excerpt: "Traceback (most recent call last):\nZeroDivisionError: division by zero",
      ref: "prv_1",
      count: 3,
    },
    where,
  );
  expect(rt).toContain("The running app reported this error (3 times):\nZeroDivisionError: division by zero");
  expect(rt).toContain("At app/main.py:20.");
  expect(rt).toContain("From the log:\n```\nTraceback");

  const failing = run({ state: "failed", exitCode: 1, command: "npm run build" });
  const term = draftForTerminalRun(failing, "a\nb\nerror TS1005: ';' expected.");
  expect(term).toContain("This command failed with exit code 1:\n`npm run build`");
  expect(term).toContain("Output (last 3 lines):");
  expect(draftForTerminalRun(run({ state: "timed_out" }), "")).toContain(
    "did not finish within the time limit",
  );

  const testRun: TestRun = {
    id: "ev_1",
    source: "terminal",
    projectId: "prj_1",
    taskId: null,
    target: "Your project",
    by: "user",
    command: "go test ./...",
    at: TS,
    durationMs: 100,
    ok: false,
    exitCode: 1,
    passed: null,
    failed: null,
    summary: "",
    format: null,
    failures: [],
    outputTail: "FAIL\texample.com/demo\t0.01s",
  };
  const tests = draftForTestRun(testRun);
  expect(tests).toContain("Tests failed when I ran `go test ./...`.");
  expect(tests).toContain("End of the output:\n```\nFAIL\texample.com/demo\t0.01s\n```");
});

test("a fix continues a task in review or done, and starts a new task otherwise", () => {
  const tasks = [
    { id: "t1", status: "review" as const, title: "a" },
    { id: "t2", status: "done" as const, title: "b" },
    { id: "t3", status: "running" as const, title: "c" },
  ];
  expect(fixDestination("t1", tasks)?.id).toBe("t1");
  expect(fixDestination("t2", tasks)?.id).toBe("t2");
  expect(fixDestination("t3", tasks)).toBeNull();
  expect(fixDestination("gone", tasks)).toBeNull();
  expect(fixDestination(null, tasks)).toBeNull();
});

test("problems: grouped by file worst first, counts and filters", () => {
  const groups = groupByFile([
    problem({ file: "b.py", severity: "warning", tool: "ruff" }),
    problem({ file: "a.ts", line: 9, severity: "warning" }),
    problem({ file: "a.ts", line: 2 }),
    problem({ file: null, severity: "info", tool: "cargo check" }),
    problem({ file: "c.ts" }),
  ]);
  expect(groups.map((g) => g.file)).toEqual(["a.ts", "c.ts", "b.py", null]);
  expect(groups[0]?.problems.map((p) => p.line)).toEqual([2, 9]);
  expect(countsLabel(groups[0]?.counts ?? { error: 0, warning: 0, info: 0 })).toBe("1 error, 1 warning");
  expect(countsLabel({ error: 0, warning: 0, info: 2 })).toBe("2 notes");
  expect(countsLabel({ error: 0, warning: 0, info: 0 })).toBe("No problems");
  const f = { errors: false, warnings: true, runtime: true };
  expect(severityShown("error", f)).toBe(false);
  expect(severityShown("info", f)).toBe(true);
  expect(listWords(["tsc"])).toBe("tsc");
  expect(listWords(["tsc", "ruff", "go vet"])).toBe("tsc, ruff and go vet");
  expect(position({ line: 3, column: null })).toBe("3");
  expect(position({ line: null, column: null })).toBe("");
  expect(uniqueKeys(["a", "b", "a"], (x) => x).map(([k]) => k)).toEqual(["a", "b", "a#1"]);
});

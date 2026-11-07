import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type DepoEvent, type TerminalLine, TerminalOutputDetailsSchema } from "@depo/shared";
import { createEngine, type Engine } from "../src/engine";
import { ansiTone, LineRing, linesFromText, wordTone } from "../src/terminal/ring";
import { shellArgv } from "../src/tools/shell/run";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

/** An engine with one project in a folder whose path has a space. */
async function setup(label = "depo terminal") {
  const t = tempDir(label);
  cleanup = t.cleanup;
  const proj = path.join(t.dir, "my app");
  fs.mkdirSync(proj);
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  const project = await engine.projects.open(proj);
  return { e: engine, projectId: project.id, proj, dataRoot: path.join(t.dir, "data"), dir: t.dir };
}

const BUN = `"${process.execPath}"`;

describe("command line and output buffer", () => {
  test("Windows runs cmd.exe with the command quoted once, so quoted paths with spaces survive", () => {
    expect(shellArgv("npm test", true)).toEqual(["cmd.exe", "/d", "/s", "/c", '"npm test"']);
    expect(shellArgv('"C:\\My Tools\\x.exe" --flag "a b"', true)).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      '""C:\\My Tools\\x.exe" --flag "a b""',
    ]);
    expect(shellArgv("echo hi && ls", false)).toEqual(["/bin/sh", "-c", "echo hi && ls"]);
  });

  test("colour codes become tones, progress redraws keep the last state, secrets are redacted", () => {
    expect(ansiTone("\x1b[31mFAIL\x1b[0m")).toBe("danger");
    expect(ansiTone("\x1b[32m✓\x1b[0m \x1b[33mslow\x1b[0m")).toBe("warning");
    expect(ansiTone("\x1b[38;5;196mred-ish\x1b[0m")).toBeUndefined();
    expect(ansiTone("\x1b[1;92mok\x1b[0m")).toBe("success");
    expect(wordTone("error: something broke")).toBe("danger");
    expect(wordTone("WARNING: deprecated")).toBe("warning");
    expect(wordTone("(pass) adds")).toBe("success");
    expect(wordTone("plain text")).toBeUndefined();

    const r = new LineRing();
    r.push("out", "\x1b[31mError: boom\x1b[0m\nhalf");
    r.push("out", " a line\r\n");
    r.push("err", "10%\r50%\r100%\n");
    r.push("out", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    r.push("out", "no newline at the end");
    r.flush();
    const lines = r.since(0).lines;
    expect(lines.map((l) => l.text)).toEqual([
      "Error: boom",
      "half a line",
      "100%",
      expect.not.stringContaining("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      "no newline at the end",
    ]);
    expect(lines[0]?.tone).toBe("danger");
    expect(lines[2]?.stream).toBe("err");
    expect(r.takeNew()).toHaveLength(5);
    expect(r.takeNew()).toHaveLength(0);
  });

  test("the ring keeps the newest 2000 lines and says when older ones were dropped", () => {
    const r = new LineRing();
    r.push("out", `${Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    const all = r.since(0);
    expect(all.lines).toHaveLength(2000);
    expect(all.lines[0]?.text).toBe("line 501");
    expect(all.dropped).toBe(true);
    expect(all.next).toBe(2500);
    const after = r.since(2400);
    expect(after.lines.map((l) => l.text)[0]).toBe("line 2401");
    expect(after.dropped).toBe(false);
    // Kept text and lines read back from it (after an engine restart).
    const text = r.tailText(200);
    const back = linesFromText(text, 2500);
    expect(back.at(-1)).toEqual({ seq: 2500, stream: "out", text: "line 2500" });
  });
});

describe("Terminal service", () => {
  test("a command the policy denies is refused with the reason; a project deny rule too", async () => {
    const { e, projectId } = await setup();
    await expect(e.terminal.run({ projectId, command: "format c:" })).rejects.toThrow(
      "This command is not allowed: formats a drive.",
    );
    e.registry.setSettings(projectId, { commandDeny: ["echo"] });
    await expect(e.terminal.run({ projectId, command: "echo hi" })).rejects.toThrow(
      "blocked by this project's command rules",
    );
    expect(e.terminal.list(projectId)).toHaveLength(0);
    expect(e.terminal.history(projectId)).toEqual([]);
  });

  test("an 'ask' command runs without an approval because the owner typed it, and output streams", async () => {
    const { e, projectId } = await setup();
    const events: DepoEvent[] = [];
    e.bus.subscribe((ev) => {
      if (ev.type === "terminal_output" || ev.type === "running_command") events.push(ev);
    });
    const run = await e.terminal.run({
      projectId,
      command: `${BUN} -e "console.log('asked'); console.error('to stderr')"`,
    });
    expect(run.state).toBe("running");
    expect(run.category).toBe("other");
    const done = await e.terminal.settled(run.id);
    expect(done?.state).toBe("succeeded");
    expect(done?.exitCode).toBe(0);
    expect(e.approvals.list()).toHaveLength(0);
    const outputs = events.filter((x) => x.type === "terminal_output");
    expect(outputs.every((x) => x.ephemeral && x.taskId === null)).toBe(true);
    const lines = outputs.flatMap((x) => TerminalOutputDetailsSchema.parse(x.details).lines);
    expect(lines.map((l) => l.text)).toEqual(expect.arrayContaining(["asked", "to stderr"]));
    expect(lines.find((l) => l.text === "to stderr")?.stream).toBe("err");
    const last = TerminalOutputDetailsSchema.parse(outputs.at(-1)?.details);
    expect(last.run?.state).toBe("succeeded");
    // One lasting line in the activity feed, kept out of any task's chat.
    const finished = events.find((x) => x.type === "running_command");
    expect(finished?.ephemeral).toBe(false);
    expect(finished?.agent).toBe("user");
    expect(finished?.details?.source).toBe("terminal");
  });

  test("output can be read again after the run, and after an engine restart", async () => {
    const { e, projectId, dataRoot } = await setup();
    const run = await e.terminal.run({ projectId, command: "echo one && echo two && echo three" });
    await e.terminal.settled(run.id);
    const all = e.terminal.read(run.id);
    expect(all.lines.map((l: TerminalLine) => l.text)).toEqual(["one", "two", "three"]);
    expect(all.run.state).toBe("succeeded");
    expect(e.terminal.read(run.id, 2).lines.map((l) => l.text)).toEqual(["three"]);
    await e.stop("restart");
    engine = createEngine({ dataRoot, token: TEST_TOKEN, heartbeatMs: 60_000 });
    const again = engine.terminal.read(run.id);
    expect(again.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(again.run.exitCode).toBe(0);
    expect(engine.terminal.list(projectId)[0]?.id).toBe(run.id);
    expect(() => engine?.terminal.read("job_missing")).toThrow("That run no longer exists.");
  });

  test("Stop kills the whole command; a time limit stops it too; a failure keeps its exit code", async () => {
    const { e, projectId } = await setup();
    const long = await e.terminal.run({ projectId, command: `${BUN} -e "await Bun.sleep(30000)"` });
    const t0 = Date.now();
    expect(await e.terminal.kill(long.id)).toBe(true);
    const stopped = await e.terminal.settled(long.id);
    expect(stopped?.state).toBe("stopped");
    expect(stopped?.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(e.terminal.read(long.id).lines.at(-1)).toMatchObject({ stream: "depo", text: "Stopped." });
    expect(await e.terminal.kill(long.id)).toBe(false);

    const slow = await e.terminal.run({
      projectId,
      command: `${BUN} -e "await Bun.sleep(30000)"`,
      timeoutMs: 400,
    });
    const timed = await e.terminal.settled(slow.id);
    expect(timed?.state).toBe("timed_out");
    expect(e.terminal.read(slow.id).lines.at(-1)?.text).toContain("time limit");

    const fail = await e.terminal.run({ projectId, command: `${BUN} -e "process.exit(3)"` });
    const failed = await e.terminal.settled(fail.id);
    expect(failed).toMatchObject({ state: "failed", exitCode: 3 });
    expect(failed?.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("history: newest first, no repeats; runs in a task copy need the copy", async () => {
    const { e, projectId } = await setup();
    for (const c of ["echo a", "echo b", "echo a"])
      await e.terminal.settled((await e.terminal.run({ projectId, command: c })).id);
    expect(e.terminal.history(projectId)).toEqual(["echo a", "echo b"]);
    expect(e.terminal.list(projectId).map((r) => r.command)).toEqual(["echo a", "echo b", "echo a"]);
    await expect(e.terminal.run({ projectId, taskId: "tsk_nope", command: "echo x" })).rejects.toThrow(
      "another project",
    );
  });

  test("Test results: Terminal test runs and agents' runs, with failures read from the output", async () => {
    const { e, projectId, proj } = await setup();
    fs.writeFileSync(
      path.join(proj, "math.test.ts"),
      'import { expect, test } from "bun:test";\ntest("adds", () => { expect(1 + 1).toBe(3); });\ntest("ok", () => {});\n',
    );
    const run = await e.terminal.run({ projectId, command: "bun test" });
    expect(run.category).toBe("test");
    await e.terminal.settled(run.id);
    e.bus.emit({
      projectId,
      taskId: null,
      agent: "testing@1.0.0",
      type: "test_result",
      text: "Tests: 1 failed, 1 passed",
      details: {
        command: "python -m pytest -q",
        exitCode: 1,
        passed: 1,
        failed: 1,
        outputTail:
          "=================================== FAILURES ===================================\n___ test_add ___\n\n>       assert add(2, 2) == 4\nE       assert 0 == 4\n\ntests/test_calc.py:4: AssertionError\n=========================== short test summary info ============================\nFAILED tests/test_calc.py::test_add - assert 0 == 4\n1 failed, 1 passed in 0.02s\n",
      },
      status: "failed",
    });
    const runs = e.terminal.tests(projectId, null);
    expect(runs).toHaveLength(2);
    const agent = runs.find((r) => r.source === "agent");
    expect(agent).toMatchObject({
      format: "pytest",
      passed: 1,
      failed: 1,
      ok: false,
      by: "testing@1.0.0",
      target: "Your project",
    });
    expect(agent?.failures[0]).toMatchObject({
      name: "tests/test_calc.py::test_add",
      file: "tests/test_calc.py",
      line: 4,
    });
    const mine = runs.find((r) => r.source === "terminal");
    expect(mine).toMatchObject({ format: "bun", ok: false, by: "user", command: "bun test" });
    expect(mine?.failures[0]).toMatchObject({ name: "adds", file: "math.test.ts", line: 2 });
    expect(e.terminal.tests(projectId, "tsk_other")).toHaveLength(0);
  }, 30_000);
});

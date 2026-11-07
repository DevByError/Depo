import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger, getLogger, type LogRecord, setDefaultLogger, withLogContext } from "../src/logger";
import { tempDir } from "./helpers";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function readLines(file: string): LogRecord[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogRecord);
}

test("writes JSON lines with redaction and rotates by size", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, maxBytes: 300, maxFiles: 2 });
  log.info("hello", { token: "secret-value", n: 1 });
  log.flush();
  const first = readLines(log.file)[0];
  expect(first).toMatchObject({
    level: "info",
    component: "engine",
    msg: "hello",
    n: 1,
    token: "«redacted»",
  });

  for (let i = 0; i < 40; i++) log.info("filler line to force rotation", { i });
  log.flush();
  expect(existsSync(path.join(t.dir, "engine.1.log"))).toBe(true);
  expect(existsSync(path.join(t.dir, "engine.2.log"))).toBe(true);
  expect(existsSync(path.join(t.dir, "engine.3.log"))).toBe(false);
  // Every file stays near the limit: a batch is split across files, not written in one piece.
  for (const f of ["engine.log", "engine.1.log", "engine.2.log"]) {
    expect(readFileSync(path.join(t.dir, f)).length).toBeLessThanOrEqual(300);
  }
  // The newest line is in engine.log, and the lines in it are in order.
  const current = readLines(log.file);
  expect(current.at(-1)?.i).toBe(39);
});

test("respects the level and changes it at run time", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "warn" });
  log.info("skip");
  log.warn("keep");
  expect(log.enabled("info")).toBe(false);
  log.setLevel("debug");
  expect(log.level).toBe("debug");
  expect(log.enabled("debug")).toBe(true);
  log.debug("now kept");
  log.setLevel("error");
  log.warn("skipped again");
  log.flush();
  expect(readLines(log.file).map((r) => r.msg)).toEqual(["keep", "now kept"]);
});

test("child loggers and the log context add component, task, project and agent", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const root = createLogger({ dir: t.dir, level: "debug" });
  const tools = root.child({ component: "tools" });
  const scoped = tools.child({ taskId: "tsk_1" });
  scoped.info("tool call", { tool: "read_file", durationMs: 12 });
  await withLogContext({ projectId: "prj_1", taskId: "tsk_2", agent: "backend@1.0.0" }, async () => {
    await Bun.sleep(1);
    // Code that knows nothing about the task still logs with it.
    root.child({ component: "models" }).info("model call");
    await withLogContext({ agent: "testing@1.0.0" }, async () => {
      root.info("nested");
    });
    // Explicit fields win over the context.
    root.info("explicit", { taskId: "tsk_3" });
  });
  root.info("outside");
  root.flush();
  const [a, b, c, d, e] = readLines(root.file);
  expect(a).toMatchObject({ component: "tools", taskId: "tsk_1", tool: "read_file", durationMs: 12 });
  expect(b).toMatchObject({
    component: "models",
    projectId: "prj_1",
    taskId: "tsk_2",
    agent: "backend@1.0.0",
  });
  expect(c).toMatchObject({ component: "engine", taskId: "tsk_2", agent: "testing@1.0.0" });
  expect(d?.taskId).toBe("tsk_3");
  expect(e?.taskId).toBeUndefined();
  // Fixed fields come first so the file reads well, and fields cannot overwrite them.
  expect(Object.keys(a ?? {}).slice(0, 4)).toEqual(["ts", "level", "component", "msg"]);
  root.info("real message", { msg: "fake", level: "error" });
  root.flush();
  expect(readLines(root.file).at(-1)).toMatchObject({ msg: "real message", level: "info" });
});

test("errors keep their message and stack, and secrets never reach the file", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir });
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const err = Object.assign(new Error(`push failed with ${secret}`), { kind: "http", status: 401 });
  log.error("git push failed", { err, password: "hunter2" });
  log.warn(`calling with Authorization: Bearer abcdefghijklmnop1234`, {
    command: "API_KEY=sk-live-0123456789abcdef npm start",
    env: { GITHUB_TOKEN: "abc123", PATH: "C:\\Windows" },
    nested: { deeper: { apiKey: "xyz" } },
  });
  // Errors are written straight away, without a flush.
  const raw = readFileSync(log.file, "utf8");
  expect(raw).toContain("git push failed");
  log.flush();
  const text = readFileSync(log.file, "utf8");
  for (const s of [secret, "hunter2", "abcdefghijklmnop1234", "sk-live-0123456789abcdef", "abc123", "xyz"]) {
    expect(text).not.toContain(s);
  }
  const [e, w] = readLines(log.file);
  expect(e?.err?.message).toContain("push failed");
  expect(e?.err?.stack).toContain("Error");
  expect(e?.err).toMatchObject({ name: "Error", kind: "http", status: 401 });
  expect(w?.env).toMatchObject({ PATH: "C:\\Windows", GITHUB_TOKEN: "«redacted»" });
});

test("lines are batched and written by a timer; nothing is lost", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, flushMs: 20 });
  for (let i = 0; i < 100; i++) log.info("burst", { i });
  expect(existsSync(log.file)).toBe(false);
  await Bun.sleep(80);
  expect(readLines(log.file)).toHaveLength(100);
});

test("the live tail returns lines after a cursor and notices a stale cursor", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, ringSize: 10, flushMs: 0 });
  expect(log.tail(0)).toEqual({ entries: [], cursor: 0, reset: false });
  log.info("one");
  log.info("two");
  const a = log.tail(0);
  expect(a.entries.map((e) => e.record.msg)).toEqual(["one", "two"]);
  expect(a.cursor).toBe(2);
  log.warn("three");
  const b = log.tail(a.cursor);
  expect(b.entries.map((e) => e.record.msg)).toEqual(["three"]);
  expect(b.reset).toBe(false);
  // A cursor from a previous engine run is ahead of this run's numbers.
  expect(log.tail(999).reset).toBe(true);
  // A cursor whose lines fell out of the ring.
  for (let i = 0; i < 30; i++) log.debug("dropped below level");
  for (let i = 0; i < 30; i++) log.info("filler");
  expect(log.tail(b.cursor).reset).toBe(true);
  expect(log.components()).toEqual(["engine"]);
});

test("getLogger writes through the engine's default logger, looked up on each call", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const lazy = getLogger({ component: "agent" });
  lazy.info("dropped: no engine yet");
  const root = createLogger({ dir: t.dir, flushMs: 0 });
  setDefaultLogger(root);
  try {
    lazy.child({ taskId: "tsk_9" }).info("kept");
  } finally {
    setDefaultLogger(null);
  }
  expect(readLines(root.file)).toEqual([
    expect.objectContaining({ component: "agent", taskId: "tsk_9", msg: "kept" }),
  ]);
});

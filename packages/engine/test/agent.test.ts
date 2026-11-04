import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@depo/model-gateway";
import type { DepoEvent } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { compressHistory } from "../src/agent/tasks";
import { parseTextToolCalls, stripToolMarkup } from "../src/agent/textcalls";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

const FIXTURE = path.resolve(import.meta.dir, "../../../scripts/fixtures/fastapi-demo");
const hasPytest =
  Bun.spawnSync(["python3", "-c", "import fastapi, httpx, pytest"]).exitCode === 0 ||
  Bun.spawnSync(["python", "-c", "import fastapi, httpx, pytest"]).exitCode === 0;

let engine: Engine | null = null;
let stopFake = () => {};
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  cleanup();
  cleanup = () => {};
});

async function setup() {
  const t = tempDir("depo agent");
  cleanup = t.cleanup;
  const fake = startFakeOllama();
  stopFake = fake.stop;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
  });
  engine = e;
  await e.start();
  e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
  e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
  const proj = path.join(t.dir, "fastapi demo");
  fs.cpSync(FIXTURE, proj, { recursive: true });
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, proj, project, events };
}

describe("coding agent", () => {
  test.if(hasPytest)(
    'acceptance: "add a /health endpoint to this FastAPI project" → shadow edit, tests, diff, apply, undo',
    async () => {
      const { e, proj, project, events } = await setup();
      const originalMain = fs.readFileSync(path.join(proj, "app", "main.py"), "utf8");

      const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
      await e.tasks.settled(task.id);
      const { task: done, messages } = e.tasks.get(task.id);
      expect(done.error).toBeNull();
      expect(done.status).toBe("review");
      expect(done.summary).toContain("2 passed");

      // The real project is untouched until the user applies.
      expect(fs.readFileSync(path.join(proj, "app", "main.py"), "utf8")).toBe(originalMain);

      // Live activity: reading, editing, testing, a green test result and a handoff.
      const types = events.filter((ev) => ev.taskId === task.id && !ev.ephemeral).map((ev) => ev.type);
      for (const t of ["planning", "reading_file", "editing_file", "testing", "test_result", "handoff"])
        expect(types).toContain(t);
      const result = events.find((ev) => ev.type === "test_result");
      expect(result?.status).toBe("succeeded");
      expect(result?.details?.passed).toBe(2);
      expect(messages.map((m) => m.role)).toContain("tool");
      expect(messages.at(-1)?.text).toContain("/health");

      // Diff review: two modified files, then apply.
      const [cs] = e.projects.listChangeSets(project.id);
      expect(cs?.files.map((f) => [f.path, f.kind])).toEqual([
        ["app/main.py", "modified"],
        ["tests/test_main.py", "modified"],
      ]);
      const applied = e.projects.applyChangeSet(cs?.id ?? "", e.projects.workspaceFor(cs?.id ?? ""));
      expect(applied.applied).toHaveLength(2);
      expect(fs.readFileSync(path.join(proj, "app", "main.py"), "utf8")).toContain('@app.get("/health")');

      // The applied project passes its own tests.
      const py = Bun.spawnSync([hasPythonCmd(), "-m", "pytest", "-q"], { cwd: proj });
      expect(py.stdout.toString()).toContain("2 passed");

      // Undo puts everything back.
      const undo = e.projects.restoreCheckpoint(applied.checkpointId ?? "");
      expect(undo.restored).toHaveLength(2);
      expect(fs.readFileSync(path.join(proj, "app", "main.py"), "utf8")).toBe(originalMain);
    },
    60_000,
  );

  test("without a coding model the task fails with an actionable message", async () => {
    const { e, project } = await setup();
    e.models.assign("coder", null);
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: "http://127.0.0.1:9", enabled: false }]);
    const task = e.tasks.send(project.id, "add a /health endpoint");
    await e.tasks.settled(task.id);
    const got = e.tasks.get(task.id);
    expect(got.task.status).toBe("failed");
    expect(got.task.error).toContain("Models tab");
  });

  test("an unreachable model is retried, then reported", async () => {
    const { e, project, events } = await setup();
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: "http://127.0.0.1:9", enabled: true }]);
    const task = e.tasks.send(project.id, "add a /health endpoint");
    await e.tasks.settled(task.id);
    expect(events.filter((ev) => ev.type === "retrying")).toHaveLength(4);
    expect(e.tasks.get(task.id).task.error).toContain("not running");
  });

  test("a malformed tool call is retried, then the model is asked to try again", async () => {
    const { e, project, events } = await setup();
    const task = e.tasks.send(project.id, "simulate a broken tool call");
    await e.tasks.settled(task.id);
    const got = e.tasks.get(task.id);
    expect(got.task.error).toBeNull();
    expect(got.task.status).toBe("done");
    expect(got.messages.at(-1)?.text).toBe("Recovered after a broken tool call.");
    const retry = events.find((ev) => ev.type === "retrying");
    expect(retry?.text).toContain("could not read");
  });

  test("a follow-up message continues the same task and workspace", async () => {
    const { e, project } = await setup();
    const t1 = e.tasks.send(project.id, "say hello");
    await e.tasks.settled(t1.id);
    expect(e.tasks.get(t1.id).task.status).toBe("done");
    const t2 = e.tasks.send(project.id, "and again", t1.id);
    expect(t2.id).toBe(t1.id);
    await e.tasks.settled(t1.id);
    const msgs = e.tasks.get(t1.id).messages;
    expect(msgs.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["say hello", "and again"]);
    expect(e.tasks.list(project.id)).toHaveLength(1);
  });

  test("cancel stops a running task", async () => {
    const { e, project } = await setup();
    const task = e.tasks.send(project.id, "add a /health endpoint to this FastAPI project");
    expect(e.tasks.cancel(task.id)).toBe(true);
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("cancelled");
    expect(e.tasks.cancel(task.id)).toBe(false);
  });
});

function hasPythonCmd(): string {
  return Bun.spawnSync(["python3", "--version"]).exitCode === 0 ? "python3" : "python";
}

describe("agent helpers", () => {
  test("tool calls written as text are recovered", () => {
    const names = ["read_file", "run_command"];
    expect(
      parseTextToolCalls(
        '<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>',
        names,
      ),
    ).toEqual([
      { id: "text_1", name: "read_file", arguments: { path: "a.py" }, rawArguments: '{"path":"a.py"}' },
    ]);
    expect(
      parseTextToolCalls('```json\n{"tool": "run_command", "args": {"command": "pytest"}}\n```', names)[0]
        ?.name,
    ).toBe("run_command");
    expect(parseTextToolCalls('{"name": "format_disk", "arguments": {}}', names)).toEqual([]);
    expect(parseTextToolCalls("All done, tests pass.", names)).toEqual([]);
  });

  test("history compression trims old tool output first, keeps the request", () => {
    const big = "x".repeat(5000);
    const h: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 10; i++) {
      h.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: {}, rawArguments: "{}" }],
      });
      h.push({ role: "tool", toolCallId: `c${i}`, name: "read_file", content: big });
    }
    compressHistory(h, 8192);
    expect(h[1]?.content).toBe("task");
    expect(h.reduce((n, m) => n + m.content.length, 0)).toBeLessThan(8192 * 0.7 * 3.5);
    expect(h.at(-1)?.content).toBe(big);
  });
});

test("stray tool-call tags are removed from a final answer", () => {
  expect(stripToolMarkup("All 2 tests pass.<tool_call>\n")).toBe("All 2 tests pass.");
  expect(stripToolMarkup("Done.</tool_call>")).toBe("Done.");
  expect(stripToolMarkup("Use <tool_call> tags like this.")).toBe("Use <tool_call> tags like this.");
});

describe("text tool calls from small models", () => {
  test("bare JSON with raw newlines in strings and prose around it", async () => {
    const { extractTextToolCalls } = await import("../src/agent/textcalls");
    const text =
      'I will write the test now.\n{"name": "write_file", "arguments": {"path": "tests/t.py", "content": "def test_a():\n    assert 1\n"}}';
    const { calls, rest } = extractTextToolCalls(text, ["write_file"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({ path: "tests/t.py", content: "def test_a():\n    assert 1\n" });
    expect(rest).toBe("I will write the test now.");
    expect(extractTextToolCalls('{"name": "nope", "arguments": {}}', ["write_file"]).calls).toHaveLength(0);
  });
});

describe("more small-model slips", () => {
  test("a fenced call missing its last brace is still read", async () => {
    const { extractTextToolCalls, looksLikeToolCall } = await import("../src/agent/textcalls");
    const text =
      '```json\n{"name": "edit_file", "arguments": {"path": "app/main.py", "edits": [{"search": "a", "replace": "b"}]}\n```';
    const { calls } = extractTextToolCalls(text, ["edit_file"]);
    expect(calls[0]?.arguments).toEqual({ path: "app/main.py", edits: [{ search: "a", replace: "b" }] });
    expect(looksLikeToolCall('{"name": "edit_file", "arguments": {"path": ', ["edit_file"])).toBe(true);
    expect(looksLikeToolCall("Added the endpoint.", ["edit_file"])).toBe(false);
  });

  test("line numbers copied into search text are removed", async () => {
    const { stripLineNumbers } = await import("../src/tools/index");
    expect(stripLineNumbers("  7: def read_root():")).toBe("def read_root():");
    expect(stripLineNumbers("7│ def a():\n8│     return 1")).toBe("def a():\n    return 1");
    expect(stripLineNumbers("  7: def read_root() -> str:", "  7: def read_root():")).toBe(
      "def read_root() -> str:",
    );
    expect(stripLineNumbers("x = 1\n2: y")).toBe("x = 1\n2: y");
  });
});

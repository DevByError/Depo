import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiSchema, type DepoEvent, type RpcResponse, TerminalOutputDetailsSchema } from "@depo/shared";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

/**
 * The Terminal, Test results and Problems methods over the real WebSocket: every answer must match
 * the schema the UI relies on, and the live output must arrive as `terminal_output` events.
 */

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

function connect(port: number) {
  return new Promise<{
    ws: WebSocket;
    events: DepoEvent[];
    call(method: string, params?: unknown): Promise<RpcResponse>;
  }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
    let n = 1;
    const pending = new Map<number, (r: RpcResponse) => void>();
    const events: DepoEvent[] = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
      else if (msg.method === "event") events.push(msg.params as DepoEvent);
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () =>
      resolve({
        ws,
        events,
        call: (method, params) =>
          new Promise((res) => {
            const id = n++;
            pending.set(id, res);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
      });
  });
}

test("terminal, tests and diagnostics methods answer with what their schemas promise", async () => {
  const t = tempDir("depo terminal api");
  cleanup = t.cleanup;
  const proj = path.join(t.dir, "demo app");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "README.md"), "# demo\n");
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  const { port } = await engine.start();
  const c = await connect(port);
  const ok = async <T = Record<string, unknown>>(method: keyof typeof ApiSchema, params: unknown = {}) => {
    const res = await c.call(method, params);
    if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
    const parsed = ApiSchema[method].result.safeParse(res.result);
    if (!parsed.success)
      throw new Error(`${method} broke its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return parsed.data as T;
  };
  const fails = async (method: keyof typeof ApiSchema, params: unknown, text: string) => {
    const res = await c.call(method, params);
    expect("error" in res && res.error.message).toContain(text);
  };

  const project = await ok<{ id: string }>("projects.open", { path: proj });
  const projectId = project.id;

  // Terminal: run, stream, read back, list, history.
  const { run } = await ok<{ run: { id: string; state: string } }>("terminal.run", {
    projectId,
    command: "echo hello from depo",
  });
  expect(run.state).toBe("running");
  const final = await waitFor(
    () =>
      c.events.find(
        (e) =>
          e.type === "terminal_output" &&
          TerminalOutputDetailsSchema.parse(e.details).run?.state === "succeeded",
      ),
    10_000,
  );
  expect(final.ephemeral).toBe(true);
  const streamed = c.events
    .filter((e) => e.type === "terminal_output")
    .flatMap((e) => TerminalOutputDetailsSchema.parse(e.details).lines.map((l) => l.text));
  expect(streamed).toContain("hello from depo");
  const read = await ok<{ lines: { text: string }[]; run: { exitCode: number } }>("terminal.read", {
    runId: run.id,
  });
  expect(read.lines.map((l) => l.text)).toEqual(["hello from depo"]);
  expect(read.run.exitCode).toBe(0);
  const list = await ok<{ runs: { id: string; durationMs: number }[] }>("terminal.list", { projectId });
  expect(list.runs[0]?.id).toBe(run.id);
  expect(list.runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
  expect((await ok<{ commands: string[] }>("terminal.history", { projectId })).commands).toEqual([
    "echo hello from depo",
  ]);
  expect((await ok<{ killed: boolean }>("terminal.kill", { runId: run.id })).killed).toBe(false);
  await fails(
    "terminal.run",
    { projectId, command: "shutdown /s" },
    "This command is not allowed: shuts down the computer.",
  );
  await fails("terminal.run", { projectId, command: "" }, "");
  await fails("terminal.read", { runId: "job_nope" }, "That run no longer exists.");

  // Test results (none yet) and diagnostics (nothing to check in a README-only project).
  expect((await ok<{ runs: unknown[] }>("tests.runs", { projectId })).runs).toEqual([]);
  expect((await ok<{ result: unknown }>("diagnostics.latest", { projectId })).result).toBeNull();
  const diag = await ok<{ result: { tools: string[]; counts: Record<string, number> } }>("diagnostics.run", {
    projectId,
  });
  expect(diag.result.tools).toEqual([]);
  expect(diag.result.counts).toEqual({ error: 0, warning: 0, info: 0 });
  expect((await ok<{ result: unknown }>("diagnostics.latest", { projectId })).result).not.toBeNull();
  expect((await ok<{ problems: unknown[] }>("diagnostics.runtime", { projectId })).problems).toEqual([]);
  await fails("diagnostics.run", { projectId, taskId: "tsk_nope" }, "another project");
  c.ws.close();
});

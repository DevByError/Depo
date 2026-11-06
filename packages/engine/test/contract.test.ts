import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiSchema, type RpcResponse } from "@depo/shared";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * Contract test: call the methods added in Phases 3 to 9 over the real WebSocket and check that what
 * the engine returns satisfies the result schema the UI relies on. The server does not validate its
 * own answers, so a mismatch would otherwise only show up as a broken screen.
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
  return new Promise<{ ws: WebSocket; call(method: string, params?: unknown): Promise<RpcResponse> }>(
    (resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
      let n = 1;
      const pending = new Map<number, (r: RpcResponse) => void>();
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
      };
      ws.onerror = () => reject(new Error("socket error"));
      ws.onopen = () =>
        resolve({
          ws,
          call: (method, params) =>
            new Promise((res) => {
              const id = n++;
              pending.set(id, res);
              ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            }),
        });
    },
  );
}

test("the Phase 3 to 9 methods answer with exactly what their schemas promise", async () => {
  const t = tempDir("depo contract");
  cleanup = t.cleanup;
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  const { port } = await engine.start();
  const c = await connect(port);

  const ok = async (method: keyof typeof ApiSchema, params: unknown = {}) => {
    const res = await c.call(method, params);
    if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
    const parsed = ApiSchema[method].result.safeParse(res.result);
    if (!parsed.success)
      throw new Error(`${method} broke its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return parsed.data as Record<string, unknown>;
  };
  const fails = async (method: keyof typeof ApiSchema, params: unknown, text: string) => {
    const res = await c.call(method, params);
    expect("error" in res && res.error.message).toContain(text);
  };

  // A small project with a real problem in it.
  const proj = path.join(t.dir, "demo");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "app.py"), "import hashlib\nh = hashlib.md5(b'x')\neval(input())\n");
  const project = (await ok("projects.open", { path: proj })) as { id?: string };
  const projectId = project.id as string;
  expect(projectId).toBeTruthy();

  // Phase 3
  expect(((await ok("agents.list")).agents as unknown[]).length).toBe(15);
  await ok("blackboard.list", { projectId });

  // Phase 4
  await ok("diagrams.list", { projectId });
  await ok("decks.list", { projectId });
  expect(((await ok("design.fonts")).fonts as unknown[]).length).toBeGreaterThan(10);
  expect(await ok("scores.get", { projectId })).toEqual({ ux: null, security: null });

  // Phase 5
  await ok("skills.list");
  await ok("mcp.list");
  await ok("knowledge.list");
  await ok("osv.status");

  // Phase 6
  const status = await ok("security.status");
  expect((status.scanners as unknown[]).length).toBe(8);
  expect(((await ok("security.last", { projectId })).report as unknown) ?? null).toBeNull();
  const report = (await ok("security.scan", { projectId })) as {
    findings: { rule: string }[];
    score: { blocksRelease: boolean };
  };
  expect(report.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["py.weak-hash", "py.eval"]));
  expect(report.score.blocksRelease).toBe(true);
  expect((await ok("security.last", { projectId })).report).not.toBeNull();

  // Phase 7
  expect(((await ok("lab.agents")).agents as unknown[]).length).toBe(15);
  const v = await ok("lab.versions", { agentId: "backend" });
  expect((v.versions as unknown[]).length).toBe(1);
  const created = (await ok("lab.createVersion", {
    agentId: "backend",
    patch: { maxSteps: 44 },
    note: "more steps",
  })) as { id: string; version: string };
  expect(created.version).toBe("1.0.1");
  expect(((await ok("lab.suites", { agentId: "backend" })).suites as unknown[]).length).toBe(1);
  await ok("lab.saveSuite", {
    agentId: "backend",
    name: "Mine",
    cases: [{ id: "c1", prompt: "hi", checks: [{ type: "contains", value: "x" }] }],
  });
  await ok("lab.runs", { agentId: "backend" });
  const exp = (await ok("lab.export", { agentId: "backend", versionId: created.id })) as { json: string };
  expect(JSON.parse(exp.json).manifest.maxSteps).toBe(44);
  await fails("lab.promote", { agentId: "backend", versionId: created.id }, "not been tested");
  await fails("lab.runEval", { agentId: "backend", versionId: null, suiteId: "builtin:backend" }, "No model");
  await fails(
    "lab.playground",
    { agentId: "backend", versionId: null, messages: [{ role: "user", content: "hi" }] },
    "No model",
  );
  const imported = await ok("lab.import", { json: exp.json });
  expect(imported.source).toBe("import");
  await ok("lab.rollback", { agentId: "backend" }).catch((e: Error) =>
    expect(e.message).toContain("Nothing to roll back"),
  );
  await ok("lab.deleteVersion", { agentId: "backend", versionId: created.id });

  // Phase 8
  const blocks = (await ok("blocks.list")).blocks as { id: string }[];
  expect(blocks.map((b) => b.id)).toContain("auth-ts");

  // Phase 9
  expect(await ok("app.checkUpdate")).toMatchObject({ status: "unconfigured" });
  const bad = await c.call("lab.createVersion", {
    agentId: "backend",
    patch: { writes: ["src/"] },
    note: "x",
  });
  expect("error" in bad).toBe(true);
  c.ws.close();
}, 60_000);

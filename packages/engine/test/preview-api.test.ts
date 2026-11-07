import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiSchema, type PreviewInfo, type RpcResponse } from "@depo/shared";
import { createEngine, type Engine } from "../src/engine";
import { isListening } from "../src/preview/ports";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * End to end over the real WebSocket: copy the FastAPI fixture, detect how to run it, start it,
 * see HTTP 200, read its logs, restart, stop, and check that removing the project stops it too.
 * Skipped when Python with fastapi and uvicorn is not installed.
 */

const FIXTURE = path.resolve(import.meta.dir, "../../../scripts/fixtures/fastapi-demo");
const PYTHON = process.platform === "win32" ? "python" : Bun.which("python3") ? "python3" : "python";
const hasUvicorn = (() => {
  try {
    return Bun.spawnSync([PYTHON, "-c", "import fastapi, uvicorn"], { stdout: "ignore", stderr: "ignore" })
      .success;
  } catch {
    return false;
  }
})();

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  // Stopping the engine stops every preview and kills its process tree.
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

test.skipIf(!hasUvicorn)(
  "the FastAPI fixture runs from a copy, answers 200, shows logs, restarts and stops",
  async () => {
    const t = tempDir("depo preview e2e");
    cleanup = t.cleanup;
    const proj = path.join(t.dir, "fastapi demo");
    fs.cpSync(FIXTURE, proj, { recursive: true });
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

    try {
      const { id: projectId } = await ok<{ id: string }>("projects.open", { path: proj });
      const targets = await ok<{ targets: { taskId: string | null }[] }>("preview.targets", { projectId });
      expect(targets.targets[0]?.taskId).toBeNull();

      const d = await ok<{ recipes: { kind: string; command: string }[]; suggested: number }>(
        "preview.detect",
        {
          projectId,
        },
      );
      expect(d.recipes[d.suggested]?.kind).toBe("fastapi");
      expect(d.recipes[d.suggested]?.command).toContain("-m uvicorn app.main:app --host 127.0.0.1");

      const started = await ok<{ preview: PreviewInfo }>("preview.start", { projectId });
      const id = started.preview.id;
      let info = started.preview;
      const deadline = Date.now() + 45_000;
      while (info.state === "starting" && Date.now() < deadline) {
        await Bun.sleep(200);
        const list = await ok<{ previews: PreviewInfo[] }>("preview.list", { projectId });
        info = list.previews.find((p) => p.id === id) ?? info;
      }
      if (info.state !== "running") {
        const logs = await ok<{ lines: { text: string }[] }>("preview.logs", { id });
        throw new Error(
          `not running (${info.state}: ${info.error})\n${logs.lines.map((l) => l.text).join("\n")}`,
        );
      }
      expect(info.url).toStartWith("http://127.0.0.1:");

      const home = await fetch(info.url);
      expect(home.status).toBe(200);
      expect(await home.json()).toEqual({ message: "Hello" });
      expect(await (await fetch(`${info.url}items/7`)).json()).toEqual({ item_id: 7 });

      const logs = await ok<{ lines: { text: string }[]; next: number }>("preview.logs", { id });
      const text = logs.lines.map((l) => l.text).join("\n");
      expect(text).toContain("uvicorn");
      expect(text).toMatch(/Application startup complete|Uvicorn running/);
      const newer = await ok<{ lines: unknown[] }>("preview.logs", { id, since: logs.next });
      expect(newer.lines.length).toBeLessThan(logs.lines.length);

      const restarted = await ok<{ preview: PreviewInfo }>("preview.restart", { id });
      expect(restarted.preview.port).toBe(info.port);

      expect((await ok<{ stopped: boolean }>("preview.stop", { id })).stopped).toBe(true);
      expect(await isListening(info.port)).toBe(false);

      // Removing the project stops what still runs from it.
      const again = await ok<{ preview: PreviewInfo }>("preview.start", { projectId });
      await ok("projects.forget", { id: projectId });
      const after = engine.previews.get(again.preview.id);
      expect(after?.state).toBe("stopped");
    } finally {
      c.ws.close();
    }
  },
  90_000,
);

test("the preview methods keep their contracts (a static site, always run)", async () => {
  const t = tempDir("depo preview api");
  cleanup = t.cleanup;
  const proj = path.join(t.dir, "site");
  fs.mkdirSync(path.join(proj, "public"), { recursive: true });
  fs.writeFileSync(path.join(proj, "public", "index.html"), "<h1>Hello</h1>");
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  const e = engine;
  const { port } = await e.start();
  const c = await connect(port);
  const ok = async <T = Record<string, unknown>>(method: keyof typeof ApiSchema, params: unknown = {}) => {
    const res = await c.call(method, params);
    if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
    const parsed = ApiSchema[method].result.safeParse(res.result);
    if (!parsed.success)
      throw new Error(`${method} broke its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return parsed.data as T;
  };
  try {
    const { id: projectId } = await ok<{ id: string }>("projects.open", { path: proj });
    await ok("preview.targets", { projectId });
    const d = await ok<{ recipes: { kind: string; cwd: string }[] }>("preview.detect", { projectId });
    expect(d.recipes[0]).toMatchObject({ kind: "static", cwd: "public" });
    const { preview } = await ok<{ preview: PreviewInfo }>("preview.start", { projectId });
    expect((await e.previews.settled(preview.id))?.state).toBe("running");
    expect(await (await fetch(preview.url)).text()).toBe("<h1>Hello</h1>");
    const list = await ok<{ previews: PreviewInfo[] }>("preview.list", {});
    expect(list.previews.map((p) => p.id)).toContain(preview.id);
    await ok("preview.logs", { id: preview.id, since: 0 });
    await ok("preview.restart", { id: preview.id });
    expect((await ok<{ stopped: boolean }>("preview.stop", { id: preview.id })).stopped).toBe(true);
    // The owner's saved command is used, and a command the policy refuses never starts.
    await ok("projects.settings.set", { id: projectId, patch: { previewCommand: "format c:" } });
    const refused = await c.call("preview.start", { projectId });
    expect("error" in refused && refused.error.message).toContain("not allowed");
    const unknown = await c.call("preview.logs", { id: "prv_missing" });
    expect("error" in unknown).toBe(true);
  } finally {
    c.ws.close();
  }
}, 30_000);

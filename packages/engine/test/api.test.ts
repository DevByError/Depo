import { afterEach, describe, expect, test } from "bun:test";
import { DepoEventSchema, type RpcResponse } from "@depo/shared";
import { isAllowedOrigin } from "../src/api/server";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
});

async function boot(heartbeatMs = 100) {
  const t = tempDir();
  cleanup = t.cleanup;
  engine = createEngine({ dataRoot: t.dir, token: TEST_TOKEN, heartbeatMs });
  const { port } = await engine.start();
  return port;
}

interface Client {
  ws: WebSocket;
  messages: unknown[];
  call(method: string, params?: unknown): Promise<RpcResponse>;
}

function connect(port: number, token = TEST_TOKEN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
    const messages: unknown[] = [];
    let nextId = 1;
    const pending = new Map<number, (r: RpcResponse) => void>();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      messages.push(msg);
      if (typeof msg.id === "number" && pending.has(msg.id)) pending.get(msg.id)?.(msg);
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () =>
      resolve({
        ws,
        messages,
        call: (method, params) =>
          new Promise((res) => {
            const id = nextId++;
            pending.set(id, res);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
      });
  });
}

describe("auth", () => {
  test("rejects a wrong or missing token", async () => {
    const port = await boot();
    expect((await fetch(`http://127.0.0.1:${port}/rpc?token=nope`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/rpc`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  });
  test("rejects foreign browser origins", async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
  test("origin allowlist", () => {
    expect(isAllowedOrigin("http://tauri.localhost")).toBe(true);
    expect(isAllowedOrigin("tauri://localhost")).toBe(true);
    expect(isAllowedOrigin("http://localhost:1420")).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin("http://localhost.evil.com")).toBe(false);
    expect(isAllowedOrigin("https://example.com")).toBe(false);
  });
  test("rejects short tokens at startup", () => {
    expect(() => createEngine({ dataRoot: "/tmp/never", token: "short" })).toThrow();
  });
});

describe("json-rpc", () => {
  test("ping, info, settings round-trip", async () => {
    const c = await connect(await boot());
    const ping = await c.call("system.ping", {});
    expect("result" in ping && ping.result).toMatchObject({ pong: true });

    const info = await c.call("system.info");
    expect("result" in info && info.result).toMatchObject({ schemaVersion: 1, engineVersion: "0.1.0" });

    const def = await c.call("settings.get", { key: "ui.theme" });
    expect("result" in def && def.result).toEqual({ key: "ui.theme", value: "dark" });
    await c.call("settings.set", { key: "ui.theme", value: "light" });
    const all = await c.call("settings.all", {});
    expect(
      "result" in all && (all.result as { settings: Record<string, unknown> }).settings["ui.theme"],
    ).toBe("light");
    c.ws.close();
  });

  test("returns typed errors", async () => {
    const c = await connect(await boot());
    const unknown = await c.call("nope.method", {});
    expect("error" in unknown && unknown.error.code).toBe(-32601);
    const bad = await c.call("settings.get", { key: 42 });
    expect("error" in bad && bad.error.code).toBe(-32602);
    const extra = await c.call("system.ping", { surprise: true });
    expect("error" in extra && extra.error.code).toBe(-32602);

    c.ws.send("{not json");
    await waitFor(() =>
      c.messages.find((m) => (m as RpcResponse & { error?: { code: number } }).error?.code === -32700),
    );
    c.ws.close();
  });

  test("streams heartbeats and persisted events to clients", async () => {
    const c = await connect(await boot(100));
    await c.call("events.emit", { type: "info", text: "hello from the UI" });
    const events = () => c.messages.filter((m) => (m as { method?: string }).method === "event");
    const hb = await waitFor(() =>
      events().find((m) => (m as { params: { type: string } }).params.type === "heartbeat"),
    );
    const parsed = DepoEventSchema.parse((hb as { params: unknown }).params);
    expect(parsed.ephemeral).toBe(true);
    expect(parsed.details).toMatchObject({ connectedClients: 1 });

    const recent = await c.call("events.recent", { limit: 50 });
    const types =
      "result" in recent ? (recent.result as { events: { type: string }[] }).events.map((e) => e.type) : [];
    expect(types).toContain("engine_started");
    expect(types).toContain("info");
    expect(types).not.toContain("heartbeat");
    c.ws.close();
  });

  test("serves several clients at once", async () => {
    const port = await boot(100);
    const a = await connect(port);
    const b = await connect(port);
    await a.call("events.emit", { type: "info", text: "broadcast" });
    for (const c of [a, b]) {
      await waitFor(() =>
        c.messages.find((m) => (m as { params?: { text?: string } }).params?.text === "broadcast"),
      );
    }
    a.ws.close();
    b.ws.close();
  });
});

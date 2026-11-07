import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { type ChatChunk, collectChat, ModelGatewayError, type ModelProvider } from "@depo/model-gateway";
import { ApiSchema, type LogLine, type RpcResponse } from "@depo/shared";
import { createEngine, type Engine } from "../src/engine";
import { createLogger, type Logger } from "../src/logger";
import { instrumentProvider, ModelCallStats } from "../src/logs/model-calls";
import { decodeCursor, queryLogs } from "../src/logs/query";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

const COMPONENTS = ["api", "tools", "models", "scheduler"] as const;
const LEVELS = ["debug", "info", "warn", "error"] as const;

/** 80 lines over several rotated files; many share a millisecond, which paging must handle. */
function writeSample(log: Logger) {
  for (let i = 0; i < 80; i++) {
    const level = LEVELS[i % 4] as (typeof LEVELS)[number];
    log[level](i % 10 === 0 ? `needle line ${i}` : `line ${i}`, {
      component: COMPONENTS[i % 3],
      taskId: i % 2 === 0 ? "tsk_even" : "tsk_odd",
      projectId: "prj_a",
      i,
    });
  }
  log.flush();
}

test("logs.query reads the current and rotated files, newest first, with filters", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "debug", maxBytes: 2500, maxFiles: 9, flushMs: 0 });
  writeSample(log);
  const files = fs.readdirSync(t.dir).filter((f) => f.endsWith(".log"));
  expect(files.length).toBeGreaterThanOrEqual(4);

  const all = await queryLogs(t.dir, { limit: 1000 });
  expect(all.lines.map((l) => l.data.i)).toEqual(Array.from({ length: 80 }, (_, i) => i));
  expect(all.next).toBeNull();
  expect(all.truncated).toBe(false);
  expect(all.counts).toEqual({ debug: 20, info: 20, warn: 20, error: 20 });
  expect(new Set(all.lines.map((l) => l.id)).size).toBe(80);

  const warn = await queryLogs(t.dir, { limit: 1000, level: "warn" });
  expect(warn.lines.every((l) => l.level === "warn" || l.level === "error")).toBe(true);
  expect(warn.lines).toHaveLength(40);
  // Counts cover every level, so the chips can show what is hidden.
  expect(warn.counts.debug).toBe(20);

  const debugOnly = await queryLogs(t.dir, { limit: 1000, levels: ["debug"] });
  expect(debugOnly.lines.map((l) => l.level)).toEqual(Array(20).fill("debug"));

  const tools = await queryLogs(t.dir, { limit: 1000, component: "tools" });
  expect(tools.lines.every((l) => l.component === "tools")).toBe(true);
  expect(tools.lines.length).toBe(27);

  const needle = await queryLogs(t.dir, { limit: 1000, text: "NEEDLE" });
  expect(needle.lines.map((l) => l.data.i)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);

  const odd = await queryLogs(t.dir, { limit: 1000, taskId: "tsk_odd", component: "api" });
  expect(odd.lines.every((l) => l.taskId === "tsk_odd" && l.component === "api")).toBe(true);
  expect(odd.lines.length).toBeGreaterThan(0);

  const mid = all.lines[40] as LogLine;
  const since = await queryLogs(t.dir, { limit: 1000, since: mid.ts });
  expect(since.lines.every((l) => l.ts >= mid.ts)).toBe(true);
  expect(since.lines.at(-1)?.data.i).toBe(79);
  const until = await queryLogs(t.dir, { limit: 1000, until: mid.ts });
  expect(until.lines.every((l) => l.ts < mid.ts)).toBe(true);
});

test("logs.query pages backwards without gaps or repeats, even within one millisecond", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "debug", maxBytes: 2500, maxFiles: 9, flushMs: 0 });
  writeSample(log);

  const seen: unknown[] = [];
  let before: string | undefined;
  for (let page = 0; page < 30; page++) {
    const res = await queryLogs(t.dir, { limit: 7, ...(before ? { before } : {}) });
    seen.unshift(...res.lines.map((l) => l.data.i));
    if (!res.next) break;
    expect(decodeCursor(res.next)).not.toBeNull();
    before = res.next;
  }
  expect(seen).toEqual(Array.from({ length: 80 }, (_, i) => i));

  // Paging with a filter.
  const errors: unknown[] = [];
  before = undefined;
  for (let page = 0; page < 30; page++) {
    const res = await queryLogs(t.dir, { limit: 3, level: "error", ...(before ? { before } : {}) });
    errors.unshift(...res.lines.map((l) => l.data.i));
    if (!res.next) break;
    before = res.next;
  }
  expect(errors).toEqual(Array.from({ length: 20 }, (_, i) => i * 4 + 3));
});

test("logs.query stops at the byte limit and continues from where it stopped", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "debug", maxBytes: 2500, maxFiles: 9, flushMs: 0 });
  writeSample(log);
  const first = await queryLogs(t.dir, { limit: 100, text: "needle", maxBytes: 4096 });
  expect(first.truncated).toBe(true);
  expect(first.scannedBytes).toBeLessThanOrEqual(4096 + 200);
  expect(first.next).not.toBeNull();
  const found = first.lines.map((l) => l.data.i);
  let before = first.next ?? undefined;
  for (let n = 0; before && n < 20; n++) {
    const res = await queryLogs(t.dir, { limit: 100, text: "needle", maxBytes: 4096, before });
    found.unshift(...res.lines.map((l) => l.data.i));
    before = res.next ?? undefined;
  }
  expect(found).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
});

test("logs.query skips lines it cannot read and tolerates CRLF", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const ok = (i: number) =>
    JSON.stringify({ ts: `2026-11-07T10:00:0${i}.000Z`, level: "info", component: "api", msg: `m${i}` });
  fs.writeFileSync(path.join(t.dir, "engine.log"), `${ok(1)}\r\nnot json\r\n{"broken":\r\n${ok(2)}\r\n`);
  fs.writeFileSync(path.join(t.dir, "engine.1.log"), `${ok(0)}\n`);
  fs.writeFileSync(path.join(t.dir, "other.log"), `${ok(9)}\n`);
  const res = await queryLogs(t.dir, { limit: 10 });
  expect(res.lines.map((l) => l.msg)).toEqual(["m0", "m1", "m2"]);
});

function fakeProvider(script: () => AsyncIterable<ChatChunk>): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    health: async () => ({ ok: true, version: "1", message: null }),
    listModels: async () => [],
    chat: () => script(),
    embed: async () => [[0]],
  };
}

test("model calls are timed, logged and kept for the Engine panel", async () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const log = createLogger({ dir: t.dir, level: "debug", flushMs: 0 });
  const stats = new ModelCallStats();
  const good = instrumentProvider(
    fakeProvider(async function* () {
      await Bun.sleep(30);
      yield { type: "text", delta: "hello" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens: 120, completionTokens: 50, durationMs: 500 },
      };
    }),
    log,
    stats,
  );
  const res = await collectChat(good.chat({ model: "qwen:7b", messages: [{ role: "user", content: "hi" }] }));
  expect(res.text).toBe("hello");
  const bad = instrumentProvider(
    fakeProvider(async function* () {
      yield* [];
      throw new ModelGatewayError("unreachable", "Ollama is not running.");
    }),
    log,
    stats,
  );
  await expect(collectChat(bad.chat({ model: "qwen:7b", messages: [] }))).rejects.toThrow("not running");

  const [failed, okCall] = stats.recent();
  expect(okCall).toMatchObject({ ok: true, promptTokens: 120, completionTokens: 50, tokensPerSec: 100 });
  expect(okCall?.ttftMs).toBeGreaterThanOrEqual(25);
  expect(failed).toMatchObject({ ok: false, errorKind: "unreachable", error: "Ollama is not running." });
  expect(stats.summary()).toEqual([
    expect.objectContaining({ model: "qwen:7b", calls: 2, errors: 1, avgTokensPerSec: 100 }),
  ]);
  const lines = (await queryLogs(t.dir, { limit: 10, text: "model call" })).lines;
  expect(lines.map((l) => [l.level, l.msg])).toEqual([
    ["debug", "model call started"],
    ["info", "model call"],
    ["debug", "model call started"],
    ["warn", "model call failed"],
  ]);
  expect(lines[1]?.data).toMatchObject({ model: "qwen:7b", provider: "fake", tokensPerSec: 100 });
  expect(lines[3]?.err?.message).toBe("Ollama is not running.");
});

/** Reads the central directory of a .zip: file names → uncompressed contents. */
function readZip(file: string): Map<string, string> {
  const buf = fs.readFileSync(file);
  const out = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

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

test("the logs methods answer with what their schemas promise, and the export holds no secrets", async () => {
  const t = tempDir("depo logs");
  cleanup = t.cleanup;
  const opened: string[] = [];
  engine = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    openFolder: (dir) => opened.push(dir),
    models: {
      providerFactory: () =>
        fakeProvider(async function* () {
          yield { type: "text", delta: "ok" };
          yield {
            type: "done",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 20, durationMs: 1000 },
          };
        }),
    },
  });
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

  // Secrets in a setting, a log line, an event and a model call.
  await ok("settings.set", {
    key: "integrations.github_token",
    value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  engine.logger.child({ component: "security" }).warn("login attempt", { password: "hunter2-secret-pw" });
  engine.logger.info("calling Authorization: Bearer abcdefghijklmnopqrst");
  await ok("events.emit", { type: "info", text: "my key is sk-abcdefghijklmnop1234" });
  await collectChat(engine.models.provider("ollama").chat({ model: "tiny:1b", messages: [] }));

  // Level setting: debug lines appear once the setting says so.
  engine.logger.debug("hidden at info");
  await ok("settings.set", { key: "logs.level", value: "debug" });
  engine.logger.debug("shown at debug");

  const q = await ok("logs.query", { limit: 200 });
  const msgs = (q.lines as LogLine[]).map((l) => l.msg);
  expect(msgs).toContain("engine started");
  expect(msgs).toContain("shown at debug");
  expect(msgs).not.toContain("hidden at info");
  expect(msgs).toContain("model call");
  const security = await ok("logs.query", { component: "security", limit: 10 });
  expect((security.lines as LogLine[])[0]?.data.password).toBe("«redacted»");

  // The tail continues from the query's cursor.
  engine.logger.warn("after the query", { component: "tools" });
  const tail = await ok("logs.tail", { cursor: q.cursor, level: "warn" });
  expect((tail.lines as LogLine[]).map((l) => l.msg)).toEqual(["after the query"]);
  expect(tail.reset).toBe(false);
  expect((await ok("logs.tail", { cursor: tail.cursor })).lines).toEqual([]);

  const comps = (await ok("logs.components")).components as string[];
  expect(comps).toEqual(expect.arrayContaining(["api", "engine", "models", "security", "tools"]));
  const info = await ok("logs.info");
  expect(info.level).toBe("debug");
  expect((info.files as { name: string }[]).map((f) => f.name)).toContain("engine.log");

  const stats = await ok("models.stats");
  expect(stats.calls).toEqual([expect.objectContaining({ model: "tiny:1b", ok: true, tokensPerSec: 20 })]);

  const opening = await ok("logs.openFolder");
  expect(opening.ok).toBe(true);
  expect(opened).toEqual([engine.dirs.logs]);

  const dest = path.join(t.dir, "out");
  fs.mkdirSync(dest);
  const exp = (await ok("logs.export", { destDir: dest })) as { path: string; files: string[] };
  expect(path.dirname(exp.path)).toBe(dest);
  expect(path.basename(exp.path)).toMatch(/^depo-diagnostics-\d{8}-\d{6}\.zip$/);
  const zip = readZip(exp.path);
  expect([...zip.keys()]).toEqual(
    expect.arrayContaining([
      "README.txt",
      "logs/engine.log",
      "system-info.json",
      "hardware.json",
      "settings.json",
      "events.json",
      "models.json",
      "scheduler.json",
    ]),
  );
  expect(JSON.parse(zip.get("system-info.json") ?? "{}").engineVersion).toBeTruthy();
  expect(JSON.parse(zip.get("settings.json") ?? "{}")["integrations.github_token"]).toBe("«redacted»");
  expect(zip.get("logs/engine.log")).toContain("login attempt");
  expect(zip.get("events.json")).toContain("my key is");
  expect(JSON.parse(zip.get("models.json") ?? "{}").recentCalls.calls).toHaveLength(1);
  const everything = [...zip.values()].join("\n");
  for (const secret of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "hunter2-secret-pw",
    "abcdefghijklmnopqrst",
    "sk-abcdefghijklmnop1234",
    TEST_TOKEN,
  ]) {
    expect(everything).not.toContain(secret);
  }

  const bad = await c.call("logs.query", { limit: 0 });
  expect("error" in bad).toBe(true);
  c.ws.close();
}, 30_000);

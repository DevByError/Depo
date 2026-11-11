import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import { type ChatChunk, type ChatRequest, ModelGatewayError, type ModelProvider } from "@depo/model-gateway";
import type { DepoEvent, RpcResponse } from "@depo/shared";
import { MAX_MESSAGE_BYTES } from "../src/api/server";
import { createEngine, type Engine } from "../src/engine";
import { createLogger } from "../src/logger";
import { holdsOneModel, ModelScheduler, type SchedulerRequest } from "../src/scheduler/scheduler";
import { moveAsideAndRemove, removeTree, settleRemovals, sweepTrash, TRASH_MARK } from "../src/util/remove";
import { startRunMark } from "../src/util/runmark";
import { startWatchdog } from "../src/util/watchdog";
import { removeShadow } from "../src/workspace/snapshot";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

// The owner's run on 11-11: after a send with two pictures the app's link to the engine dropped
// three times in 90 s, the heartbeat looked dead, and the engine went silent at 11:46 with no
// trace of why. These are the fixes: nothing blocks the engine's thread for long, a freeze leaves
// a trace, link drops are explained, one model at a time on a small GPU, and a resend is safe.

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

const busyWait = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // the engine's thread is blocked
  }
};

function makeTree(root: string, files: number) {
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(root, "node_modules", "pkg", `f${i}.js`), "x");
  fs.writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
}

describe("deleting without blocking", () => {
  test("a folder moves out of the way at once and is deleted in the background", async () => {
    const t = tempDir("depo remove");
    cleanup = t.cleanup;
    const dir = path.join(t.dir, "ws", "tsk_1");
    makeTree(dir, 300);
    expect(moveAsideAndRemove(dir, () => fs.rmSync(dir, { recursive: true }))).toBe("moved");
    // The path is free immediately: a new copy can be made there while the old one is deleted.
    expect(fs.existsSync(dir)).toBe(false);
    await settleRemovals();
    expect(fs.readdirSync(path.join(t.dir, "ws"))).toEqual([]);
  });

  test("a copy's links into the real project are cut first, so its packages are never deleted", async () => {
    const t = tempDir("depo remove");
    cleanup = t.cleanup;
    const project = path.join(t.dir, "project");
    makeTree(project, 3);
    const copy = path.join(t.dir, "ws", "tsk_2");
    fs.mkdirSync(path.join(copy, "tree"), { recursive: true });
    fs.symlinkSync(path.join(project, "node_modules"), path.join(copy, "tree", "node_modules"), "dir");
    removeShadow(copy);
    expect(fs.existsSync(copy)).toBe(false);
    await settleRemovals();
    expect(fs.existsSync(path.join(project, "node_modules", "pkg", "f0.js"))).toBe(true);
  });

  test("leftovers of a run that ended mid-delete are swept at the next start", async () => {
    const t = tempDir("depo remove");
    cleanup = t.cleanup;
    makeTree(path.join(t.dir, `tsk_3${TRASH_MARK}abc`), 5);
    fs.mkdirSync(path.join(t.dir, "tsk_4"));
    expect(sweepTrash(t.dir)).toBe(1);
    await settleRemovals();
    expect(fs.readdirSync(t.dir)).toEqual(["tsk_4"]);
    expect(await removeTree(path.join(t.dir, "missing"))).toBe(true);
  });
});

describe("freeze watchdog", () => {
  test("a block is logged with what the engine was doing, and a long one by the watcher thread too", async () => {
    const t = tempDir("depo watchdog");
    cleanup = t.cleanup;
    const logger = createLogger({ dir: t.dir, level: "info", flushMs: 0 });
    const file = path.join(t.dir, "engine.log");
    const w = startWatchdog({
      logger,
      logFile: file,
      activity: () => "answering tasks.send",
      tickMs: 50,
      stallMs: 300,
      blockedMs: 600,
    });
    await Bun.sleep(150);
    busyWait(1500);
    // Let the late tick and the watcher's "responding again" run.
    await Bun.sleep(700);
    w.stop();
    logger.flush();
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { msg: string; blockedMs?: number; doing?: string; component?: string });
    const blocked = lines.find((l) => l.msg === "the engine was blocked");
    expect(blocked?.doing).toBe("answering tasks.send");
    expect(blocked?.blockedMs ?? 0).toBeGreaterThanOrEqual(1200);
    // Written by the other thread while the engine's own thread could not log anything.
    const stuck = lines.find((l) => l.msg === "the engine is not responding");
    expect(stuck?.component).toBe("watchdog");
    expect(stuck?.doing).toBe("answering tasks.send");
    expect(lines.some((l) => l.msg === "the engine is responding again")).toBe(true);
  });

  test("the heartbeat reports the worst delay since the last beat", async () => {
    const t = tempDir("depo watchdog");
    cleanup = t.cleanup;
    const logger = createLogger({ dir: t.dir, level: "error" });
    const w = startWatchdog({ logger, logFile: null, activity: () => "", tickMs: 20 });
    await Bun.sleep(60);
    busyWait(250);
    await Bun.sleep(60);
    expect(w.takeLag()).toBeGreaterThanOrEqual(200);
    await Bun.sleep(80);
    expect(w.takeLag()).toBeLessThan(200);
    w.stop();
  });
});

describe("last-run trail", () => {
  test("a run that never stopped cleanly is reported at the next start; a clean stop is not", () => {
    const t = tempDir("depo runmark");
    cleanup = t.cleanup;
    const first = startRunMark(t.dir, () => new Date("2026-11-11T03:11:14Z"));
    expect(first.lastRun).toBeNull();
    first.alive("1 task working; last event: manager@1.0.0: Manager is reading the request");
    // No stop: the engine was killed or froze.
    const second = startRunMark(t.dir);
    expect(second.lastRun?.doing).toContain("Manager is reading the request");
    expect(second.lastRun?.startedAt).toBe("2026-11-11T03:11:14.000Z");
    second.stopped("test");
    expect(startRunMark(t.dir).lastRun).toBeNull();
  });
});

describe("one model at a time on a small GPU", () => {
  const req = (model: string, taskId: string): SchedulerRequest => ({
    projectId: taskId,
    taskId,
    model,
    priority: "task",
    label: "step",
  });

  test("a job for another model waits even when two may run; the same model shares", async () => {
    const notes: string[] = [];
    const s = new ModelScheduler({
      bus: { emit: (e: { text: string }) => notes.push(e.text) } as never,
      maxParallel: () => 2,
      projectCap: () => 2,
      isProjectPaused: () => false,
      oneModel: () => true,
    });
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const a = s.run(req("qwen3:4b", "A"), async () => {
      order.push("manager");
      await held;
    });
    const b = s.run(req("qwen2.5-coder:3b", "B"), async () => {
      order.push("coder");
    });
    const c = s.run(req("qwen3:4b", "C"), async () => {
      order.push("manager 2");
    });
    await Bun.sleep(5);
    expect(order).toEqual(["manager", "manager 2"]);
    expect(
      notes.some((n) => /Waiting for qwen3:4b to finish: this graphics card runs one model/.test(n)),
    ).toBe(true);
    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["manager", "manager 2", "coder"]);
  });

  test("auto is on for cards under 8 GB and with no GPU, off for big cards; the setting wins", () => {
    const pc = (vram: number[], ram = 25, unified = false) => ({
      gpus: vram.map((v) => ({ vramGB: v })),
      ramGB: ram,
      unifiedMemory: unified,
    });
    expect(holdsOneModel("auto", pc([4.3]))).toBe(true);
    expect(holdsOneModel("auto", pc([]))).toBe(true);
    expect(holdsOneModel("auto", pc([24]))).toBe(false);
    expect(holdsOneModel("auto", pc([], 32, true))).toBe(false);
    expect(holdsOneModel("off", pc([4.3]))).toBe(false);
    expect(holdsOneModel(true, pc([24]))).toBe(true);
    expect(holdsOneModel("auto", null)).toBe(false);
  });
});

interface Client {
  ws: WebSocket;
  call(method: string, params?: unknown): Promise<RpcResponse>;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
    let nextId = 1;
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
            const id = nextId++;
            pending.set(id, res);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
      });
  });
}

const logLines = (dataRoot: string) => {
  engine?.logger.flush();
  return fs
    .readFileSync(path.join(dataRoot, "logs", "engine.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("the link to the window", () => {
  test("a dropped link is logged with its code, and the window's report lands in the log", async () => {
    const t = tempDir("depo link");
    cleanup = t.cleanup;
    engine = createEngine({ dataRoot: t.dir, token: TEST_TOKEN, heartbeatMs: 100 });
    const { port } = await engine.start();
    const a = await connect(port);
    a.ws.close(4001, "test drop");
    await waitFor(() => logLines(t.dir).find((l) => l.msg === "ui client disconnected"));
    const closed = logLines(t.dir).find((l) => l.msg === "ui client disconnected");
    expect(closed?.code).toBe(4001);
    expect(closed?.reason).toBe("test drop");
    expect(typeof closed?.connectedMs).toBe("number");

    const b = await connect(port);
    const res = await b.call("system.clientReport", {
      connects: 2,
      pageLoads: 2,
      lastClose: { code: 1006, reason: "", clean: false, agoMs: 12_900, downMs: 12_900, attempts: 6 },
      freezes: 1,
      longestFreezeMs: 4200,
      visible: true,
    });
    expect("result" in res && res.result).toEqual({ ok: true });
    const report = logLines(t.dir).find((l) => l.msg === "ui report");
    expect(report?.level).toBe("warn");
    expect((report?.lastClose as { code: number } | undefined)?.code).toBe(1006);
    expect(report?.longestFreezeMs).toBe(4200);
    b.ws.close();
  });

  test("a message with four 5 MB pictures fits (it used to close the link)", async () => {
    expect(MAX_MESSAGE_BYTES).toBeGreaterThan(4 * Math.ceil((5 * 1024 * 1024) / 3) * 4 + 64 * 1024);
    const t = tempDir("depo link");
    cleanup = t.cleanup;
    engine = createEngine({ dataRoot: t.dir, token: TEST_TOKEN, heartbeatMs: 100 });
    const { port } = await engine.start();
    const c = await connect(port);
    let closed = false;
    c.ws.addEventListener("close", () => {
      closed = true;
    });
    // 20 MB of padding in an unknown field: the engine answers "Invalid params" instead of dropping the link.
    const res = await c.call("system.ping", { pad: "x".repeat(20 * 1024 * 1024) });
    expect("error" in res).toBe(true);
    expect(closed).toBe(false);
    expect("result" in (await c.call("system.ping", {}))).toBe(true);
    c.ws.close();
  }, 30_000);

  test("the heartbeat carries the engine's delay, and an unclean last run is reported at start", async () => {
    const t = tempDir("depo link");
    cleanup = t.cleanup;
    fs.writeFileSync(
      path.join(t.dir, "run.json"),
      JSON.stringify({
        pid: 4242,
        startedAt: "2026-11-11T03:11:14.000Z",
        aliveAt: "2026-11-11T03:46:13.000Z",
        doing: "1 task working; last event: manager@1.0.0: Manager is reading the request",
        clean: false,
      }),
    );
    engine = createEngine({ dataRoot: t.dir, token: TEST_TOKEN, heartbeatMs: 100 });
    const events: DepoEvent[] = [];
    engine.bus.subscribe((e) => events.push(e));
    await engine.start();
    const warn = engine.bus.recent({ limit: 50 }).find((e) => e.details?.lastRun);
    expect(warn?.text).toMatch(/did not stop cleanly last time.*after 35 min, while 1 task working/);
    const beat = await waitFor(() => events.find((e) => e.type === "heartbeat"));
    expect(typeof beat.details?.lagMs).toBe("number");
    await engine.stop("test");
    engine = null;
    expect(JSON.parse(fs.readFileSync(path.join(t.dir, "run.json"), "utf8")).clean).toBe(true);
  });
});

describe("sending the same request twice", () => {
  /** Waits while the request says "slow", until stopped. */
  function slowModel(started: () => void): ModelProvider {
    return {
      id: "fake",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "fake", message: null }),
      listModels: async () => [],
      embed: async (_m, inputs) => inputs.map(() => [0]),
      async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
        started();
        await new Promise<void>((r) => req.signal?.addEventListener("abort", () => r(), { once: true }));
        throw new ModelGatewayError("cancelled", "Cancelled");
      },
    };
  }

  test("a resend while the first still works opens the working task; other text starts a new one", async () => {
    const t = tempDir("depo resend");
    cleanup = t.cleanup;
    let started = () => {};
    const busy = new Promise<void>((r) => {
      started = r;
    });
    const e = createEngine({
      dataRoot: path.join(t.dir, "data"),
      token: TEST_TOKEN,
      heartbeatMs: 60_000,
      models: { providerFactory: () => slowModel(() => started()) },
    });
    engine = e;
    await e.start();
    e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
    e.models.assign("coder", { providerId: "fake", model: "fake-model" });
    for (const [k, v] of Object.entries({ "memory.auto": false, "preview.auto_start": false }))
      e.settings.set(k, v as never);
    const proj = path.join(t.dir, "site");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>site</h1>\n");
    const project = await e.projects.open(proj);
    const text = "The first image is the UI/UX to follow. The second image is the background image";
    const first = e.tasks.send(project.id, text);
    await busy;
    const again = e.tasks.send(project.id, `  ${text.replace(" The second", "  The second")}\n`);
    expect(again.id).toBe(first.id);
    expect(e.tasks.runningIds()).toEqual([first.id]);
    expect(
      e.bus.recent({ limit: 50 }).some((ev) => ev.taskId === first.id && ev.details?.duplicateSend === true),
    ).toBe(true);
    const other = e.tasks.send(project.id, "Make the header blue");
    expect(other.id).not.toBe(first.id);
    e.tasks.cancel(first.id);
    e.tasks.cancel(other.id);
    await e.tasks.settled(first.id);
    await e.tasks.settled(other.id);
    // Finished: the same text starts a fresh task again.
    const later = e.tasks.send(project.id, text);
    expect(later.id).not.toBe(first.id);
    e.tasks.cancel(later.id);
    await e.tasks.settled(later.id);
  }, 30_000);
});

import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider, ToolCall } from "@depo/model-gateway";
import {
  ApiSchema,
  type DepoEvent,
  type EtaNodeInput,
  etaRangeText,
  type Plan,
  remainingEta,
  simulateSchedule,
} from "@depo/shared";
import { EtaService, EtaTracker, etaNote, guessStep, rangeFrom } from "../src/agents/eta";
import { replayDetails } from "../src/agents/timeline";
import { openDatabase } from "../src/db";
import { createEngine, type Engine } from "../src/engine";
import { ModelCallStats } from "../src/logs/model-calls";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

const MIN = 60_000;
const r = (mid: number, spread = 0) => ({ low: mid - spread, mid, high: mid + spread });
const n = (
  id: string,
  deps: string[],
  mins: number,
  status: EtaNodeInput["status"] = "todo",
  elapsed = 0,
) => ({
  id,
  deps,
  status,
  duration: r(mins * MIN),
  elapsed: elapsed * MIN,
});

// ---- schedule math (shared by the engine and the UI) ----------------------------------------

describe("critical path with team.parallel", () => {
  test("a serial chain adds up; parallel branches overlap up to the limit", () => {
    const chain = [n("a", [], 5), n("b", ["a"], 10), n("c", ["b"], 3)];
    expect(simulateSchedule(chain, 4).total).toBe(18 * MIN);

    // a -> (b, c, d) -> e: three branches of 10, 6 and 4 minutes.
    const fan = [
      n("a", [], 2),
      n("b", ["a"], 10),
      n("c", ["a"], 6),
      n("d", ["a"], 4),
      n("e", ["b", "c", "d"], 1),
    ];
    expect(simulateSchedule(fan, 3).total).toBe((2 + 10 + 1) * MIN); // the critical path
    expect(simulateSchedule(fan, 1).total).toBe((2 + 10 + 6 + 4 + 1) * MIN); // one at a time
    // Two at once: b and c start together, d waits for c (6), then e waits for b (10).
    const two = simulateSchedule(fan, 2);
    expect(two.total).toBe((2 + 10 + 1) * MIN);
    expect(two.start.d).toBe(8 * MIN);
    expect(two.finish.e).toBe(13 * MIN);
  });

  test("running tasks keep their slot and count down; failed and blocked work is left out", () => {
    const nodes = [
      n("a", [], 5, "done"),
      n("b", ["a"], 10, "doing", 4),
      n("c", ["a"], 8, "review", 9), // over its estimate: a little time stays
      n("d", ["b"], 3),
      n("x", [], 7, "failed"),
      n("y", ["x"], 20), // waits on failed work: never runs
    ];
    const res = simulateSchedule(nodes, 2);
    expect(res.finish.b).toBe(6 * MIN);
    expect(res.finish.c).toBe(0.8 * MIN);
    expect(res.total).toBe(9 * MIN);
    expect(res.start.y).toBeUndefined();

    const left = remainingEta(nodes, 2);
    expect(left.nodes.b?.left.mid).toBe(6 * MIN);
    expect(left.nodes.d?.left.mid).toBe(3 * MIN);
    expect(left.nodes.d?.finish.mid).toBe(9 * MIN);
    expect(left.nodes.a?.left.mid).toBe(0);
    expect(left.total.mid).toBe(9 * MIN);
  });

  test("ranges read like a person would say them", () => {
    expect(etaRangeText({ low: 10_000, high: 40_000 })).toBe("under a minute");
    expect(etaRangeText({ low: 2.4 * MIN, high: 5.2 * MIN })).toBe("2 to 6 min");
    expect(etaRangeText({ low: 26 * MIN, high: 37 * MIN })).toBe("25 to 40 min");
    expect(etaRangeText({ low: 45 * MIN, high: 80 * MIN })).toBe("45 min to 1.5 hours");
    expect(etaRangeText({ low: 95 * MIN, high: 170 * MIN })).toBe("1.5 to 3 hours");
    expect(etaRangeText({ low: 4 * MIN, high: 4 * MIN })).toBe("about 4 min");
  });
});

// ---- learning from the event stream -----------------------------------------------------------

let seq = 0;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
function ev(
  at: number,
  agent: string,
  type: DepoEvent["type"],
  status: DepoEvent["status"],
  details: DepoEvent["details"] = null,
  taskId = "tsk_1",
): DepoEvent {
  seq++;
  return {
    id: `evt_${seq.toString(16).padStart(28, "0")}`,
    ts: new Date(T0 + at).toISOString(),
    seq,
    projectId: "prj_1",
    taskId,
    agent,
    type,
    text: type,
    details,
    durationMs: null,
    status,
    ephemeral: false,
  };
}

describe("the learner", () => {
  test("a reviewed task gives work, review, fix and whole-task times, without time spent waiting for you", () => {
    const t = new EtaTracker();
    const s = 1000;
    const out = [
      ev(0, "manager@1.0.0", "handoff", "started", { nodeId: "api", to: "backend" }),
      // The backend waits 30 s for a command approval inside its first attempt.
      ev(10 * s, "backend@1.0.0", "waiting_for_user", "started", { approvalId: "req_1" }),
      ev(40 * s, "user", "info", "succeeded", { approvalId: "req_1", approved: true }),
      ev(100 * s, "security@1.0.0", "reviewing", "started", { nodeId: "api" }),
      ev(120 * s, "security@1.0.0", "reviewing", "failed", { nodeId: "api", verdict: "changes" }),
      ev(121 * s, "manager@1.0.0", "decision", "running", { kind: "send_back", nodeId: "api", attempt: 2 }),
      ev(161 * s, "security@1.0.0", "reviewing", "started", { nodeId: "api" }),
      ev(171 * s, "security@1.0.0", "reviewing", "succeeded", { nodeId: "api", verdict: "approve" }),
      ev(172 * s, "backend@1.0.0", "handoff", "succeeded", { nodeId: "api", status: "done" }),
    ].flatMap((e) => t.observe(e));
    expect(out).toHaveLength(1);
    const samples = out[0]?.samples.map((x) => [x.agent, x.kind, x.durationMs, x.attempts ?? null]);
    expect(samples).toEqual([
      ["backend", "work", 70 * s, null],
      ["security", "review", 20 * s, null],
      ["backend", "fix", 40 * s, null],
      ["security", "review", 10 * s, null],
      ["backend", "node", 142 * s, 2],
    ]);
  });

  test("failed work and stopped runs teach nothing; a single-agent run is one sample", () => {
    const t = new EtaTracker();
    const failed = [
      ev(0, "manager@1.0.0", "handoff", "started", { nodeId: "db", to: "database" }, "tsk_2"),
      ev(5000, "database@1.0.0", "handoff", "failed", { nodeId: "db", status: "failed" }, "tsk_2"),
    ].flatMap((e) => t.observe(e));
    expect(failed).toEqual([]);

    const stopped = [
      ev(0, "coder@1.0.0", "planning", "started", { model: "qwen" }, "tsk_3"),
      ev(9000, "coder@1.0.0", "info", "cancelled", null, "tsk_3"),
      ev(9500, "coder@1.0.0", "handoff", "succeeded", null, "tsk_3"),
    ].flatMap((e) => t.observe(e));
    expect(stopped).toEqual([]);

    const single = [
      ev(0, "coder@1.0.0", "planning", "started", { model: "qwen" }, "tsk_4"),
      ev(1000, "coder@1.0.0", "reading_file", "succeeded", null, "tsk_4"),
      ev(65_000, "coder@1.0.0", "handoff", "succeeded", null, "tsk_4"),
    ].flatMap((e) => t.observe(e));
    expect(single[0]?.samples).toEqual([{ agent: "coder", kind: "task", durationMs: 65_000 }]);
  });

  test("ranges widen with few samples and guesses follow the model's speed", () => {
    expect(rangeFrom([60_000])).toEqual({ low: 45_000, mid: 60_000, high: 84_000 });
    const many = rangeFrom([50, 60, 70, 80, 90, 100, 110].map((x) => x * 1000));
    expect(many.mid).toBe(80_000);
    expect(many.low).toBeLessThan(many.mid);
    expect(many.high).toBeGreaterThan(many.mid);
    const slow = guessStep("work", { tokensPerSec: 2, ttftMs: 8000 });
    const fast = guessStep("work", { tokensPerSec: 40, ttftMs: 500 });
    expect(slow.mid).toBeGreaterThan(fast.mid * 3);
  });
});

// ---- the service: estimates, persistence, speed -------------------------------------------------

const plan = (over: Partial<Plan> = {}): Plan => ({
  mode: "backend",
  summary: "",
  version: 1,
  approved: true,
  questions: [],
  nodes: [
    {
      id: "db",
      title: "Schema",
      owner: "database",
      deps: [],
      criteria: [],
      review: false,
      status: "todo",
      attempts: 0,
    },
    {
      id: "api",
      title: "API",
      owner: "backend",
      deps: ["db"],
      criteria: [],
      review: true,
      status: "todo",
      attempts: 0,
    },
    {
      id: "ui",
      title: "UI",
      owner: "frontend",
      deps: ["db"],
      criteria: [],
      review: false,
      status: "todo",
      attempts: 0,
    },
    {
      id: "test",
      title: "Tests",
      owner: "testing",
      deps: ["api", "ui"],
      criteria: [],
      review: false,
      status: "todo",
      attempts: 0,
    },
  ],
  ...over,
});

function openDb() {
  const t = tempDir("depo eta");
  const file = path.join(t.dir, "db", "depo.db");
  const open = () => openDatabase({ file, backupsDir: path.join(t.dir, "backups") });
  return { t, open };
}

describe("estimates on this PC", () => {
  test("a first guess before any history, then learned times that survive a restart", () => {
    const { t, open } = openDb();
    cleanup = t.cleanup;
    let db = open();
    let eta = new EtaService({ db: db.db, modelFor: () => "qwen", parallel: () => 2 });

    const first = eta.forTask({ taskId: "tsk_1", mode: "backend", plan: plan() });
    expect(first.basis).toBe("guess");
    expect(first.nodes.every((x) => x.basis === "guess")).toBe(true);
    expect(first.plan?.mid).toBeGreaterThan(0);
    expect(eta.planNote(plan(), 2)).toMatch(/^First guess: about .+ on this PC\. Depo learns real times/);

    for (const [agent, kind, mins] of [
      ["database", "work", 4],
      ["backend", "work", 10],
      ["backend", "fix", 5],
      ["reasoning", "review", 2],
      ["security", "review", 2],
      ["frontend", "work", 8],
      ["testing", "work", 3],
    ] as const) {
      eta.record({ agent, kind, durationMs: mins * MIN, model: "qwen" });
      eta.record({ agent, kind, durationMs: mins * MIN, model: "qwen" });
    }
    eta.record({ agent: "backend", kind: "node", durationMs: 12 * MIN, attempts: 1 });
    const learned = eta.forTask({ taskId: "tsk_1", mode: "backend", plan: plan() });
    expect(learned.basis).toBe("learned");
    const api = learned.nodes.find((x) => x.id === "api");
    // Work (10) + review (2), no send-backs seen for the backend.
    expect(api?.mid).toBe(12 * MIN);
    expect(api?.low).toBeLessThan(api?.mid ?? 0);
    expect(api?.high).toBeGreaterThan(api?.mid ?? 0);
    // db (4) then the slower branch (api 12, ui 8) side by side, then tests (3).
    expect(learned.plan?.mid).toBe(19 * MIN);
    expect(eta.planNote(plan(), 2)).toMatch(/^About .+ on this PC\.$/);
    // One at a time, the two branches add up.
    expect(eta.planEta(plan(), 1).total.mid).toBe(27 * MIN);

    // A restart keeps what was learned.
    db.close();
    db = open();
    eta = new EtaService({ db: db.db, modelFor: () => "qwen", parallel: () => 2 });
    expect(eta.forTask({ taskId: "tsk_1", mode: "backend", plan: plan() }).plan?.mid).toBe(19 * MIN);
    expect(eta.forTask({ taskId: "tsk_1", mode: "backend", plan: plan() }).samples).toBeGreaterThan(10);
    db.close();
  });

  test("borrowed times count as similar; old samples are pruned; history scales with the model's speed", () => {
    const { t, open } = openDb();
    cleanup = t.cleanup;
    const db = open();
    const stats = new ModelCallStats();
    let model = "big";
    const eta = new EtaService({ db: db.db, callStats: stats, modelFor: () => model });
    eta.record({ agent: "backend", kind: "work", durationMs: 10 * MIN, model: "big", tokensPerSec: 4 });
    expect(eta.step("frontend", "work").basis).toBe("similar");
    expect(eta.step("frontend", "fix").basis).toBe("guess");

    for (let i = 0; i < 50; i++) eta.record({ agent: "testing", kind: "work", durationMs: (i + 1) * 1000 });
    const kept = db.sqlite
      .query<{ c: number }, []>("SELECT count(*) AS c FROM eta_samples WHERE agent = 'testing'")
      .get();
    expect(kept?.c).toBe(40);

    // The owner switched to a model twice as fast: the 10 min of history now reads as 5.
    model = "small";
    stats.record({
      ts: new Date().toISOString(),
      providerId: "fake",
      providerKind: "ollama",
      model: "small",
      ok: true,
      error: null,
      errorKind: null,
      promptTokens: 100,
      completionTokens: 80,
      ttftMs: 900,
      durationMs: 1000,
      tokensPerSec: 8,
      projectId: null,
      taskId: null,
      agent: null,
    });
    expect(eta.speedOf("small")).toMatchObject({ tokensPerSec: 8, ttftMs: 900, measured: true });
    expect(eta.step("backend", "work").mid).toBe(5 * MIN);
    expect(eta.speedOf("never-used").measured).toBe(false);
    db.close();
  });

  test("the note says how sure it is", () => {
    const total = { low: 26 * MIN, mid: 30 * MIN, high: 37 * MIN };
    expect(etaNote(total, "learned")).toBe("About 25 to 40 min on this PC.");
    expect(etaNote(total, "mixed")).toBe("About 25 to 40 min on this PC, partly a first guess.");
    expect(etaNote(total, "guess")).toBe(
      "First guess: about 25 to 40 min on this PC. Depo learns real times as tasks finish.",
    );
  });

  test("replay details keep only what the replay needs", () => {
    expect(
      replayDetails(JSON.stringify({ nodeId: "a", kind: "review", chunk: "x".repeat(5000), command: "rm" })),
    ).toEqual({ nodeId: "a", kind: "review" });
    expect(replayDetails("not json")).toBeNull();
    expect(replayDetails(JSON.stringify({ reason: "y".repeat(2000) }))?.reason).toHaveLength(800);
  });
});

// ---- a team run: events for the replay, learning, and the estimate in the approval ---------------

let callId = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c${++callId}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

/** Plans database -> backend -> testing; the backend's work is rejected `reject` times. */
function scripted(reject: number | "always" = 0): ModelProvider {
  const seen = new Map<string, number>();
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    health: async () => ({ ok: true, version: "test" }),
    listModels: async () => [],
    embed: async () => [],
    async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      await Bun.sleep(3);
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      const lastUser = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      let text = "";
      let calls: ToolCall[] = [];
      if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
        text = JSON.stringify({
          summary: "Data, then the API, then tests.",
          nodes: [
            { id: "database", title: "Tasks table", owner: "database", deps: [], criteria: ["schema"] },
            { id: "backend", title: "Tasks API", owner: "backend", deps: ["database"], criteria: ["tests"] },
            {
              id: "testing",
              title: "Run the suite",
              owner: "testing",
              deps: ["backend"],
              criteria: ["pass"],
            },
          ],
          questions: [],
        });
      } else if (/Review the work of the ([\w/ ]+?) agent/.test(lastUser)) {
        const who = /Review the work of the ([\w/ ]+?) agent/.exec(lastUser)?.[1] ?? "";
        const k = (seen.get(who) ?? 0) + 1;
        seen.set(who, k);
        const no = who === "Backend" && (reject === "always" || k <= reject);
        text = JSON.stringify(
          no
            ? {
                verdict: "changes",
                findings: [{ grade: "blocking", text: "No input checks" }],
                confidence: 0.9,
              }
            : { verdict: "approve", findings: [], confidence: 0.9 },
        );
      } else {
        const lastIdx = req.messages.map((m) => m.role).lastIndexOf("user");
        const steps = req.messages.slice(lastIdx).filter((m) => m.role === "tool").length;
        if (steps === 0) calls = [call("write_file", { path: `notes/${callId}.md`, content: "done\n" })];
        else text = "Finished the work.";
      }
      if (text) yield { type: "text", delta: text };
      for (const c of calls) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: calls.length ? "tool_calls" : "stop", usage: null };
    },
  };
}

async function setup(model: ModelProvider, settings: Record<string, boolean | number | string> = {}) {
  const t = tempDir("depo eta run");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: { providerFactory: () => model },
  });
  engine = e;
  const { port } = await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  e.models.assign("reasoning", { providerId: "fake", model: "fake-model" });
  for (const [k, v] of Object.entries({ "team.approve_plan": false, ...settings })) e.settings.set(k, v);
  const proj = path.join(t.dir, "my app");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "app" }));
  const project = await e.projects.open(proj);
  return { e, project, port };
}

describe("a team run on this PC", () => {
  test("its events page out for the replay, it teaches the estimator, and the next plan says how long it takes", async () => {
    const { e, project } = await setup(scripted(1), { "team.reviews": "all" });
    const task = e.tasks.send(project.id, "add a tasks API", undefined, "backend");
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");

    // Pages of 7 add up to every stored event of the task, oldest first, without streamed output.
    const all: { id: string; type: string; details: Record<string, unknown> | null }[] = [];
    let after: number | undefined;
    for (let i = 0; i < 100; i++) {
      const page = e.tasks.teamEvents(task.id, after, 7);
      expect(page.events.length).toBeLessThanOrEqual(7);
      all.push(...page.events);
      if (page.next === null) break;
      after = page.next;
    }
    const stored = e.database.sqlite
      .query<{ c: number }, [string]>(
        "SELECT count(*) AS c FROM events WHERE task_id = ? AND type NOT IN ('command_output','queued','heartbeat')",
      )
      .get(task.id);
    expect(all).toHaveLength(stored?.c ?? -1);
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    const starts = all.filter((x) => x.type === "handoff" && typeof x.details?.nodeId === "string");
    expect(starts.length).toBeGreaterThanOrEqual(6); // a start and an end per task
    expect(all.some((x) => x.type === "decision" && x.details?.kind === "send_back")).toBe(true);

    // The run taught the estimator: the plan's agents now have their own times.
    const eta = e.tasks.teamEta(task.id);
    expect(ApiSchema["team.eta"].result.safeParse(eta).success).toBe(true);
    expect(eta.samples).toBeGreaterThan(0);
    // Database and Testing were never sent back, so their fix time is borrowed from the Backend's.
    expect(eta.nodes.map((x) => [x.id, x.basis])).toEqual([
      ["database", "similar"],
      ["backend", "learned"],
      ["testing", "similar"],
    ]);
    expect(eta.basis).toBe("mixed");
    expect(eta.plan?.mid).toBeGreaterThan(0);

    // The next plan's approval card and chat message carry the estimate.
    e.settings.set("team.approve_plan", true);
    const next = e.tasks.send(project.id, "add a tags API", undefined, "backend");
    const deadline = Date.now() + 15_000;
    while (e.approvals.list().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    const [req] = e.approvals.list();
    expect(req?.reason).toMatch(/on this PC/);
    e.approvals.respond(req?.id ?? "", false);
    await e.tasks.settled(next.id);
    expect(
      e.tasks.get(next.id).messages.some((m) => m.role === "assistant" && /on this PC/.test(m.text)),
    ).toBe(true);
  }, 60_000);

  test("work that cannot run any more is stored as on hold, so a replay shows it", async () => {
    const { e, project, port } = await setup(scripted("always"), { "team.fix_loops": 1 });
    const task = e.tasks.send(project.id, "add a tasks API", undefined, "backend");
    await e.tasks.settled(task.id);
    const page = e.tasks.teamEvents(task.id, undefined, 1000);
    const held = page.events.filter((x) => x.details?.nodeStatus === "blocked");
    expect(held.map((x) => x.details?.nodeId)).toEqual(["testing"]);
    expect(held[0]?.text).toContain("on hold");

    // Over the socket, both methods answer in their schema.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket error"));
    });
    const answers = new Map<number, unknown>();
    await new Promise<void>((res) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (typeof msg.id === "number") answers.set(msg.id, msg.result);
        if (answers.size === 2) res();
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "team.events", params: { taskId: task.id } }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "team.eta", params: { taskId: task.id } }));
    });
    ws.close();
    expect(ApiSchema["team.events"].result.safeParse(answers.get(1)).success).toBe(true);
    expect(ApiSchema["team.eta"].result.safeParse(answers.get(2)).success).toBe(true);
  }, 60_000);
});

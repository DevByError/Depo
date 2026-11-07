import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider, ToolCall } from "@depo/model-gateway";
import { ApiSchema, type DecisionKind, type DepoEvent, type Plan, type RpcResponse } from "@depo/shared";
import {
  adrEntries,
  firstSentences,
  plainText,
  recommendationOf,
  reviewCounts,
  reviewText,
} from "../src/agents/decisions";
import { buildTimeline, type TimelineEvent } from "../src/agents/timeline";
import { createEngine, type Engine } from "../src/engine";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

// ---- pure helpers ---------------------------------------------------------------------------

describe("decision text", () => {
  test("first sentences drop Markdown and code, and stay short", () => {
    expect(firstSentences("**Built** the `tasks` API. Tests pass. Also wrote docs.")).toBe(
      "Built the tasks API. Tests pass.",
    );
    expect(firstSentences("## Done\n```ts\nconst x = 1;\n```\n- Added login")).toBe("Done Added login");
    expect(firstSentences("x".repeat(400)).length).toBeLessThanOrEqual(220);
    expect(plainText("[docs](http://a) <b>bold</b>")).toBe("docs bold");
  });

  test("ADR titles come from headings, or the first sentence when there are none", () => {
    expect(
      adrEntries("## ADR-1: Use SQLite\nNo server needed.\n\n### Decision 2 - Soft delete\nKeeps history."),
    ).toEqual([
      { title: "Use SQLite", body: "No server needed." },
      { title: "Soft delete", body: "Keeps history." },
    ]);
    expect(adrEntries("Use token login. Sessions expire after a day.")[0]?.title).toBe("Use token login.");
    expect(adrEntries("   ")).toEqual([]);
  });

  test("the recommended option is found under a heading, after a label, or in a sentence", () => {
    expect(recommendationOf("## Option A\nx\n## Recommendation\nOption B, a monolith. It is simpler.")).toBe(
      "Option B, a monolith.",
    );
    expect(recommendationOf("Pros and cons...\nRecommendation: go with Postgres.")).toBe("go with Postgres.");
    expect(recommendationOf("After comparing them, I recommend the queue-based design.")).toBe(
      "the queue-based design.",
    );
    expect(recommendationOf("Nothing to see here.")).toBeNull();
  });

  test("review lines carry the verdict, the counts and the top issues", () => {
    const review = {
      verdict: "changes" as const,
      confidence: 0.8,
      findings: [
        { grade: "nice_to_have" as const, text: "Rename x" },
        { grade: "blocking" as const, file: "src/a.ts", line: 4, text: "SQL injection" },
        { grade: "should_fix" as const, text: "Add a test" },
      ],
    };
    expect(reviewText("Security", "Backend API", review)).toBe(
      "Security asked for changes to Backend API (1 blocking, 1 should fix, 1 nice to have)",
    );
    expect(reviewCounts(review).top[0]).toBe("Blocking: src/a.ts:4 SQL injection");
    expect(
      reviewText("Reasoning", "Backend API", {
        verdict: "approve",
        confidence: 1,
        findings: [
          { grade: "should_fix", text: "a" },
          { grade: "should_fix", text: "b" },
        ],
      }),
    ).toBe("Reasoning approved Backend API (0 blocking, 2 should fix)");
  });
});

describe("team timeline", () => {
  const plan: Plan = {
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
        review: true,
        status: "done",
        attempts: 1,
        reviewer: "reasoning",
        startedAt: "2026-11-07T10:00:00.000Z",
        finishedAt: "2026-11-07T10:01:00.000Z",
      },
      {
        id: "api",
        title: "API",
        owner: "backend",
        deps: ["db"],
        criteria: [],
        review: true,
        status: "doing",
        attempts: 2,
        startedAt: "2026-11-07T10:01:00.000Z",
      },
    ],
  };
  const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
    id: `evt_${Math.random().toString(16).slice(2)}`,
    ts: "2026-11-07T10:00:00.000Z",
    agent: "manager@1.0.0",
    type: "decision",
    text: "",
    status: "info",
    details: null,
    ...over,
  });
  const input = {
    taskId: "tsk_1",
    mode: "backend" as const,
    plan,
    waiting: new Set<string>(),
    latest: [
      { agent: "backend@1.0.0", text: "Reading src/app.ts", ts: "2026-11-07T10:01:30.000Z" },
      { agent: "backend@1.0.1", text: "Running bun test", ts: "2026-11-07T10:01:40.000Z" },
    ],
    span: { first: "2026-11-07T09:59:00.000Z", last: "2026-11-07T10:02:00.000Z" },
    manifest: (id: string) => ({ name: id === "backend" ? "Backend" : id, version: "1.0.0" }),
    now: Date.parse("2026-11-07T10:02:00.000Z"),
    events: [
      ev({ text: "Manager planned 2 tasks", details: { kind: "plan", outcome: "custom" } }),
      ev({
        agent: "reasoning@1.0.0",
        type: "reviewing",
        status: "started",
        ts: "2026-11-07T10:00:40.000Z",
        details: { nodeId: "db" },
      }),
      ev({
        agent: "reasoning@1.0.0",
        type: "reviewing",
        status: "succeeded",
        ts: "2026-11-07T10:01:00.000Z",
        details: { nodeId: "db", verdict: "approve" },
      }),
      ev({
        agent: "reasoning@1.0.0",
        text: "Reasoning approved Schema (0 blocking, 0 should fix)",
        details: { kind: "review", nodeId: "db", outcome: "approved", items: [] },
      }),
      ev({ agent: "backend@1.0.0", text: "not a decision", details: { kind: "nonsense" } }),
    ],
  };

  test("agents taking part, their state, progress, time, action and last decision", () => {
    const t = buildTimeline({ ...input, status: "running" });
    expect(t.agents.map((a) => a.id)).toEqual(["manager", "database", "backend", "reasoning"]);
    const by = Object.fromEntries(t.agents.map((a) => [a.id, a]));
    expect(by.manager?.state).toBe("working");
    expect(by.backend?.state).toBe("working");
    expect(by.backend?.action).toBe("Running bun test");
    expect(by.backend?.workMs).toBe(60_000);
    expect(by.database?.done).toBe(1);
    expect(by.database?.workMs).toBe(60_000);
    expect(by.reasoning?.reviews).toBe(1);
    expect(by.reasoning?.workMs).toBe(20_000);
    expect(by.reasoning?.lastDecision?.text).toContain("approved Schema");
    expect(by.manager?.workMs).toBe(180_000);
    // Events whose details are not a decision are left out.
    expect(t.decisions).toHaveLength(2);
  });

  test("a stopped run leaves no one working; the Manager is planning until the plan is approved", () => {
    const stopped = buildTimeline({ ...input, status: "cancelled" });
    expect(stopped.agents.every((a) => a.state === "idle")).toBe(true);
    const planning = buildTimeline({
      ...input,
      status: "running",
      plan: { ...plan, approved: false, nodes: plan.nodes.map((n) => ({ ...n, status: "todo" as const })) },
    });
    expect(planning.agents[0]?.state).toBe("thinking");
  });
});

// ---- a scripted team run --------------------------------------------------------------------

let callId = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `d${++callId}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});
type Reply = { text?: string; calls?: ToolCall[] };

/**
 * Plays the Manager, owners and reviewers. Thinking recommends an option, Database records two
 * ADRs, and the first review of Backend asks for changes (or every review, with `rejectAlways`).
 */
function scriptedTeam(opts: { plan?: "custom" | "broken"; rejectAlways?: boolean } = {}): ModelProvider {
  const backendReviews = { n: 0 };
  const reply = (req: ChatRequest): Reply => {
    const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
    const lastUser = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    if (req.jsonSchema && sys.includes("Plan the work as a task graph")) {
      if (opts.plan === "broken") return { text: "Sorry, no JSON today." };
      return {
        text: JSON.stringify({
          summary: "Brief, options, data, then the API with login, then tests.",
          nodes: [
            {
              id: "brief",
              title: "Business brief",
              owner: "project-management",
              deps: [],
              criteria: ["brief"],
            },
            { id: "options", title: "Pick an approach", owner: "thinking", deps: ["brief"], criteria: [] },
            { id: "database", title: "Tasks schema", owner: "database", deps: ["options"], criteria: [] },
            {
              id: "backend",
              title: "Tasks API with login",
              owner: "backend",
              deps: ["database"],
              criteria: [],
            },
            { id: "testing", title: "Run the suite", owner: "testing", deps: ["backend"], criteria: [] },
          ],
          questions: [],
        }),
      };
    }
    const who = /You are the ([\w/ ]+?) agent\./.exec(sys)?.[1] ?? "";
    const rev = /Review the work of the ([\w/ ]+?) agent\./.exec(lastUser);
    const lastIdx = req.messages.map((m) => m.role).lastIndexOf("user");
    const step = req.messages.slice(lastIdx).filter((m) => m.role === "tool").length;
    if (rev) {
      if (step === 0) return { calls: [call("list_dir", { path: "." })] };
      if (rev[1] === "Backend") {
        backendReviews.n++;
        const reject = opts.rejectAlways || backendReviews.n === 1;
        return {
          text: JSON.stringify(
            reject
              ? {
                  verdict: "changes",
                  findings: [
                    {
                      grade: "blocking",
                      file: "src/app.ts",
                      line: 1,
                      text: "Passwords are stored in plain text",
                    },
                    { grade: "should_fix", text: "Validate the email" },
                  ],
                  confidence: 0.9,
                }
              : {
                  verdict: "approve",
                  findings: [
                    { grade: "should_fix", text: "Validate the email" },
                    { grade: "nice_to_have", text: "Add a README line" },
                  ],
                  confidence: 0.8,
                },
          ),
        };
      }
      return { text: JSON.stringify({ verdict: "approve", findings: [], confidence: 0.9 }) };
    }
    const fix = lastUser.includes("found blocking problems");
    const script: Record<string, Reply[]> = {
      "Project Management": [
        { calls: [call("bb_write", { section: "brief.md", content: "Problem: tasks are scattered." })] },
        { text: "Wrote the brief with three user stories. The MVP covers tasks and login." },
      ],
      Thinking: [
        {
          calls: [
            call("bb_write", {
              section: "options.md",
              content:
                "## Option A: Serverless\nCheap but hard to run locally.\n\n## Option B: Modular monolith\nSimple.\n\n## Recommendation\nOption B, a modular monolith with FastAPI. It runs with one command.",
            }),
          ],
        },
        { text: "Compared two approaches and wrote options.md." },
      ],
      Database: [
        {
          calls: [
            call("write_file", {
              path: "db/schema.sql",
              content: "create table tasks (id integer primary key);\n",
            }),
          ],
        },
        {
          calls: [
            call("bb_write", {
              section: "decisions.md",
              content:
                "## ADR-1: Use SQLite for development\nIt runs without a server.\n\n## ADR-2: Soft delete tasks\nKeeps history.",
              mode: "append",
            }),
          ],
        },
        { text: "Created the tasks table. Chose SQLite for development. Seed data is in db/seed.sql." },
      ],
      Backend: fix
        ? [
            {
              calls: [
                call("write_file", {
                  path: "src/app.ts",
                  content: "export const hash = (p: string) => p.length;\n",
                }),
              ],
            },
            { text: "Hashed the passwords before storing them." },
          ]
        : [
            {
              calls: [
                call("write_file", {
                  path: "src/app.ts",
                  content: "export const login = (p: string) => p;\n",
                }),
              ],
            },
            { text: "Built the tasks API with login. Routes follow openapi.yaml." },
          ],
      Testing: [
        { calls: [call("run_command", { command: "bun test" })] },
        { text: "The whole suite passes." },
      ],
      Security: [{ text: "Audit done: nothing blocking." }],
      "DevOps and Documentation": [{ text: "Documented the endpoints in the README." }],
    };
    const mine = script[who] ?? [{ text: `${who}: done.` }];
    return mine[Math.min(step, mine.length - 1)] as Reply;
  };
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    async health() {
      return { ok: true, version: "fake", message: null };
    },
    async listModels() {
      return [];
    },
    async embed(_m, inputs) {
      return inputs.map(() => [0]);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const r = reply(req);
      if (r.text) yield { type: "text", delta: r.text };
      for (const c of r.calls ?? []) yield { type: "tool_call", call: c };
      yield { type: "done", finishReason: r.calls?.length ? "tool_calls" : "stop", usage: null };
    },
  };
}

async function setup(model: ModelProvider, settings: Record<string, boolean | number | string> = {}) {
  const t = tempDir("depo decisions");
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
  const proj = path.join(t.dir, "todo app");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "todo", scripts: { test: "bun test" } }),
  );
  fs.writeFileSync(
    path.join(proj, "src", "app.test.ts"),
    'import { expect, test } from "bun:test";\ntest("works", () => expect(1 + 1).toBe(2));\n',
  );
  const project = await e.projects.open(proj);
  const decisions: DepoEvent[] = [];
  e.bus.subscribe((ev) => {
    if (ev.type === "decision") decisions.push(ev);
  });
  return { e, project, port, decisions };
}

const kindOf = (ev: DepoEvent) => ev.details?.kind as DecisionKind;
const of = (list: DepoEvent[], kind: DecisionKind) => list.filter((d) => kindOf(d) === kind);

async function rpc(port: number, method: string, params: unknown): Promise<RpcResponse> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket error"));
  });
  const out = await new Promise<RpcResponse>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === 1) res(msg);
    };
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  ws.close();
  return out;
}

describe("decision events from a team run", () => {
  test("plan, approval, results, recommendation, ADRs, reviews, send-back and release, readable in team.timeline", async () => {
    const { e, project, port, decisions } = await setup(scriptedTeam(), { "team.approve_plan": true });
    const task = e.tasks.send(project.id, "a todo app with login", undefined, "full");
    const deadline = Date.now() + 15_000;
    while (e.approvals.list().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    const [req] = e.approvals.list();
    e.approvals.respond(req?.id ?? "", true);
    await e.tasks.settled(task.id);
    expect(e.tasks.get(task.id).task.status).toBe("review");

    // Manager: the plan it chose, with the agents and why.
    const [plan] = of(decisions, "plan");
    expect(plan?.agent.startsWith("manager@")).toBe(true);
    expect(plan?.text).toBe("Manager planned 5 tasks for 5 agents");
    expect(plan?.details?.outcome).toBe("custom");
    expect(String(plan?.details?.reason)).toContain("Left out");
    expect(plan?.details?.items).toContain("Backend: Tasks API with login");

    expect(of(decisions, "plan_approval")[0]?.text).toBe("Plan approved by you. 5 tasks start now.");

    // Owners at handoff: their own words and the files they wrote.
    const results = of(decisions, "result");
    const db = results.find((d) => d.agent.startsWith("database@"));
    expect(db?.text).toBe("Database: Created the tasks table. Chose SQLite for development.");
    expect(db?.details?.items).toEqual(["db/schema.sql"]);
    expect(db?.details?.nodeId).toBe("database");
    expect(results.filter((d) => d.agent.startsWith("backend@")).map((d) => d.text)).toEqual([
      "Backend: Built the tasks API with login. Routes follow openapi.yaml.",
      "Backend: Hashed the passwords before storing them.",
    ]);

    // Thinking: the option it recommends.
    expect(of(decisions, "recommendation")[0]?.text).toBe(
      "Thinking recommends: Option B, a modular monolith with FastAPI.",
    );

    // Architecture decisions written to decisions.md, one per ADR.
    expect(of(decisions, "adr").map((d) => d.text)).toEqual([
      "Database decided: Use SQLite for development",
      "Database decided: Soft delete tasks",
    ]);

    // Reviewers: a verdict per review with counts and the top issues.
    const reviews = of(decisions, "review");
    const backendReviews = reviews.filter((d) => d.details?.nodeId === "backend");
    expect(backendReviews.map((d) => d.text)).toEqual([
      "Security asked for changes to Tasks API with login (1 blocking, 1 should fix)",
      "Security approved Tasks API with login (0 blocking, 1 should fix, 1 nice to have)",
    ]);
    expect(backendReviews[0]?.details?.items).toEqual([
      "Blocking: src/app.ts:1 Passwords are stored in plain text",
      "Should fix: Validate the email",
    ]);
    expect(reviews.some((d) => d.text === "Reasoning approved Tasks schema (0 blocking, 0 should fix)")).toBe(
      true,
    );

    // Manager: sent back once, then the release verdict.
    const back = of(decisions, "send_back");
    expect(back).toHaveLength(1);
    expect(back[0]?.text).toBe("Manager sent Tasks API with login back to Backend (attempt 2 of 5)");
    const release = of(decisions, "release");
    expect(release).toHaveLength(1);
    expect(release[0]?.details?.outcome).toBe("ready");
    expect(release[0]?.text).toContain("ready for your review (all 5 tasks done");
    expect(of(decisions, "escalate")).toHaveLength(0);

    // The order tells the story.
    const order = decisions.map(kindOf);
    expect(order[0]).toBe("plan");
    // The release call, then the readiness verdict once the change set is ready.
    expect(order.at(-2)).toBe("release");
    expect(order.at(-1)).toBe("readiness");
    const [ready] = of(decisions, "readiness");
    expect(ready?.agent.startsWith("manager@")).toBe(true);
    expect(String(release[0]?.text)).toContain("Readiness: ");
    expect(order.indexOf("send_back")).toBeGreaterThan(order.indexOf("review"));

    // team.timeline over the real socket matches its schema and agrees with the events.
    const res = await rpc(port, "team.timeline", { taskId: task.id });
    if ("error" in res) throw new Error(res.error.message);
    const parsed = ApiSchema["team.timeline"].result.safeParse(res.result);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const t = parsed.data;
    expect(t.status).toBe("review");
    expect(t.decisions.map((d) => d.id)).toEqual(decisions.map((d) => d.id));
    // The Manager leads; the rest follow plan order, which the production bar may reshuffle.
    expect(t.agents[0]?.id).toBe("manager");
    expect(t.agents.map((a) => a.id).sort()).toEqual(
      [
        "manager",
        "project-management",
        "thinking",
        "database",
        "backend",
        "testing",
        "reasoning",
        "security",
      ].sort(),
    );
    const by = Object.fromEntries(t.agents.map((a) => [a.id, a]));
    expect(by.backend).toMatchObject({ done: 1, total: 1, state: "idle" });
    expect(by.backend?.lastDecision?.text).toBe("Backend: Hashed the passwords before storing them.");
    expect(by.security?.reviews).toBe(2);
    expect(by.reasoning?.reviews).toBe(4);
    expect(by.manager?.lastDecision?.kind).toBe("readiness");
    expect(by.database?.action).toBeTruthy();
    expect(t.agents.every((a) => a.workMs >= 0)).toBe(true);
    // The Manager's time is the run's span, from the first event to the last.
    expect(by.manager?.workMs).toBeGreaterThan(0);
  }, 60_000);

  test("loop limit: the Manager escalates, the release verdict says work is unfinished; a broken plan falls back", async () => {
    const { e, project, decisions } = await setup(scriptedTeam({ plan: "broken", rejectAlways: true }), {
      "team.fix_loops": 2,
    });
    const task = e.tasks.send(project.id, "add task lists with login", undefined, "backend");
    await e.tasks.settled(task.id);

    const [plan] = of(decisions, "plan");
    expect(plan?.details?.outcome).toBe("standard");
    expect(plan?.text).toContain("standard Backend only steps: 5 tasks");
    expect(String(plan?.details?.reason)).toContain("could not be read");

    const esc = of(decisions, "escalate");
    expect(esc).toHaveLength(1);
    expect(esc[0]?.details?.outcome).toBe("loop_limit");
    expect(esc[0]?.text).toContain("after 2 attempts and needs your call");
    expect(esc[0]?.details?.items).toEqual(["Blocking: src/app.ts:1 Passwords are stored in plain text"]);
    expect(of(decisions, "send_back")).toHaveLength(1);

    const [release] = of(decisions, "release");
    expect(release?.details?.outcome).toBe("unfinished");
    // A reviewer's rejection is still open, so the readiness verdict says not ready.
    expect(release?.text).toBe(
      "Manager: 1 of 5 tasks finished, so review the changes with care. Readiness: not ready",
    );
    expect(release?.details?.readiness).toBe("not_ready");
    const [ready] = of(decisions, "readiness");
    expect(ready?.details?.outcome).toBe("not_ready");
    expect(ready?.text).toMatch(/^Not ready: a reviewer still asks for changes/);

    const t = e.tasks.teamTimeline(task.id);
    expect(t.agents.find((a) => a.id === "backend")?.state).toBe("blocked");
    expect(t.agents.find((a) => a.id === "manager")?.state).toBe("idle");
  }, 60_000);

  test("declining the plan is recorded as the user's decision", async () => {
    const { e, project, decisions } = await setup(scriptedTeam(), { "team.approve_plan": true });
    const task = e.tasks.send(project.id, "add task lists", undefined, "backend");
    const deadline = Date.now() + 15_000;
    while (e.approvals.list().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    // While the plan waits, the Manager shows as waiting in the team view.
    expect(e.tasks.teamTimeline(task.id).agents[0]).toMatchObject({ id: "manager", state: "waiting" });
    e.approvals.respond(e.approvals.list()[0]?.id ?? "", false);
    await e.tasks.settled(task.id);
    const approval = of(decisions, "plan_approval");
    expect(approval.map((d) => [d.text, d.details?.outcome])).toEqual([
      ["Plan declined by you. Nothing was built.", "declined"],
    ]);
    expect(of(decisions, "release")).toHaveLength(0);
  }, 60_000);
});

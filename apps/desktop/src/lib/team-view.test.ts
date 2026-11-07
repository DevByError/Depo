import type { DepoEvent, PlanNode, TeamDecision } from "@depo/shared";
import { expect, test } from "vitest";
import {
  atBottom,
  decisionFromEvent,
  decisionLabel,
  decisionTone,
  liveTeam,
  mergeDecisions,
  refreshKey,
  reviewState,
  type TimelineResult,
  teamTotals,
} from "./team-view";

let seq = 0;
const ev = (over: Partial<DepoEvent>): DepoEvent => ({
  id: `evt_${String(++seq).padStart(28, "0")}`,
  ts: `2026-11-07T10:00:${String(seq).padStart(2, "0")}.000Z`,
  seq,
  projectId: "prj_1",
  taskId: "tsk_1",
  agent: "backend@1.0.0",
  type: "reading_file",
  text: "",
  details: null,
  durationMs: null,
  status: "info",
  ephemeral: false,
  ...over,
});

const decision = (over: Partial<TeamDecision>): TeamDecision => ({
  id: "evt_a",
  ts: "2026-11-07T10:00:00.000Z",
  agent: "manager",
  tag: "manager@1.0.0",
  kind: "plan",
  text: "Manager planned 2 tasks",
  outcome: "custom",
  reason: null,
  nodeId: null,
  items: [],
  ...over,
});

const snapshot = (): TimelineResult => ({
  taskId: "tsk_1",
  mode: "backend",
  status: "running",
  plan: null,
  decisions: [decision({})],
  agents: [
    {
      id: "backend",
      name: "Backend",
      version: "1.0.0",
      state: "working",
      nodeId: "api",
      action: "Reading src/app.ts",
      actionAt: "2026-11-07T10:00:00.000Z",
      done: 0,
      total: 1,
      reviews: 0,
      workMs: 5_000,
      lastDecision: null,
    },
    {
      id: "reasoning",
      name: "Reasoning",
      version: "1.0.0",
      state: "idle",
      nodeId: null,
      action: null,
      actionAt: null,
      done: 0,
      total: 0,
      reviews: 0,
      workMs: 0,
      lastDecision: null,
    },
  ],
});

test("decision events become timeline entries; other events and bad details do not", () => {
  const d = decisionFromEvent(
    ev({
      type: "decision",
      agent: "security@1.0.0",
      text: "Security approved API (0 blocking, 1 should fix)",
      details: { kind: "review", outcome: "approved", nodeId: "api", items: ["Should fix: x"], blocking: 0 },
    }),
  );
  expect(d).toMatchObject({ agent: "security", kind: "review", nodeId: "api", items: ["Should fix: x"] });
  expect(decisionFromEvent(ev({ type: "handoff" }))).toBeNull();
  expect(decisionFromEvent(ev({ type: "decision", details: { kind: "nope" } }))).toBeNull();
});

test("live decisions merge into the snapshot once, in time order", () => {
  const a = decision({ id: "evt_1", ts: "2026-11-07T10:00:01.000Z" });
  const b = decision({ id: "evt_2", ts: "2026-11-07T10:00:02.000Z" });
  const c = decision({ id: "evt_3", ts: "2026-11-07T10:00:02.000Z" });
  expect(mergeDecisions([a, b], [b])).toEqual([a, b]);
  expect(mergeDecisions([a, c], [b]).map((d) => d.id)).toEqual(["evt_1", "evt_2", "evt_3"]);
});

test("newer actions, decisions and the model's live line update the agents", () => {
  const t = snapshot();
  const events = [
    ev({ agent: "backend@1.0.0", type: "running_command", text: "Running bun test" }),
    ev({
      type: "decision",
      agent: "backend@1.0.0",
      text: "Backend: Built the API.",
      details: { kind: "result", nodeId: "api", outcome: "submitted" },
    }),
    ev({ agent: "backend@1.0.0", type: "thinking", text: "Now I will add the route", ephemeral: true }),
  ];
  const fetchedAt = 1_000;
  const live = liveTeam(t, events, fetchedAt, fetchedAt + 3_000);
  const be = live.agents.find((a) => a.id === "backend");
  expect(be?.action).toBe("Running bun test");
  expect(be?.actionType).toBe("running_command");
  expect(be?.state).toBe("thinking");
  expect(be?.thought).toBe("Now I will add the route");
  expect(be?.lastDecision?.text).toBe("Backend: Built the API.");
  expect(be?.workMs).toBe(8_000);
  expect(live.decisions).toHaveLength(2);
  // Idle agents do not count time, and an older event does not replace a newer snapshot action.
  const rs = live.agents.find((a) => a.id === "reasoning");
  expect(rs?.workMs).toBe(0);
  const old = liveTeam(t, [ev({ ts: "2026-11-07T09:00:00.000Z", text: "old" })], fetchedAt, fetchedAt);
  expect(old.agents[0]?.action).toBe("Reading src/app.ts");
});

test("a finished run neither counts time nor shows anyone thinking", () => {
  const t = { ...snapshot(), status: "review" as const };
  const live = liveTeam(t, [ev({ type: "thinking", ephemeral: true, text: "x" })], 0, 60_000);
  expect(live.agents[0]?.workMs).toBe(5_000);
  expect(live.agents[0]?.state).toBe("working");
  expect(live.agents[0]?.thought).toBeNull();
});

test("only events that change the team picture trigger a refresh", () => {
  const handoff = ev({ type: "handoff" });
  expect(refreshKey([handoff, ev({ type: "reading_file" }), ev({ type: "thinking", ephemeral: true })])).toBe(
    handoff.id,
  );
  const plan = ev({ type: "planning", ephemeral: true, details: { planUpdate: true } });
  expect(refreshKey([handoff, plan])).toBe(plan.id);
  expect(refreshKey([ev({ type: "reading_file" })])).toBeNull();
});

test("tones and labels say what a decision means", () => {
  expect(decisionTone({ kind: "review", outcome: "changes" })).toBe("warning");
  expect(decisionTone({ kind: "review", outcome: "approved" })).toBe("success");
  expect(decisionTone({ kind: "escalate", outcome: "loop_limit" })).toBe("danger");
  expect(decisionTone({ kind: "release", outcome: "blocked" })).toBe("danger");
  expect(decisionTone({ kind: "release", outcome: "ready" })).toBe("success");
  expect(decisionLabel({ kind: "review", outcome: "changes" })).toBe("Changes asked");
  expect(decisionLabel({ kind: "plan", outcome: "standard" })).toBe("Standard plan");
  expect(decisionLabel({ kind: "plan", outcome: "replanned" })).toBe("Plan changed");
  expect(decisionLabel({ kind: "recommendation", outcome: null })).toBe("Recommends");
});

test("review state of a task in the graph", () => {
  const node: PlanNode = {
    id: "api",
    title: "API",
    owner: "backend",
    deps: [],
    criteria: [],
    review: true,
    status: "review",
    attempts: 1,
    reviewer: "security",
  };
  const name = (id: string) => (id === "security" ? "Security" : id);
  expect(reviewState(node, name)).toBe("Security reviewing");
  expect(reviewState({ ...node, status: "done" }, name)).toBe("Approved by Security");
  expect(reviewState({ ...node, status: "doing", attempts: 2 }, name)).toBe("Changes asked by Security");
  expect(reviewState({ ...node, review: false }, name)).toBeNull();
});

test("totals and the bottom check", () => {
  const live = liveTeam(snapshot(), [], 0, 0);
  expect(teamTotals(live)).toMatchObject({ busy: 1, agents: 2, decisions: 1, total: 0 });
  expect(atBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  expect(atBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
});

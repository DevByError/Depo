import type { TeamEvent } from "@depo/shared";
import { describe, expect, test } from "vitest";
import {
  advance,
  buildIndex,
  countAt,
  extendIndex,
  GAP_CAP,
  replayFromStart,
  STRIDE,
  stateAt,
  stepEvent,
  stepMarker,
  teamAt,
} from "./team-replay";
import type { TimelineResult } from "./team-view";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
let n = 0;
const ev = (
  at: number,
  agent: string,
  type: string,
  status: string,
  details: TeamEvent["details"] = null,
  text = type,
) => {
  n++;
  return {
    id: `evt_${n.toString(16).padStart(28, "0")}`,
    ts: new Date(T0 + at).toISOString(),
    agent,
    type,
    text,
    status,
    details,
  } satisfies TeamEvent;
};

/**
 * A backend run: plan, approval wait, database (approved), backend (sent back once, then approved
 * by Security), testing blocked after an escalation, with `noise` file reads per step so the run
 * crosses several checkpoints.
 */
function run(noise = 0): TeamEvent[] {
  n = 0;
  const out: TeamEvent[] = [];
  let t = 0;
  const at = (ms: number) => {
    t += ms;
    return t;
  };
  const reads = (agent: string) => {
    for (let i = 0; i < noise; i++)
      out.push(ev(at(150), agent, "reading_file", "succeeded", null, `Reading src/f${i}.ts`));
  };
  out.push(ev(at(0), "manager@1.0.0", "planning", "started", null, "Manager is planning the work"));
  out.push(ev(at(4000), "manager@1.0.0", "planning", "succeeded", { plan: true, nodes: 3 }, "Plan ready"));
  out.push(
    ev(
      at(10),
      "manager@1.0.0",
      "decision",
      "succeeded",
      { kind: "plan", outcome: "custom" },
      "Manager planned 3 tasks",
    ),
  );
  out.push(
    ev(at(10), "manager@1.0.0", "waiting_for_user", "started", { approvalId: "req_1" }, "Start this plan?"),
  );
  out.push(ev(at(30_000), "user", "info", "succeeded", { approvalId: "req_1", approved: true }, "Approved"));
  out.push(
    ev(
      at(10),
      "manager@1.0.0",
      "decision",
      "succeeded",
      { kind: "plan_approval", outcome: "approved" },
      "Plan approved",
    ),
  );
  out.push(
    ev(
      at(10),
      "manager@1.0.0",
      "handoff",
      "started",
      { nodeId: "database", to: "database" },
      "Manager → Database",
    ),
  );
  reads("database@1.0.0");
  out.push(
    ev(at(2000), "reasoning@1.0.0", "reviewing", "started", { nodeId: "database" }, "Reasoning is reviewing"),
  );
  out.push(
    ev(at(3000), "reasoning@1.0.0", "reviewing", "succeeded", { nodeId: "database", verdict: "approve" }),
  );
  out.push(
    ev(
      at(5),
      "reasoning@1.0.0",
      "decision",
      "succeeded",
      { kind: "review", outcome: "approved", nodeId: "database" },
      "Reasoning approved Tasks table",
    ),
  );
  out.push(
    ev(
      at(5),
      "database@1.0.0",
      "handoff",
      "succeeded",
      { nodeId: "database", status: "done" },
      "Database finished",
    ),
  );
  out.push(
    ev(
      at(10),
      "manager@1.0.0",
      "handoff",
      "started",
      { nodeId: "backend", to: "backend" },
      "Manager → Backend",
    ),
  );
  reads("backend@1.0.0");
  out.push(ev(at(2000), "security@1.0.0", "reviewing", "started", { nodeId: "backend" }));
  out.push(ev(at(4000), "security@1.0.0", "reviewing", "failed", { nodeId: "backend", verdict: "changes" }));
  out.push(
    ev(
      at(5),
      "security@1.0.0",
      "decision",
      "failed",
      { kind: "review", outcome: "changes", nodeId: "backend" },
      "Security asked for changes",
    ),
  );
  out.push(
    ev(
      at(5),
      "manager@1.0.0",
      "decision",
      "running",
      { kind: "send_back", nodeId: "backend", attempt: 2 },
      "Sent back",
    ),
  );
  out.push(ev(at(5), "backend@1.0.0", "retrying", "running", null, "Security asked for changes"));
  reads("backend@1.0.0");
  out.push(ev(at(60_000), "backend@1.0.0", "error", "failed", null, "Backend failed: model went away"));
  out.push(
    ev(
      at(5),
      "manager@1.0.0",
      "decision",
      "failed",
      { kind: "escalate", nodeId: "backend", outcome: "error" },
      "Manager stopped Tasks API",
    ),
  );
  out.push(
    ev(
      at(5),
      "backend@1.0.0",
      "handoff",
      "failed",
      { nodeId: "backend", status: "failed" },
      "Backend could not finish",
    ),
  );
  out.push(
    ev(
      at(5),
      "manager@1.0.0",
      "planning",
      "info",
      { nodeId: "testing", nodeStatus: "blocked" },
      "Run the suite is on hold",
    ),
  );
  out.push(
    ev(
      at(5),
      "manager@1.0.0",
      "decision",
      "info",
      { kind: "release", outcome: "unfinished" },
      "Manager: 1 of 3 tasks finished",
    ),
  );
  out.push(ev(at(100), "manager@1.0.0", "handoff", "succeeded", null, "Changes ready for review"));
  return out;
}

const plan = (status: Record<string, string> = {}) =>
  ({
    mode: "backend" as const,
    summary: "",
    version: 1,
    approved: true,
    questions: [],
    nodes: [
      {
        id: "database",
        title: "Tasks table",
        owner: "database" as const,
        deps: [],
        criteria: [],
        review: true,
        status: status.database ?? "done",
        attempts: 1,
        reviewer: "reasoning" as const,
      },
      {
        id: "backend",
        title: "Tasks API",
        owner: "backend" as const,
        deps: ["database"],
        criteria: [],
        review: true,
        status: status.backend ?? "failed",
        attempts: 2,
        reviewer: "security" as const,
        note: "Model went away",
      },
      {
        id: "testing",
        title: "Run the suite",
        owner: "testing" as const,
        deps: ["backend"],
        criteria: [],
        review: false,
        status: status.testing ?? "blocked",
        attempts: 0,
      },
    ],
  }) as TimelineResult["plan"];

const agent = (id: string, name: string) => ({
  id,
  name,
  version: "1.0.0",
  state: "idle" as const,
  nodeId: null,
  action: null,
  actionAt: null,
  done: 0,
  total: 0,
  reviews: 0,
  workMs: 0,
  lastDecision: null,
});

const snapshot = (over: Partial<TimelineResult> = {}): TimelineResult =>
  ({
    taskId: "tsk_1",
    mode: "backend",
    status: "review",
    plan: plan(),
    agents: [
      agent("manager", "Manager"),
      agent("database", "Database"),
      agent("backend", "Backend"),
      agent("testing", "Testing"),
      agent("reasoning", "Reasoning"),
      agent("security", "Security"),
    ],
    decisions: [],
    ...over,
  }) as TimelineResult;

describe("replay reducer", () => {
  test("seeking to any moment gives the same state as replaying from the start", () => {
    const events = run(400); // ~1,230 events: several checkpoints
    const index = buildIndex(events);
    expect(index.events.length).toBeGreaterThan(STRIDE * 5);
    expect(index.checkpoints.length).toBe(Math.floor(index.events.length / STRIDE) + 1);
    const moments = [
      index.start - 1000,
      index.start,
      index.end,
      index.end + 5000,
      ...index.times.filter((_, i) => i % 97 === 0),
      ...Array.from({ length: 40 }, (_, i) => index.start + ((index.end - index.start) * (i + 0.5)) / 40),
    ];
    for (const t of moments) expect(stateAt(index, t)).toEqual(replayFromStart(events, t));
  });

  test("tasks move through doing, review, send-back, failure and hold; agents and approvals follow", () => {
    const events = run(3);
    const index = buildIndex(events);
    const time = (text: string) => index.events.find((e) => e.text === text)?.t ?? Number.NaN;

    const waiting = stateAt(index, time("Start this plan?"));
    expect(waiting.waiting).toEqual({ req_1: "manager" });
    expect(waiting.nodes).toEqual({});
    expect(stateAt(index, time("Approved")).waiting).toEqual({});

    const db = stateAt(index, time("Manager → Database"));
    expect(db.nodes.database).toMatchObject({ status: "doing", attempts: 1 });
    expect(db.started).toBe(true);
    expect(stateAt(index, time("Reasoning is reviewing")).nodes.database).toMatchObject({
      status: "review",
      reviewer: "reasoning",
    });

    const sent = stateAt(index, time("Sent back"));
    expect(sent.nodes.backend).toMatchObject({ status: "doing", attempts: 2, reviewer: "security" });
    expect(sent.agents.security?.reviews).toBe(1);
    expect(sent.agents.security?.reviewMs).toBe(4000);

    const end = stateAt(index, index.end);
    expect(end.nodes.database?.status).toBe("done");
    expect(end.nodes.backend?.status).toBe("failed");
    expect(end.nodes.testing?.status).toBe("blocked");
    expect(end.decisions).toBe(index.decisions.length);
    expect(end.agents.backend?.action).toBe("Backend could not finish");
  });

  test("markers mark decisions, approvals, change requests, send-backs and problems by kind", () => {
    const index = buildIndex(run(0));
    expect(index.markers.map((m) => [m.kind, m.tone])).toEqual([
      ["decision", "accent"], // plan
      ["decision", "success"], // plan approved
      ["review", "success"],
      ["changes", "warning"],
      ["send_back", "warning"],
      ["error", "danger"], // error event
      ["error", "danger"], // escalation
      ["decision", "warning"], // release, unfinished
    ]);
  });

  test("live events extend the index to the same result as building it at once; late events rebuild it", () => {
    const events = run(250);
    const whole = buildIndex(events);
    let live = buildIndex(events.slice(0, 100));
    for (let i = 100; i < events.length; i += 37) live = extendIndex(live, events.slice(i, i + 37));
    expect(live.times).toEqual(whole.times);
    expect(live.decisions).toEqual(whole.decisions);
    expect(live.markers).toEqual(whole.markers);
    expect(live.checkpoints).toEqual(whole.checkpoints);
    expect(stateAt(live, whole.end)).toEqual(stateAt(whole, whole.end));

    // An event older than the newest one (a late arrival) still lands in time order.
    const [late, ...rest] = events.slice(-30);
    const out = extendIndex(extendIndex(buildIndex(events.slice(0, -30)), rest), late ? [late] : []);
    expect(out.times).toEqual(whole.times);
    expect(stateAt(out, whole.end)).toEqual(stateAt(whole, whole.end));
  });

  test("playing cuts quiet stretches short; stepping goes event by event or key moment by key moment", () => {
    const index = buildIndex(run(0));
    const approved = index.events.find((e) => e.text === "Approved")?.t ?? 0;
    const asked = index.events.find((e) => e.text === "Start this plan?")?.t ?? 0;
    // A 30 s wait for the approval plays as GAP_CAP of run time.
    expect(advance(index, asked, 100)).toBe(approved - GAP_CAP + 100);
    expect(advance(index, index.end - 50, 100)).toBe(index.end);

    expect(stepEvent(index, asked, 1)).toBe(approved);
    expect(stepEvent(index, approved, -1)).toBe(asked);
    expect(stepEvent(index, index.start, -1)).toBe(index.start);
    expect(stepEvent(index, index.end, 1, index.end + 999)).toBe(index.end + 999);
    const first = index.markers[0]?.t ?? 0;
    const second = index.markers[1]?.t ?? 0;
    expect(stepMarker(index, index.start - 1, 1)).toBe(first);
    expect(stepMarker(index, first, 1)).toBe(second);
    expect(stepMarker(index, second, -1)).toBe(first);
    expect(countAt(index, index.end)).toBe(index.events.length);
  });
});

describe("the Team screen at a moment", () => {
  test("the graph, the agents and the decisions are rebuilt for the moment picked", () => {
    const index = buildIndex(run(2));
    const t =
      index.events.find((e) => e.text === "Security asked for changes" && e.type === "decision")?.t ?? 0;
    const view = teamAt(snapshot(), index, { t, live: false });
    expect(view.status).toBe("running");
    expect(view.plan?.nodes.map((x) => [x.id, x.status, x.attempts])).toEqual([
      ["database", "done", 1],
      ["backend", "review", 1],
      ["testing", "todo", 0],
    ]);
    expect(view.plan?.nodes[2]?.reviewer).toBeUndefined();
    expect(view.decisions.map((d) => d.kind)).toEqual(["plan", "plan_approval", "review", "review"]);
    const byId = Object.fromEntries(view.agents.map((a) => [a.id, a]));
    expect(byId.security?.state).toBe("thinking");
    expect(byId.security?.lastDecision?.text).toBe("Security asked for changes");
    expect(byId.database?.state).toBe("idle");
    expect(byId.database?.done).toBe(1);
    expect(byId.manager?.state).toBe("working");
    expect(byId.manager?.workMs).toBe(t - index.start);

    // Before the plan was approved, the Manager waits for you and nothing has started.
    const early = teamAt(snapshot(), index, {
      t: index.events.find((e) => e.text === "Start this plan?")?.t ?? 0,
      live: false,
    });
    expect(early.status).toBe("waiting");
    expect(early.agents.find((a) => a.id === "manager")?.state).toBe("waiting");
    expect(early.plan?.nodes.every((x) => x.status === "todo")).toBe(true);
  });

  test("at the live edge the saved plan has the last word for a finished run or a task no event mentions", () => {
    const events = run(0).filter((e) => e.details?.nodeStatus !== "blocked"); // an older run: no on-hold line
    const index = buildIndex(events);
    const done = teamAt(snapshot(), index, { t: index.end, live: true });
    expect(done.plan?.nodes.map((x) => x.status)).toEqual(["done", "failed", "blocked"]);
    expect(done.agents.every((a) => a.state === "idle" || a.state === "blocked")).toBe(true);
    // The same moment picked on the strip shows what the events say.
    const picked = teamAt(snapshot(), index, { t: index.end, live: false });
    expect(picked.plan?.nodes.map((x) => x.status)).toEqual(["done", "failed", "todo"]);

    // A running task: events lead, the snapshot fills in tasks the events never mentioned.
    const running = teamAt(
      snapshot({ status: "running", plan: plan({ testing: "doing" }) }),
      buildIndex(events.slice(0, 12)),
      { t: index.end, live: true },
    );
    expect(running.plan?.nodes.map((x) => x.status)).toEqual(["done", "doing", "doing"]);
  });
});

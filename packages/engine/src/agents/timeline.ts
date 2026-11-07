import {
  AGENT_IDS,
  type AgentId,
  type AgentState,
  DecisionDetailsSchema,
  type JsonValue,
  type Plan,
  type TaskStatus,
  type TeamAgentStat,
  type TeamDecision,
  type TeamEvent,
  type TeamTimeline,
  type WorkMode,
} from "@depo/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db";
import { events as eventsTable } from "../db/schema";
import { agentStatuses } from "./team";

/** A stored event, as much of it as the team view needs. */
export interface TimelineEvent {
  id: string;
  ts: string;
  agent: string;
  type: string;
  text: string;
  status: string;
  details: Record<string, JsonValue> | null;
}

export interface TimelineInput {
  taskId: string;
  mode: WorkMode;
  status: TaskStatus;
  plan: Plan | null;
  /** Agents waiting for the user (an open approval). */
  waiting: Set<string>;
  /** The task's decision, reviewing and planning events, oldest first. */
  events: TimelineEvent[];
  /** The newest event of each agent tag that is not a decision (what it did last). */
  latest: { agent: string; text: string; ts: string }[];
  /** First and last stored event of the task (the run's span). */
  span: { first: string | null; last: string | null };
  manifest(id: AgentId): { name: string; version: string };
  now: number;
}

const ACTIVE: TaskStatus[] = ["queued", "running", "waiting"];

/** `backend@1.0.0` -> `backend`, or null for engine/user and unknown agents. */
export function agentIdOf(tag: string): AgentId | null {
  const id = tag.split("@")[0] ?? "";
  return (AGENT_IDS as readonly string[]).includes(id) ? (id as AgentId) : null;
}

/** A stored `decision` event as a timeline entry (null when its details are not a decision). */
export function toDecision(e: TimelineEvent): TeamDecision | null {
  const d = DecisionDetailsSchema.safeParse(e.details);
  if (!d.success) return null;
  return {
    id: e.id,
    ts: e.ts,
    agent: agentIdOf(e.agent) ?? e.agent,
    tag: e.agent,
    kind: d.data.kind,
    text: e.text,
    outcome: d.data.outcome ?? null,
    reason: d.data.reason ?? null,
    nodeId: d.data.nodeId ?? null,
    items: d.data.items ?? [],
  };
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * The Team screen's view of a task, built from the saved plan and the stored events: who takes
 * part, what each agent is doing, how far it got, how long it worked, and what it decided.
 */
export function buildTimeline(o: TimelineInput): TeamTimeline {
  const active = ACTIVE.includes(o.status);
  const decisions = o.events
    .filter((e) => e.type === "decision")
    .map(toDecision)
    .filter((d): d is TeamDecision => d !== null);

  // Who takes part: the Manager, every owner in plan order, every reviewer, anyone who decided.
  const order: AgentId[] = [];
  const add = (id: AgentId | null) => {
    if (id && !order.includes(id)) order.push(id);
  };
  if (o.plan || o.events.length > 0) add("manager");
  for (const n of o.plan?.nodes ?? []) add(n.owner);
  for (const n of o.plan?.nodes ?? []) add(n.reviewer ?? null);
  for (const e of o.events) add(agentIdOf(e.agent));

  // Time spent on reviews: from "is reviewing" to the verdict, per reviewer and node.
  const reviewMs = new Map<AgentId, number>();
  const open = new Map<string, number>();
  for (const e of o.events) {
    if (e.type !== "reviewing") continue;
    const id = agentIdOf(e.agent);
    const node = typeof e.details?.nodeId === "string" ? e.details.nodeId : "";
    const t = ms(e.ts);
    if (!id || t === null) continue;
    const key = `${id}:${node}`;
    if (e.status === "started") open.set(key, t);
    else if (open.has(key)) {
      reviewMs.set(id, (reviewMs.get(id) ?? 0) + Math.max(0, t - (open.get(key) ?? t)));
      open.delete(key);
    }
  }
  if (active) {
    for (const [key, start] of open) {
      const id = key.split(":")[0] as AgentId;
      reviewMs.set(id, (reviewMs.get(id) ?? 0) + Math.max(0, o.now - start));
    }
  }

  const latest = new Map<AgentId, { text: string; ts: string }>();
  for (const l of o.latest) {
    const id = agentIdOf(l.agent);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || l.ts >= prev.ts) latest.set(id, { text: l.text, ts: l.ts });
  }

  const base = new Map(agentStatuses(o.plan, o.waiting).map((s) => [s.id, s]));
  const agents: TeamAgentStat[] = order.map((id) => {
    const s = base.get(id);
    const m = o.manifest(id);
    let state: AgentState = s?.state ?? "idle";
    if (id === "manager" && state !== "waiting" && active) {
      // Planning until the plan is approved, then coordinating the team.
      state = o.plan?.approved ? "working" : "thinking";
    }
    // A stopped or finished run leaves no one at work, whatever the plan last said.
    if (!active && state !== "blocked") state = "idle";
    const mine = o.plan?.nodes.filter((n) => n.owner === id) ?? [];
    let workMs = reviewMs.get(id) ?? 0;
    for (const n of mine) {
      const start = ms(n.startedAt);
      if (start === null) continue;
      const end =
        ms(n.finishedAt) ?? (active && (n.status === "doing" || n.status === "review") ? o.now : start);
      workMs += Math.max(0, end - start);
    }
    if (id === "manager") {
      const first = ms(o.span.first);
      const last = active ? o.now : ms(o.span.last);
      if (first !== null && last !== null) workMs = Math.max(workMs, last - first);
    }
    const own = decisions.filter((d) => d.agent === id);
    const l = latest.get(id);
    return {
      id,
      name: m.name,
      version: m.version,
      state,
      nodeId: s?.nodeId ?? null,
      action: l?.text ?? null,
      actionAt: l?.ts ?? null,
      done: s?.done ?? 0,
      total: s?.total ?? 0,
      reviews: own.filter((d) => d.kind === "review").length,
      workMs: Math.round(workMs),
      lastDecision: own.at(-1) ?? null,
    };
  });

  return { taskId: o.taskId, mode: o.mode, plan: o.plan, agents, decisions };
}

/** Read what the team view needs from the audit log (uses the project index, then the task). */
export function loadTimelineEvents(
  db: AppDb,
  projectId: string,
  taskId: string,
): Pick<TimelineInput, "events" | "latest" | "span"> {
  const where = and(eq(eventsTable.projectId, projectId), eq(eventsTable.taskId, taskId));
  const rows = db
    .select({
      id: eventsTable.id,
      ts: eventsTable.ts,
      agent: eventsTable.agent,
      type: eventsTable.type,
      text: eventsTable.text,
      status: eventsTable.status,
      details: eventsTable.details,
    })
    .from(eventsTable)
    .where(and(where, inArray(eventsTable.type, ["decision", "reviewing"])))
    .orderBy(desc(sql`rowid`))
    .limit(2000)
    .all()
    .reverse();
  const events: TimelineEvent[] = rows.map((r) => {
    let details: Record<string, JsonValue> | null = null;
    try {
      const parsed: unknown = r.details ? JSON.parse(r.details) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        details = parsed as Record<string, JsonValue>;
    } catch {
      // A damaged details column leaves the event without details.
    }
    return { ...r, details };
  });
  const latest = db.all<{ agent: string; text: string; ts: string }>(
    sql`SELECT agent, text, ts FROM events WHERE rowid IN (
      SELECT max(rowid) FROM events
      WHERE project_id = ${projectId} AND task_id = ${taskId} AND type <> 'decision'
      GROUP BY agent)`,
  );
  // `db.get` returns raw values for SQL text; `all` returns named columns.
  const [span] = db.all<{ first: string | null; last: string | null }>(
    sql`SELECT min(ts) AS first, max(ts) AS last FROM events WHERE project_id = ${projectId} AND task_id = ${taskId}`,
  );
  return { events, latest, span: { first: span?.first ?? null, last: span?.last ?? null } };
}

/** Detail keys the replay needs; everything else (command text, output chunks, file lists) stays out. */
const REPLAY_KEYS = [
  "kind",
  "nodeId",
  "outcome",
  "reason",
  "items",
  "attempt",
  "attempts",
  "verdict",
  "status",
  "nodeStatus",
  "to",
  "owner",
  "reviewer",
  "plan",
  "nodes",
  "tasks",
  "approvalId",
  "approved",
  "blocking",
] as const;
/** Types that say nothing about who did what (streamed output, queue lines). */
const REPLAY_SKIP = ["command_output", "queued", "heartbeat"];

function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Details cut down to the replay keys, with long text and lists clipped. */
export function replayDetails(raw: string | null): Record<string, JsonValue> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = {};
  for (const k of REPLAY_KEYS) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = clipText(v, k === "reason" ? 800 : 200);
    else if (Array.isArray(v))
      out[k] = v.slice(0, 12).map((x) => (typeof x === "string" ? clipText(x, 240) : x));
    else if (typeof v !== "object") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * One page of a task's stored events, oldest first, for the replay. `after` is the cursor of the
 * previous page (`next`); `next` is null on the last page.
 */
export function loadTeamEvents(
  db: AppDb,
  projectId: string,
  taskId: string,
  opts: { after?: number | undefined; limit: number },
): { events: TeamEvent[]; next: number | null } {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit)));
  const skip = sql.join(
    REPLAY_SKIP.map((t) => sql`${t}`),
    sql`, `,
  );
  const rows = db.all<{
    rid: number;
    id: string;
    ts: string;
    agent: string;
    type: string;
    text: string;
    status: string;
    details: string | null;
  }>(
    sql`SELECT rowid AS rid, id, ts, agent, type, text, status, details FROM events
        WHERE project_id = ${projectId} AND task_id = ${taskId} AND rowid > ${opts.after ?? 0}
          AND type NOT IN (${skip})
        ORDER BY rowid LIMIT ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({
      id: r.id,
      ts: r.ts,
      agent: r.agent,
      type: r.type,
      text: clipText(r.text, 240),
      status: r.status,
      details: replayDetails(r.details),
    })),
    next: rows.length > limit ? (page.at(-1)?.rid ?? null) : null,
  };
}

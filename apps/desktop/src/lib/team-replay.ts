import type { AgentState, DepoEvent, PlanNode, PlanNodeStatus, TeamDecision, TeamEvent } from "@depo/shared";
import type { Tone } from "./event-style";
import {
  ACTIVE_TASK,
  agentIdOf,
  decisionFromEvent,
  decisionTone,
  isBusy,
  type LiveAgent,
  type LiveTeam,
  type TimelineResult,
} from "./team-view";

/**
 * Replay a team run like a film. One pure reducer turns the stored events into the Team screen's
 * state (task statuses and attempts, what each agent does, the decisions so far); the live view is
 * the same reducer at the newest event. Checkpoints every STRIDE events make seeking on long runs
 * cheap: copy the nearest checkpoint, apply at most STRIDE events.
 */

/** An event ready for replay: its time in ms, and its place in the decision list (-1 for none). */
export interface ReplayEvent extends TeamEvent {
  t: number;
  d: number;
}

export interface NodeRun {
  status: PlanNodeStatus;
  attempts: number;
  reviewer: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AgentRun {
  action: string | null;
  actionAt: number | null;
  actionType: string | null;
  /** Index of its newest decision in the decision list, -1 for none. */
  lastDecision: number;
  reviews: number;
  /** Time spent on finished reviews. */
  reviewMs: number;
  /** Reviews in progress: node id -> start time. */
  open: Record<string, number>;
}

export interface ReplayState {
  /** Events applied so far. */
  applied: number;
  /** Time of the newest applied event. */
  at: number | null;
  /** Time of the first event (the run's start). */
  first: number | null;
  nodes: Record<string, NodeRun>;
  agents: Record<string, AgentRun>;
  /** Open approvals: approval id -> agent id. */
  waiting: Record<string, string>;
  /** Decisions made so far. */
  decisions: number;
  /** The first task started (the plan was approved). */
  started: boolean;
}

export type MarkerKind = "decision" | "review" | "changes" | "send_back" | "error";

export interface Marker {
  t: number;
  /** Index of the event in the replay. */
  i: number;
  kind: MarkerKind;
  tone: Tone;
  label: string;
}

export interface ReplayIndex {
  events: ReplayEvent[];
  times: number[];
  start: number;
  end: number;
  decisions: TeamDecision[];
  markers: Marker[];
  /** checkpoints[k] is the state after the first k * STRIDE events. */
  checkpoints: ReplayState[];
}

export const STRIDE = 200;

export function emptyState(): ReplayState {
  return {
    applied: 0,
    at: null,
    first: null,
    nodes: {},
    agents: {},
    waiting: {},
    decisions: 0,
    started: false,
  };
}

/** A deep copy (the state is small: at most 40 tasks and 16 agents). */
export function cloneState(s: ReplayState): ReplayState {
  const nodes: Record<string, NodeRun> = {};
  for (const [k, v] of Object.entries(s.nodes)) nodes[k] = { ...v };
  const agents: Record<string, AgentRun> = {};
  for (const [k, v] of Object.entries(s.agents)) agents[k] = { ...v, open: { ...v.open } };
  return { ...s, nodes, agents, waiting: { ...s.waiting } };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const NODE_STATUS: readonly string[] = ["todo", "doing", "review", "done", "blocked", "failed"];

function node(s: ReplayState, id: string): NodeRun {
  let n = s.nodes[id];
  if (!n) {
    n = { status: "todo", attempts: 0, reviewer: null, startedAt: null, finishedAt: null };
    s.nodes[id] = n;
  }
  return n;
}

function agent(s: ReplayState, id: string): AgentRun {
  let a = s.agents[id];
  if (!a) {
    a = {
      action: null,
      actionAt: null,
      actionType: null,
      lastDecision: -1,
      reviews: 0,
      reviewMs: 0,
      open: {},
    };
    s.agents[id] = a;
  }
  return a;
}

/** Apply one event to the state (in place). The heart of the replay. */
export function applyEvent(s: ReplayState, e: ReplayEvent): void {
  s.applied++;
  s.at = e.t;
  if (s.first === null) s.first = e.t;
  const d = e.details ?? {};
  const id = agentIdOf(e.agent);
  const nodeId = str(d.nodeId);

  if (e.d >= 0) {
    s.decisions = Math.max(s.decisions, e.d + 1);
    const a = agent(s, id);
    a.lastDecision = e.d;
    if (d.kind === "review") a.reviews++;
  } else if (e.agent !== "engine") {
    // What the agent did last: anything it recorded that is not a decision.
    const a = agent(s, id);
    a.action = e.text;
    a.actionAt = e.t;
    a.actionType = e.type;
  }

  if (e.type === "waiting_for_user" && e.status === "started" && str(d.approvalId)) {
    s.waiting[str(d.approvalId) ?? ""] = id;
  } else if (e.type === "info" && str(d.approvalId)) {
    delete s.waiting[str(d.approvalId) ?? ""];
  }

  if (!nodeId) return;
  const n = node(s, nodeId);
  if (e.type === "handoff" && e.status === "started") {
    n.status = "doing";
    n.attempts = Math.max(1, n.attempts);
    n.startedAt ??= e.t;
    n.finishedAt = null;
    s.started = true;
  } else if (e.type === "handoff" && str(d.status) && NODE_STATUS.includes(str(d.status) ?? "")) {
    n.status = d.status as PlanNodeStatus;
    n.finishedAt = e.t;
  } else if (e.type === "reviewing" && e.status === "started") {
    n.status = "review";
    n.reviewer = id;
    agent(s, id).open[nodeId] = e.t;
  } else if (e.type === "reviewing") {
    const a = agent(s, id);
    const from = a.open[nodeId];
    if (from !== undefined) {
      a.reviewMs += Math.max(0, e.t - from);
      delete a.open[nodeId];
    }
  } else if (e.type === "decision" && d.kind === "send_back") {
    n.status = "doing";
    n.attempts = typeof d.attempt === "number" ? d.attempt : n.attempts + 1;
  } else if (e.type === "decision" && d.kind === "escalate") {
    n.status = "failed";
  }
  // Any event may say a task's status outright (the on-hold line does).
  const said = str(d.nodeStatus);
  if (said && NODE_STATUS.includes(said)) n.status = said as PlanNodeStatus;
}

/** Events in replay order (time, then the order they arrived), with their decisions numbered. */
function prepare(events: readonly TeamEvent[], firstDecision: number): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    out.push({ ...e, t, d: -1 });
  }
  out.sort((a, b) => a.t - b.t);
  let d = firstDecision;
  for (const e of out) if (e.type === "decision" && decisionFromEvent(e)) e.d = d++;
  return out;
}

function markerOf(e: ReplayEvent, decision: TeamDecision | null, i: number): Marker | null {
  if (decision) {
    const tone = decisionTone(decision);
    const kind: MarkerKind =
      decision.kind === "review"
        ? decision.outcome === "changes"
          ? "changes"
          : "review"
        : decision.kind === "send_back"
          ? "send_back"
          : decision.kind === "escalate" || (decision.kind === "release" && decision.outcome === "blocked")
            ? "error"
            : "decision";
    return { t: e.t, i, kind, tone, label: decision.text };
  }
  if (e.type === "error") return { t: e.t, i, kind: "error", tone: "danger", label: e.text };
  return null;
}

function addAll(index: ReplayIndex, events: ReplayEvent[]): ReplayIndex {
  const all = [...index.events, ...events];
  const times = [...index.times, ...events.map((e) => e.t)];
  const decisions = [...index.decisions];
  const markers = [...index.markers];
  const checkpoints = [...index.checkpoints];
  // Continue from the newest checkpoint.
  let k = checkpoints.length - 1;
  const s = cloneState(checkpoints[k] ?? emptyState());
  for (let i = index.events.length; i < all.length; i++) {
    const e = all[i] as ReplayEvent;
    const dec = e.d >= 0 ? decisionFromEvent(e) : null;
    if (dec) decisions[e.d] = dec;
    const m = markerOf(e, dec, i);
    if (m) markers.push(m);
  }
  for (let i = k * STRIDE; i < all.length; i++) {
    applyEvent(s, all[i] as ReplayEvent);
    if ((i + 1) % STRIDE === 0) {
      k = (i + 1) / STRIDE;
      checkpoints[k] = cloneState(s);
    }
  }
  return {
    events: all,
    times,
    start: all[0]?.t ?? 0,
    end: all.at(-1)?.t ?? 0,
    decisions,
    markers,
    checkpoints,
  };
}

/** Index a run's events for replay. */
export function buildIndex(events: readonly TeamEvent[]): ReplayIndex {
  const empty: ReplayIndex = {
    events: [],
    times: [],
    start: 0,
    end: 0,
    decisions: [],
    markers: [],
    checkpoints: [emptyState()],
  };
  return addAll(empty, prepare(events, 0));
}

/**
 * Add newer events (live ones) without starting over. Events older than the newest indexed one
 * mean the order changed, so the index is built again.
 */
export function extendIndex(index: ReplayIndex, more: readonly TeamEvent[]): ReplayIndex {
  if (more.length === 0) return index;
  const next = prepare(more, index.decisions.length);
  if (next.length === 0) return index;
  if ((next[0]?.t ?? 0) < index.end) return buildIndex([...index.events, ...more]);
  return addAll(index, next);
}

/** How many events happened at or before `t`. */
export function countAt(index: Pick<ReplayIndex, "times">, t: number): number {
  let lo = 0;
  let hi = index.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((index.times[mid] ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The state after the first `count` events. */
export function stateAfter(index: ReplayIndex, count: number): ReplayState {
  const c = Math.max(0, Math.min(count, index.events.length));
  const k = Math.min(Math.floor(c / STRIDE), index.checkpoints.length - 1);
  const s = cloneState(index.checkpoints[k] ?? emptyState());
  for (let i = k * STRIDE; i < c; i++) applyEvent(s, index.events[i] as ReplayEvent);
  return s;
}

/** The state of the run at time `t` (every event at or before `t` applied). */
export function stateAt(index: ReplayIndex, t: number): ReplayState {
  return stateAfter(index, countAt(index, t));
}

/** The slow way, from the first event (tests check that seeking agrees with it). */
export function replayFromStart(events: readonly TeamEvent[], t: number): ReplayState {
  const s = emptyState();
  for (const e of prepare(events, 0)) {
    if (e.t > t) break;
    applyEvent(s, e);
  }
  return s;
}

// ---- moving through the run ------------------------------------------------------------------

/** Quiet stretches longer than this (run time) are shortened when playing. */
export const GAP_CAP = 2000;

/** Where playback is after `dtMs` of run time, with long quiet gaps cut short. */
export function advance(index: ReplayIndex, t: number, dtMs: number, end = index.end): number {
  let cur = Math.max(t, index.start);
  const next = index.times[countAt(index, cur)];
  if (next !== undefined && next - cur > GAP_CAP) cur = next - GAP_CAP;
  return Math.min(cur + dtMs, end);
}

/** The time of the next (dir 1) or previous (dir -1) event from `t`. */
export function stepEvent(index: ReplayIndex, t: number, dir: 1 | -1, end = index.end): number {
  if (dir === 1) return index.times[countAt(index, t)] ?? end;
  // The newest event strictly before `t`.
  let lo = 0;
  let hi = index.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((index.times[mid] ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return index.times[lo - 1] ?? index.start;
}

/** The time of the next or previous marker from `t`. */
export function stepMarker(index: ReplayIndex, t: number, dir: 1 | -1, end = index.end): number {
  if (dir === 1) return index.markers.find((m) => m.t > t)?.t ?? end;
  for (let i = index.markers.length - 1; i >= 0; i--) {
    const m = index.markers[i];
    if (m && m.t < t) return m.t;
  }
  return index.start;
}

// ---- the Team screen at a moment -------------------------------------------------------------

export interface TeamAtOptions {
  /** The moment shown (ms). */
  t: number;
  /** Following the newest events (the live edge), rather than a moment the person picked. */
  live: boolean;
  /** Live task events from the engine store, for the "thinking" line at the live edge. */
  taskEvents?: readonly DepoEvent[];
}

const iso = (ms: number | null): string | undefined => (ms === null ? undefined : new Date(ms).toISOString());

/**
 * The Team screen's data at a moment: the saved plan's tasks with the statuses they had then, each
 * agent's state, action and time worked then, and the decisions made so far. At the live edge the
 * saved plan has the last word for a task the events never mentioned (or once the run is over),
 * in case an event is missing from the record.
 */
export function teamAt(snapshot: TimelineResult, index: ReplayIndex, opts: TeamAtOptions): LiveTeam {
  const { t, live } = opts;
  const state = live ? stateAfter(index, index.events.length) : stateAt(index, t);
  const runActive = ACTIVE_TASK.includes(snapshot.status);
  const active = live ? runActive : runActive || t < index.end;

  const plan = snapshot.plan
    ? {
        ...snapshot.plan,
        nodes: snapshot.plan.nodes.map((n): PlanNode => {
          const run = state.nodes[n.id];
          if (live && (!run || !runActive)) return n;
          if (!run) {
            const { reviewer: _r, note: _n, startedAt: _s, finishedAt: _f, ...rest } = n;
            return { ...rest, status: "todo", attempts: 0 };
          }
          const out: PlanNode = { ...n, status: run.status, attempts: run.attempts };
          if (run.reviewer) out.reviewer = run.reviewer as PlanNode["reviewer"];
          else delete out.reviewer;
          const started = iso(run.startedAt);
          if (started) out.startedAt = started;
          else delete out.startedAt;
          const finished = iso(run.finishedAt);
          if (finished) out.finishedAt = finished;
          else delete out.finishedAt;
          if (run.status !== n.status) delete out.note;
          return out;
        }),
      }
    : null;

  const nodes = plan?.nodes ?? [];
  const waiting = active ? new Set(Object.values(state.waiting)) : new Set<string>();
  const decisions = index.decisions.slice(0, state.decisions);

  // The newest event of each agent at the live edge, for "the model is writing" and its line.
  const lastAny = new Map<string, DepoEvent>();
  if (live && runActive && opts.taskEvents) {
    for (let i = opts.taskEvents.length - 1; i >= 0; i--) {
      const e = opts.taskEvents[i];
      if (!e) continue;
      const id = agentIdOf(e.agent);
      if (!lastAny.has(id)) lastAny.set(id, e);
    }
  }

  const agents = snapshot.agents.map((a): LiveAgent => {
    const run = state.agents[a.id];
    const mine = nodes.filter((n) => n.owner === a.id);
    const doing = mine.find((n) => n.status === "doing");
    const reviewing = nodes.find((n) => n.status === "review" && n.reviewer === a.id);
    const stuck = mine.find((n) => n.status === "blocked" || n.status === "failed");
    let st: AgentState = "idle";
    let nodeId: string | null = null;
    if (waiting.has(a.id)) st = "waiting";
    else if (doing) [st, nodeId] = ["working", doing.id];
    else if (reviewing) [st, nodeId] = ["thinking", reviewing.id];
    else if (stuck) [st, nodeId] = ["blocked", stuck.id];
    if (a.id === "manager" && st !== "waiting" && active) st = state.started ? "working" : "thinking";
    if (!active && st !== "blocked") st = "idle";

    // Time worked up to `t`: its own tasks, reviews, and the whole run for the Manager.
    const at = active ? t : Math.min(t, state.at ?? t);
    let workMs =
      (run?.reviewMs ?? 0) +
      (active ? Object.values(run?.open ?? {}).reduce((s, v) => s + Math.max(0, at - v), 0) : 0);
    for (const n of mine) {
      const r = state.nodes[n.id];
      const start = r?.startedAt ?? (live && !runActive && n.startedAt ? Date.parse(n.startedAt) : null);
      if (start === null || Number.isNaN(start)) continue;
      const fin = r ? r.finishedAt : n.finishedAt ? Date.parse(n.finishedAt) : null;
      const end = fin ?? (active && (n.status === "doing" || n.status === "review") ? at : start);
      workMs += Math.max(0, Math.min(end, at) - start);
    }
    if (a.id === "manager" && state.first !== null) workMs = Math.max(workMs, at - state.first);

    const any = lastAny.get(a.id);
    const writing =
      any &&
      (any.type === "thinking" ||
        (any.ephemeral && any.type === "planning" && typeof any.details?.jobId === "string"));
    if (live && active && st === "working" && writing) st = "thinking";
    const fallback = live && !run;
    const actionAt = typeof run?.actionAt === "number" ? new Date(run.actionAt).toISOString() : null;
    return {
      ...a,
      state: st,
      nodeId,
      action: run?.action ?? (fallback ? a.action : null),
      actionAt: actionAt ?? (fallback ? a.actionAt : null),
      actionType: run?.actionType ?? null,
      thought:
        live && active && isBusy(st) && any?.ephemeral && any.type === "thinking" ? any.text || null : null,
      done: mine.filter((n) => n.status === "done").length,
      total: mine.length,
      reviews: run?.reviews ?? (fallback ? a.reviews : 0),
      workMs: Math.round(Math.max(0, workMs)),
      lastDecision:
        run && run.lastDecision >= 0
          ? (index.decisions[run.lastDecision] ?? null)
          : fallback
            ? a.lastDecision
            : null,
    };
  });

  const status = live
    ? snapshot.status
    : active
      ? waiting.size > 0
        ? "waiting"
        : "running"
      : snapshot.status;
  return { ...snapshot, status, plan, agents, decisions };
}

/** A live event from the engine store in the replay's shape (it is cut down the same way). */
export function toTeamEvent(e: DepoEvent): TeamEvent {
  return {
    id: e.id,
    ts: e.ts,
    agent: e.agent,
    type: e.type,
    text: e.text.length > 240 ? `${e.text.slice(0, 239)}…` : e.text,
    status: e.status,
    details: e.details,
  };
}

/** Markers by kind, for a short spoken summary of the track. */
export function markerCounts(markers: readonly Marker[]): Record<MarkerKind, number> {
  const out: Record<MarkerKind, number> = { decision: 0, review: 0, changes: 0, send_back: 0, error: 0 };
  for (const m of markers) out[m.kind]++;
  return out;
}

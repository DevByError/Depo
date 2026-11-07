import { z } from "zod";
import { type PlanNodeStatus, WorkModeSchema } from "./agents";
import { JsonValueSchema } from "./events";

/**
 * Team replay and time estimates.
 *
 * `team.events` hands the UI a task's stored events in pages, small enough to replay a long run
 * like a film. `team.eta` says how long the work takes on this PC, learned from past runs. The
 * schedule math below is shared, so the engine (plan approval message) and the UI (live time left)
 * give the same answer for the same plan.
 */

/** A stored event as the replay needs it: short text and only the detail keys that matter. */
export const TeamEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  agent: z.string(),
  type: z.string(),
  text: z.string(),
  status: z.string(),
  details: z.record(z.string(), JsonValueSchema).nullable(),
});
export type TeamEvent = z.infer<typeof TeamEventSchema>;

/** A time range in milliseconds: the quick case, the likely case and the slow case. */
export const EtaRangeSchema = z.object({
  low: z.number().nonnegative(),
  mid: z.number().nonnegative(),
  high: z.number().nonnegative(),
});
export type EtaRange = z.infer<typeof EtaRangeSchema>;

/**
 * Where an estimate comes from: this agent's own finished steps on this PC, similar steps of other
 * agents, or only the model's speed (a first guess).
 */
export const EtaBasisSchema = z.enum(["learned", "similar", "guess"]);
export type EtaBasis = z.infer<typeof EtaBasisSchema>;

export const NodeEtaSchema = EtaRangeSchema.extend({ id: z.string(), basis: EtaBasisSchema });
export type NodeEta = z.infer<typeof NodeEtaSchema>;

export const TeamEtaSchema = z.object({
  taskId: z.string(),
  mode: WorkModeSchema,
  /** Tasks the team runs at once (`team.parallel`). */
  parallel: z.number().int().min(1),
  /** learned: every step has history; guess: none has; mixed: some have. */
  basis: z.enum(["learned", "mixed", "guess"]),
  /** How long each plan task takes as a whole: the work, its review and a likely send-back. */
  nodes: z.array(NodeEtaSchema),
  /** The whole plan from the start, before anything ran. */
  plan: EtaRangeSchema.nullable(),
  /** A single-agent task: the whole run. */
  single: EtaRangeSchema.extend({ basis: EtaBasisSchema }).nullable(),
  /** How many finished steps on this PC the estimate learned from. */
  samples: z.number().int().nonnegative(),
  /** The coding model's speed on this PC (measured when Depo has seen it work). */
  speed: z.object({
    model: z.string().nullable(),
    tokensPerSec: z.number().nullable(),
    ttftMs: z.number().nullable(),
    measured: z.boolean(),
  }),
});
export type TeamEta = z.infer<typeof TeamEtaSchema>;

export const TeamReplayMethods = {
  /** A task's stored events, oldest first, in pages (pass `next` as `after` for the next page). */
  "team.events": {
    params: z
      .object({
        taskId: z.string(),
        after: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1000).default(500),
      })
      .strict(),
    result: z.object({ events: z.array(TeamEventSchema), next: z.number().int().nullable() }),
  },
  /** How long a task's work takes on this PC (per plan task, and for the whole plan). */
  "team.eta": {
    params: z.object({ taskId: z.string() }).strict(),
    result: TeamEtaSchema,
  },
} as const;

// ---- schedule math -------------------------------------------------------------------------

export interface EtaNodeInput {
  id: string;
  deps: string[];
  status: PlanNodeStatus;
  /** How long the whole node takes. */
  duration: EtaRange;
  /** Time already spent on a node that is running (doing or in review). */
  elapsed?: number;
}

export interface ScheduleResult {
  /** From now until every node that can still run has finished. */
  total: number;
  /** When each node starts and finishes, from now. Nodes that will never run are left out. */
  start: Record<string, number>;
  finish: Record<string, number>;
}

/**
 * What is left of a running node. Never zero while it runs: past its estimate it may still take a
 * little longer, so a tenth of the estimate (at most a minute) stays.
 */
export function leftOf(duration: number, elapsed: number): number {
  const floor = Math.min(60_000, duration * 0.1);
  return Math.max(duration - Math.max(0, elapsed), floor);
}

/** Failed and blocked nodes never run, nor does anything that waits on them. */
function deadNodes(nodes: EtaNodeInput[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, boolean>();
  const dead = (id: string, path: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const n = byId.get(id);
    if (!n || path.has(id)) return false;
    path.add(id);
    const out =
      n.status === "failed" ||
      n.status === "blocked" ||
      (n.status === "todo" && n.deps.some((d) => dead(d, path)));
    path.delete(id);
    memo.set(id, out);
    return out;
  };
  return new Set(nodes.filter((n) => dead(n.id, new Set())).map((n) => n.id));
}

/**
 * Play the team's executor forward with estimated durations: running nodes keep their slots,
 * waiting nodes start in plan order as soon as their dependencies are done and fewer than
 * `parallel` nodes run. With an unlimited `parallel` this is the critical path.
 */
export function simulateSchedule(
  nodes: EtaNodeInput[],
  parallel: number,
  pick: keyof EtaRange = "mid",
): ScheduleResult {
  const limit = Math.max(1, Math.floor(parallel));
  const ids = new Set(nodes.map((n) => n.id));
  const dead = deadNodes(nodes);
  const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.id));
  const start: Record<string, number> = {};
  const finish: Record<string, number> = {};
  const running: { id: string; end: number }[] = [];
  for (const n of nodes) {
    if (n.status !== "doing" && n.status !== "review") continue;
    start[n.id] = 0;
    running.push({ id: n.id, end: leftOf(n.duration[pick], n.elapsed ?? 0) });
  }
  let queue = nodes.filter((n) => n.status === "todo" && !dead.has(n.id));
  // Dependencies the plan does not know (a damaged plan) do not hold a node back.
  const ready = (n: EtaNodeInput) => n.deps.every((d) => done.has(d) || !ids.has(d));
  let now = 0;
  for (let guard = 0; guard <= nodes.length * 2 + 2; guard++) {
    const waiting: EtaNodeInput[] = [];
    for (const n of queue) {
      if (running.length < limit && ready(n)) {
        start[n.id] = now;
        running.push({ id: n.id, end: now + n.duration[pick] });
      } else waiting.push(n);
    }
    queue = waiting;
    if (running.length === 0) break;
    running.sort((a, b) => a.end - b.end);
    const next = running[0];
    if (!next) break;
    now = next.end;
    // Everything that ends at the same moment frees its slot together.
    while (running[0] && running[0].end <= now) {
      const r = running.shift();
      if (!r) break;
      done.add(r.id);
      finish[r.id] = r.end;
    }
  }
  return { total: now, start, finish };
}

export interface RemainingEta {
  /** Until the whole run is finished. */
  total: EtaRange;
  /** Per node: what is left of it (its whole duration while it waits) and when it will be done. */
  nodes: Record<string, { left: EtaRange; finish: EtaRange }>;
}

/** Time left for the whole run and for each node, in the quick, likely and slow case. */
export function remainingEta(nodes: EtaNodeInput[], parallel: number): RemainingEta {
  const low = simulateSchedule(nodes, parallel, "low");
  const mid = simulateSchedule(nodes, parallel, "mid");
  const high = simulateSchedule(nodes, parallel, "high");
  const out: RemainingEta["nodes"] = {};
  for (const n of nodes) {
    const running = n.status === "doing" || n.status === "review";
    const left = (k: keyof EtaRange) =>
      running ? leftOf(n.duration[k], n.elapsed ?? 0) : n.status === "todo" ? n.duration[k] : 0;
    out[n.id] = {
      left: { low: left("low"), mid: left("mid"), high: left("high") },
      finish: {
        low: low.finish[n.id] ?? 0,
        mid: mid.finish[n.id] ?? 0,
        high: high.finish[n.id] ?? 0,
      },
    };
  }
  return { total: { low: low.total, mid: mid.total, high: high.total }, nodes: out };
}

const MIN = 60_000;

function hoursText(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/**
 * A friendly range: "under a minute", "3 to 6 min", "25 to 40 min", "45 min to 1.5 hours",
 * "about 2 hours". Short ranges round to minutes, longer ones to 5 minutes or half hours.
 */
export function etaRangeText(r: { low: number; high: number }): string {
  const lowMs = Math.max(0, Math.min(r.low, r.high));
  const highMs = Math.max(r.low, r.high);
  if (highMs < MIN) return "under a minute";
  const hi = highMs / MIN;
  const lo = lowMs / MIN;
  const roundMin = (m: number, up: boolean) => {
    const step = (up ? m : Math.max(m, 1)) <= 15 ? 1 : 5;
    const v = up ? Math.ceil(m / step) * step : Math.floor(m / step) * step;
    return Math.max(1, v);
  };
  const roundHours = (m: number, up: boolean) => {
    const halves = up ? Math.ceil(m / 30) : Math.floor(m / 30);
    return Math.max(1, halves / 2);
  };
  if (hi < 60) {
    const a = roundMin(lo, false);
    const b = Math.max(a, roundMin(hi, true));
    return a === b ? `about ${b} min` : `${a} to ${b} min`;
  }
  const b = roundHours(hi, true);
  if (lo < 60) {
    const a = roundMin(lo, false);
    return `${a} min to ${hoursText(b)} hour${b === 1 ? "" : "s"}`;
  }
  const a = Math.min(b, roundHours(lo, false));
  return a === b
    ? `about ${hoursText(b)} hour${b === 1 ? "" : "s"}`
    : `${hoursText(a)} to ${hoursText(b)} hours`;
}

/** "about 25 to 40 min" (the range text with "about" in front when it is a range). */
export function aboutEta(r: { low: number; high: number }): string {
  const t = etaRangeText(r);
  return t.startsWith("about") || t.startsWith("under") ? t : `about ${t}`;
}

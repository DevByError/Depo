import {
  AGENT_IDS,
  type AgentId,
  aboutEta,
  type DepoEvent,
  type EtaBasis,
  type EtaRange,
  type NodeEta,
  type Plan,
  type PlanNode,
  simulateSchedule,
  type TeamEta,
  type WorkMode,
} from "@depo/shared";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelCallStats } from "../logs/model-calls";
import { manifestOf } from "./manifests";

/**
 * Time estimates for this PC. Depo watches finished work (from the event stream, so nothing in the
 * team runner has to time itself), keeps how long each kind of step took per agent together with
 * the model's measured speed, and estimates a plan by playing the executor forward with those
 * durations. Without history it guesses from the model's speed and says it is a first guess.
 * Everything here is cheap: a few small SQL reads, no model calls.
 */

/** One owner attempt (work), a later attempt after a send-back (fix), a review, a whole plan task (node), a single-agent run (task). */
export type EtaKind = "work" | "fix" | "review" | "node" | "task";

export interface EtaSample {
  /** Agent id (`backend`), or `coder` for the single agent. */
  agent: string;
  kind: EtaKind;
  durationMs: number;
  /** For `node`: how many attempts the owner needed. */
  attempts?: number | null;
  model?: string | null;
  tokensPerSec?: number | null;
}

export interface Speed {
  model: string | null;
  tokensPerSec: number;
  ttftMs: number;
  measured: boolean;
}

export interface StepEta extends EtaRange {
  basis: EtaBasis;
  samples: number;
}

/** A modest PC with a small local model, when nothing was measured yet. */
export const DEFAULT_SPEED = { tokensPerSec: 8, ttftMs: 4000 } as const;

/** The rough shape of a step for the first guess: model calls, reply tokens per call, tool time per call. */
const PROFILE: Record<EtaKind, { calls: number; tokens: number; toolMs: number }> = {
  work: { calls: 10, tokens: 220, toolMs: 1500 },
  fix: { calls: 6, tokens: 200, toolMs: 1500 },
  review: { calls: 3, tokens: 220, toolMs: 800 },
  node: { calls: 14, tokens: 220, toolMs: 1500 },
  task: { calls: 14, tokens: 220, toolMs: 1500 },
};

/** Samples kept per agent and kind; the newest USE of them count. */
const KEEP = 40;
const USE = 20;
/** Share of reviewed tasks expected to be sent back once, before Depo has seen any. */
const DEFAULT_SEND_BACK = 0.3;

const RANK: Record<EtaBasis, number> = { guess: 0, similar: 1, learned: 2 };
const worst = (...b: EtaBasis[]): EtaBasis =>
  b.reduce((a, x) => (RANK[x] < RANK[a] ? x : a), "learned" as EtaBasis);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** A range from past durations: wide with few samples, the 20th to 80th percentile with more. */
export function rangeFrom(values: number[]): EtaRange {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return { low: 0, mid: 0, high: 0 };
  const mid = quantile(v, 0.5);
  if (v.length === 1) return { low: mid * 0.75, mid, high: mid * 1.4 };
  if (v.length <= 3) return { low: (v[0] ?? mid) * 0.85, mid, high: (v.at(-1) ?? mid) * 1.2 };
  return {
    low: Math.min(quantile(v, 0.2), mid * 0.85),
    mid,
    high: Math.max(quantile(v, 0.8), mid * 1.15),
  };
}

/** How long a step of this kind takes with a model of this speed, before any history. */
export function guessStep(kind: EtaKind, speed: Pick<Speed, "tokensPerSec" | "ttftMs">): EtaRange {
  const p = PROFILE[kind];
  const tps = speed.tokensPerSec > 0 ? speed.tokensPerSec : DEFAULT_SPEED.tokensPerSec;
  const mid = p.calls * (speed.ttftMs + (p.tokens / tps) * 1000 + p.toolMs);
  return { low: mid * 0.6, mid, high: mid * 1.8 };
}

const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? quantile(v, 0.5) : null;
};

// ---- watching work finish ----------------------------------------------------------------

/** Work finished: the samples it produced and the time window the model calls fall in. */
export interface EtaCompletion {
  taskId: string;
  from: number;
  to: number;
  samples: EtaSample[];
}

interface NodeTrack {
  owner: string;
  start: number;
  attempts: number;
  seg: { agent: string; kind: EtaKind; start: number } | null;
  samples: EtaSample[];
}

interface TaskTrack {
  singleStart: number | null;
  /** Time spent waiting for the person (approvals), which is not work. */
  waits: [number, number][];
  open: Map<string, number>;
  nodes: Map<string, NodeTrack>;
}

const idOf = (tag: string) => tag.split("@")[0] ?? tag;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Turns the event stream into step durations: a handoff starts an owner's attempt, "is reviewing"
 * ends it and starts a review, the verdict ends the review, a send-back starts a fix, and the
 * node's final handoff ends it all. Only tasks that finish done are learned from; time spent
 * waiting for the person is taken out. Pure apart from its own memory, so it is easy to test.
 */
export class EtaTracker {
  private readonly tasks = new Map<string, TaskTrack>();

  private track(taskId: string): TaskTrack {
    let t = this.tasks.get(taskId);
    if (!t) {
      t = { singleStart: null, waits: [], open: new Map(), nodes: new Map() };
      this.tasks.set(taskId, t);
    }
    return t;
  }

  /** Waiting time inside [a, b]. */
  private waited(t: TaskTrack, a: number, b: number): number {
    let ms = 0;
    for (const [s, e] of t.waits) ms += Math.max(0, Math.min(b, e) - Math.max(a, s));
    for (const s of t.open.values()) ms += Math.max(0, b - Math.max(a, s));
    return ms;
  }

  private close(t: TaskTrack, n: NodeTrack, at: number) {
    const seg = n.seg;
    n.seg = null;
    if (!seg) return;
    const ms = at - seg.start - this.waited(t, seg.start, at);
    if (ms > 0) n.samples.push({ agent: seg.agent, kind: seg.kind, durationMs: Math.round(ms) });
  }

  observe(
    e: Pick<DepoEvent, "ts" | "taskId" | "agent" | "type" | "status" | "details" | "text">,
  ): EtaCompletion[] {
    if (!e.taskId) return [];
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) return [];
    const t = this.track(e.taskId);
    const d = e.details ?? {};
    const nodeId = str(d.nodeId);
    const agent = idOf(e.agent);

    if (e.type === "waiting_for_user" && e.status === "started") {
      const id = str(d.approvalId);
      if (id) t.open.set(id, at);
      return [];
    }
    if (e.type === "info" && str(d.approvalId)) {
      const id = str(d.approvalId) ?? "";
      const s = t.open.get(id);
      if (s !== undefined) {
        t.open.delete(id);
        t.waits.push([s, at]);
      }
      return [];
    }
    // A stopped or crashed run teaches nothing.
    if ((e.type === "info" && e.status === "cancelled") || (e.type === "error" && agent === "coder")) {
      this.tasks.delete(e.taskId);
      return [];
    }

    // The single agent: from "Working on" to the changes it hands over.
    if (agent === "coder") {
      if (e.type === "planning" && e.status === "started" && str(d.model)) {
        t.singleStart = at;
        t.waits = [];
      } else if (e.type === "handoff" && e.status === "succeeded" && t.singleStart !== null) {
        const from = t.singleStart;
        const ms = at - from - this.waited(t, from, at);
        this.tasks.delete(e.taskId);
        if (ms <= 0) return [];
        return [
          {
            taskId: e.taskId,
            from,
            to: at,
            samples: [{ agent: "coder", kind: "task", durationMs: Math.round(ms) }],
          },
        ];
      }
      return [];
    }

    if (!nodeId) {
      // The team run ended (the change set handoff): forget the task.
      if (e.type === "handoff" && agent === "manager" && e.status !== "started" && t.nodes.size === 0)
        this.tasks.delete(e.taskId);
      return [];
    }

    if (e.type === "handoff" && e.status === "started") {
      const owner = str(d.to) ?? agent;
      t.nodes.set(nodeId, {
        owner,
        start: at,
        attempts: 1,
        seg: { agent: owner, kind: "work", start: at },
        samples: [],
      });
      return [];
    }
    const n = t.nodes.get(nodeId);
    if (!n) return [];
    if (e.type === "reviewing" && e.status === "started") {
      this.close(t, n, at);
      n.seg = { agent, kind: "review", start: at };
      return [];
    }
    if (e.type === "reviewing") {
      if (n.seg?.kind === "review") this.close(t, n, at);
      return [];
    }
    if (e.type === "decision" && d.kind === "send_back") {
      this.close(t, n, at);
      n.attempts = typeof d.attempt === "number" ? d.attempt : n.attempts + 1;
      n.seg = { agent: n.owner, kind: "fix", start: at };
      return [];
    }
    if (e.type === "handoff" && str(d.status)) {
      this.close(t, n, at);
      t.nodes.delete(nodeId);
      if (d.status !== "done") return [];
      const ms = at - n.start - this.waited(t, n.start, at);
      const samples = [...n.samples];
      if (ms > 0)
        samples.push({ agent: n.owner, kind: "node", durationMs: Math.round(ms), attempts: n.attempts });
      return samples.length ? [{ taskId: e.taskId, from: n.start, to: at, samples }] : [];
    }
    return [];
  }
}

// ---- the service -------------------------------------------------------------------------

export interface EtaOptions {
  db: AppDb;
  bus?: EventBus | undefined;
  logger?: Logger | undefined;
  /** Model timings of this engine run (models.stats). */
  callStats?: ModelCallStats | undefined;
  /** The model an agent works with now (`coder` for the single agent). */
  modelFor?: ((agent: string) => string | null) | undefined;
  /** Tasks the team runs at once now (`team.parallel`). */
  parallel?: (() => number) | undefined;
}

interface SampleRow {
  agent: string;
  kind: string;
  duration_ms: number;
  tokens_per_sec: number | null;
  attempts: number | null;
}

/** Past samples, newest first, by `agent:kind`; loaded once per estimate. */
type SampleBook = Map<string, SampleRow[]>;

export class EtaService {
  private readonly tracker = new EtaTracker();
  private readonly unsubscribe: (() => void) | null;

  constructor(private readonly o: EtaOptions) {
    this.unsubscribe = o.bus ? o.bus.subscribe((e) => this.observe(e)) : null;
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Learn from one event (stored task events only). Never throws. */
  observe(e: DepoEvent): void {
    if (e.ephemeral || !e.taskId) return;
    try {
      for (const c of this.tracker.observe(e)) {
        this.updateSpeeds(c);
        for (const s of c.samples) {
          const model = s.model ?? this.o.modelFor?.(s.agent) ?? null;
          this.record({
            ...s,
            model,
            tokensPerSec: s.tokensPerSec ?? (model ? this.measured(model)?.tokensPerSec : null) ?? null,
          });
        }
      }
    } catch (err) {
      this.o.logger?.warn("eta: could not learn from an event", { err });
    }
  }

  /** Save one finished step and keep only the newest few per agent and kind. */
  record(s: EtaSample): void {
    if (!(s.durationMs > 0)) return;
    const now = new Date().toISOString();
    this.o.db.run(
      sql`INSERT INTO eta_samples (agent, kind, duration_ms, model, tokens_per_sec, attempts, created_at)
          VALUES (${s.agent}, ${s.kind}, ${Math.round(s.durationMs)}, ${s.model ?? null}, ${s.tokensPerSec ?? null}, ${s.attempts ?? null}, ${now})`,
    );
    this.o.db.run(
      sql`DELETE FROM eta_samples WHERE agent = ${s.agent} AND kind = ${s.kind} AND id NOT IN (
            SELECT id FROM eta_samples WHERE agent = ${s.agent} AND kind = ${s.kind} ORDER BY id DESC LIMIT ${KEEP})`,
    );
  }

  /** Every saved sample, newest first, by agent and kind. */
  private book(): SampleBook {
    const rows = this.o.db.all<SampleRow>(
      sql`SELECT agent, kind, duration_ms, tokens_per_sec, attempts FROM eta_samples ORDER BY id DESC`,
    );
    const book: SampleBook = new Map();
    for (const r of rows) {
      const key = `${r.agent}:${r.kind}`;
      const list = book.get(key) ?? [];
      if (list.length < USE) list.push(r);
      book.set(key, list);
    }
    return book;
  }

  /** The model's measured speed: this run's model calls first, then what earlier runs saved. */
  private measured(model: string): { tokensPerSec: number; ttftMs: number | null } | null {
    const live = this.o.callStats?.summary().find((m) => m.model === model && m.avgTokensPerSec);
    if (live?.avgTokensPerSec) return { tokensPerSec: live.avgTokensPerSec, ttftMs: live.medianTtftMs };
    const [row] = this.o.db.all<{ tokens_per_sec: number | null; ttft_ms: number | null }>(
      sql`SELECT tokens_per_sec, ttft_ms FROM eta_models WHERE model = ${model}`,
    );
    return row?.tokens_per_sec ? { tokensPerSec: row.tokens_per_sec, ttftMs: row.ttft_ms } : null;
  }

  speedOf(model: string | null): Speed {
    const m = model ? this.measured(model) : null;
    if (!m) return { model, ...DEFAULT_SPEED, measured: false };
    return { model, tokensPerSec: m.tokensPerSec, ttftMs: m.ttftMs ?? DEFAULT_SPEED.ttftMs, measured: true };
  }

  /** After work finished: fold the speed of the model calls it made into the saved speeds. */
  private updateSpeeds(c: EtaCompletion) {
    const calls = this.o.callStats?.recent(300) ?? [];
    const byModel = new Map<string, { tps: number[]; ttft: number[] }>();
    for (const call of calls) {
      const at = Date.parse(call.ts);
      if (call.taskId !== c.taskId || !call.ok || at < c.from - 1000 || at > c.to + 1000) continue;
      const g = byModel.get(call.model) ?? { tps: [], ttft: [] };
      if (call.tokensPerSec) g.tps.push(call.tokensPerSec);
      if (call.ttftMs !== null) g.ttft.push(call.ttftMs);
      byModel.set(call.model, g);
    }
    const now = new Date().toISOString();
    for (const [model, g] of byModel) {
      const tps = median(g.tps);
      const ttft = median(g.ttft);
      if (tps === null && ttft === null) continue;
      const [old] = this.o.db.all<{ tokens_per_sec: number | null; ttft_ms: number | null; calls: number }>(
        sql`SELECT tokens_per_sec, ttft_ms, calls FROM eta_models WHERE model = ${model}`,
      );
      // A moving average: new runs count, one slow run does not undo the history.
      const blend = (prev: number | null | undefined, next: number | null) =>
        next === null ? (prev ?? null) : prev ? prev * 0.7 + next * 0.3 : next;
      this.o.db.run(
        sql`INSERT INTO eta_models (model, tokens_per_sec, ttft_ms, calls, updated_at)
            VALUES (${model}, ${blend(old?.tokens_per_sec, tps)}, ${blend(old?.ttft_ms, ttft)}, ${g.tps.length + g.ttft.length}, ${now})
            ON CONFLICT(model) DO UPDATE SET tokens_per_sec = excluded.tokens_per_sec, ttft_ms = excluded.ttft_ms,
              calls = eta_models.calls + excluded.calls, updated_at = excluded.updated_at`,
      );
    }
  }

  private modelOf(agent: string): string | null {
    try {
      return this.o.modelFor?.(agent) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * How long one step takes: this agent's own history (scaled when the model got faster or slower
   * since), else the same kind of step by other agents, else a guess from the model's speed.
   */
  step(agent: string, kind: EtaKind, book: SampleBook = this.book()): StepEta {
    const speed = this.speedOf(this.modelOf(agent));
    const scaled = (rows: SampleRow[]) =>
      rows.map((r) => {
        const ratio =
          speed.measured && r.tokens_per_sec && speed.tokensPerSec > 0
            ? Math.min(3, Math.max(1 / 3, r.tokens_per_sec / speed.tokensPerSec))
            : 1;
        return r.duration_ms * ratio;
      });
    const own = book.get(`${agent}:${kind}`) ?? [];
    if (own.length > 0) return { ...rangeFrom(scaled(own)), basis: "learned", samples: own.length };
    const similar = [...book.entries()]
      .filter(([k]) => k.endsWith(`:${kind}`))
      .flatMap(([, rows]) => rows)
      .slice(0, USE);
    if (similar.length > 0) {
      const r = rangeFrom(scaled(similar));
      return { low: r.low * 0.8, mid: r.mid, high: r.high * 1.25, basis: "similar", samples: similar.length };
    }
    return { ...guessStep(kind, speed), basis: "guess", samples: 0 };
  }

  /** Extra attempts an owner usually needs after reviews (0.3 before any history). */
  private sendBacks(owner: string, book: SampleBook): number {
    const rows = (book.get(`${owner}:node`) ?? []).filter((r) => r.attempts !== null);
    if (rows.length === 0) return DEFAULT_SEND_BACK;
    const extra = rows.reduce((n, r) => n + Math.max(0, (r.attempts ?? 1) - 1), 0) / rows.length;
    return Math.min(3, extra);
  }

  /** A whole plan task: the owner's work, the review, and the send-backs the owner usually needs. */
  node(n: Pick<PlanNode, "id" | "owner" | "review" | "reviewer">, book: SampleBook = this.book()): NodeEta {
    const work = this.step(n.owner, "work", book);
    if (!n.review) return { id: n.id, low: work.low, mid: work.mid, high: work.high, basis: work.basis };
    const reviewer = n.reviewer ?? defaultReviewer(n.owner);
    const review = this.step(reviewer, "review", book);
    const fix = this.step(n.owner, "fix", book);
    const rate = this.sendBacks(n.owner, book);
    const again = { mid: fix.mid + review.mid, high: fix.high + review.high };
    return {
      id: n.id,
      low: work.low + review.low,
      mid: work.mid + review.mid + rate * again.mid,
      high:
        work.high +
        review.high +
        Math.max(1, Math.ceil(rate)) * again.mid +
        (rate > 1 ? again.high - again.mid : 0),
      basis: worst(work.basis, review.basis, fix.basis),
    };
  }

  /** The whole plan from the start, honouring `team.parallel`, plus each task's estimate. */
  planEta(plan: Plan, parallel: number): { total: EtaRange; nodes: NodeEta[]; basis: TeamEta["basis"] } {
    const book = this.book();
    const nodes = plan.nodes.map((n) => this.node(n, book));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const input = plan.nodes.map((n) => ({
      id: n.id,
      deps: n.deps,
      status: "todo" as const,
      duration: byId.get(n.id) ?? { low: 0, mid: 0, high: 0 },
    }));
    const total = {
      low: simulateSchedule(input, parallel, "low").total,
      mid: simulateSchedule(input, parallel, "mid").total,
      high: simulateSchedule(input, parallel, "high").total,
    };
    return { total, nodes, basis: overall(nodes.map((n) => n.basis)) };
  }

  /** One friendly line for the plan approval message: "About 25 to 40 min on this PC." */
  planNote(plan: Plan, parallel: number): string | null {
    if (plan.nodes.length === 0) return null;
    const { total, basis } = this.planEta(plan, parallel);
    return etaNote(total, basis);
  }

  /** What `team.eta` answers for a task. */
  forTask(task: { taskId: string; mode: WorkMode; plan: Plan | null }): TeamEta {
    const parallel = Math.max(1, Math.floor(this.o.parallel?.() ?? 2));
    const book = this.book();
    const samples = [...book.values()].reduce((n, rows) => n + rows.length, 0);
    const speed = this.speedOf(this.modelOf("coder"));
    const base = {
      taskId: task.taskId,
      mode: task.mode,
      parallel,
      samples,
      speed: {
        model: speed.model,
        tokensPerSec: speed.measured ? Math.round(speed.tokensPerSec * 10) / 10 : null,
        ttftMs: speed.measured ? Math.round(speed.ttftMs) : null,
        measured: speed.measured,
      },
    };
    if (task.mode === "single" || !task.plan) {
      const single = task.mode === "single" ? this.step("coder", "task", book) : null;
      return {
        ...base,
        basis: single ? overall([single.basis]) : "guess",
        nodes: [],
        plan: null,
        single: single ? { low: single.low, mid: single.mid, high: single.high, basis: single.basis } : null,
      };
    }
    const p = this.planEta(task.plan, parallel);
    return { ...base, basis: p.basis, nodes: p.nodes, plan: p.total, single: null };
  }
}

function defaultReviewer(owner: string): string {
  if (!(AGENT_IDS as readonly string[]).includes(owner)) return "reasoning";
  return manifestOf(owner as AgentId).reviewers.find((r) => r !== owner) ?? "reasoning";
}

function overall(bases: EtaBasis[]): TeamEta["basis"] {
  if (bases.length === 0) return "guess";
  if (bases.every((b) => b === "learned")) return "learned";
  if (bases.every((b) => b === "guess")) return "guess";
  return "mixed";
}

/** "About 25 to 40 min on this PC." with a word on how sure Depo is. */
export function etaNote(total: EtaRange, basis: TeamEta["basis"]): string {
  const about = aboutEta(total);
  const text = `${about[0]?.toUpperCase() ?? ""}${about.slice(1)} on this PC`;
  if (basis === "guess") return `First guess: ${about} on this PC. Depo learns real times as tasks finish.`;
  if (basis === "mixed") return `${text}, partly a first guess.`;
  return `${text}.`;
}

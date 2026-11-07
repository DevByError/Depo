import {
  aboutEta,
  type EtaBasis,
  type EtaRange,
  etaRangeText,
  remainingEta,
  type TeamEta,
} from "@depo/shared";
import { formatDuration } from "./format";
import type { LiveTeam } from "./team-view";

/**
 * Time left, as the Team screen shows it. The engine says how long each plan task takes on this PC
 * (`team.eta`); this file counts down from there with the statuses of the moment shown, using the
 * same schedule math as the engine, so it updates every second without asking the engine again.
 */

export interface NodeEtaView {
  /** What is left of the task: all of it while it waits, the rest while it runs. */
  left: EtaRange;
  running: boolean;
  /** Running longer than its slow case. */
  over: boolean;
  basis: EtaBasis;
}

export interface EtaView {
  /** Until the whole run is finished. */
  total: EtaRange;
  basis: TeamEta["basis"];
  nodes: Map<string, NodeEtaView>;
  /** Past steps on this PC the estimate learned from. */
  samples: number;
}

/** Time left at moment `t`, or null when there is no plan or no estimate yet. */
export function etaAt(view: Pick<LiveTeam, "plan">, eta: TeamEta | null, t: number): EtaView | null {
  if (!eta || !view.plan || eta.nodes.length === 0) return null;
  const byId = new Map(eta.nodes.map((n) => [n.id, n]));
  const zero = { low: 0, mid: 0, high: 0 };
  const inputs = view.plan.nodes.map((n) => {
    const started = n.startedAt ? Date.parse(n.startedAt) : Number.NaN;
    return {
      id: n.id,
      deps: n.deps,
      status: n.status,
      duration: byId.get(n.id) ?? zero,
      elapsed: Number.isNaN(started) ? 0 : Math.max(0, t - started),
    };
  });
  const rem = remainingEta(inputs, eta.parallel);
  const nodes = new Map<string, NodeEtaView>();
  for (const n of inputs) {
    const r = rem.nodes[n.id];
    if (!r) continue;
    const running = n.status === "doing" || n.status === "review";
    nodes.set(n.id, {
      left: r.left,
      running,
      over: running && n.elapsed > n.duration.high && n.duration.high > 0,
      basis: byId.get(n.id)?.basis ?? "guess",
    });
  }
  return { total: rem.total, basis: eta.basis, nodes, samples: eta.samples };
}

/** "about 4 min left", "2 to 6 min", "a little longer": the short line on a task card. */
export function nodeEtaText(n: NodeEtaView): string {
  if (n.over) return "a little longer";
  const text = etaRangeText(n.left);
  return n.running ? `${text} left` : text;
}

/** The header's "Time left" value: "25 to 40 min". */
export function totalEtaText(r: EtaRange): string {
  return etaRangeText(r);
}

/** A sentence for a tooltip on how the estimate was made. */
export function etaBasisText(basis: TeamEta["basis"], samples: number): string {
  if (basis === "guess")
    return "A first guess from the model's speed on this PC. Depo learns real times as tasks finish.";
  const steps = `${samples} finished step${samples === 1 ? "" : "s"}`;
  if (basis === "mixed") return `Learned from ${steps} on this PC. Steps Depo has not seen yet are guessed.`;
  return `Learned from ${steps} on this PC.`;
}

/**
 * The single-agent chat's hint: "2m 10s so far, about 3 to 6 min left", "should finish soon" or
 * "taking longer than usual". A tiny helper the chat can place next to its work line.
 */
export function etaHint(
  elapsedMs: number,
  estimate: (EtaRange & { basis?: EtaBasis }) | null | undefined,
): string {
  const so = `${formatDuration(Math.max(0, elapsedMs))} so far`;
  if (!estimate || estimate.high <= 0) return so;
  const guess = estimate.basis === "guess" ? " (first guess)" : "";
  if (elapsedMs > estimate.high) return `${so}, taking longer than usual`;
  if (elapsedMs >= estimate.low) return `${so}, should finish soon${guess}`;
  const left = { low: Math.max(0, estimate.low - elapsedMs), high: estimate.high - elapsedMs };
  return `${so}, ${aboutEta(left)} left${guess}`;
}

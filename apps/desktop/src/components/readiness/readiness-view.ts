import type { ReadinessCheck, ReadinessReport, ReadinessState, ReadinessVerdict } from "@depo/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  type LucideIcon,
  TriangleAlert,
  XCircle,
} from "lucide-react";

/** The short text of the pill and the badge: "Ready", "2 warnings", "Not ready". */
export function shortVerdict(r: Pick<ReadinessReport, "verdict" | "warnings">): string {
  if (r.verdict === "not_ready") return "Not ready";
  if (r.verdict === "ready_with_warnings") return `${r.warnings} warning${r.warnings === 1 ? "" : "s"}`;
  return "Ready";
}

/** Icon and colour per verdict; the text always says the same, so colour is never the only cue. */
export const VERDICT_STYLE: Record<ReadinessVerdict, { icon: LucideIcon; text: string; pill: string }> = {
  ready: { icon: CheckCircle2, text: "text-success", pill: "border-success/40 bg-success/10 text-success" },
  ready_with_warnings: {
    icon: AlertTriangle,
    text: "text-warning",
    pill: "border-warning/40 bg-warning/10 text-warning",
  },
  not_ready: { icon: XCircle, text: "text-danger", pill: "border-danger/40 bg-danger/10 text-danger" },
};

/** A different shape per state, and words for screen readers. */
export const STATE_STYLE: Record<ReadinessState, { icon: LucideIcon; tone: string; label: string }> = {
  pass: { icon: CircleCheck, tone: "text-success", label: "Passed" },
  warn: { icon: TriangleAlert, tone: "text-warning", label: "Warning" },
  fail: { icon: CircleX, tone: "text-danger", label: "Failed" },
  stale: { icon: Clock3, tone: "text-warning", label: "Out of date" },
  not_run: { icon: CircleDashed, tone: "text-subtle", label: "Not run" },
};

/** A check that should have run but did not reads as a warning. */
export function stateOf(c: ReadinessCheck): { icon: LucideIcon; tone: string; label: string } {
  if (c.state === "not_run" && c.expected)
    return { icon: Circle, tone: "text-warning", label: "Not run, and it should have" };
  return STATE_STYLE[c.state];
}

const RANK: Record<ReadinessState, number> = { fail: 0, warn: 1, stale: 1, pass: 2, not_run: 3 };

/** Problems first, then what passed, then what did not run. The engine's order breaks ties. */
export function sortChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  const rank = (c: ReadinessCheck) => (c.state === "not_run" && c.expected ? 1 : RANK[c.state]);
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

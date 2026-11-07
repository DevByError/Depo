import { cn } from "@/lib/cn";
import { etaHint } from "@/lib/team-eta";
import { useNow, useTaskEta } from "@/lib/use-team";

/**
 * "2m 10s so far, about 3 to 6 min left": a small elapsed and remaining hint for a running task,
 * from what Depo learned on this PC. Self-contained, so the chat can place it next to its work
 * line: `<EtaHint taskId={id} startedAt={iso} />`. Renders nothing without a start time.
 */
export function EtaHint({
  taskId,
  startedAt,
  className,
}: {
  taskId: string;
  startedAt: string | number | null | undefined;
  className?: string;
}) {
  const eta = useTaskEta(taskId);
  const now = useNow(1000);
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : (startedAt ?? Number.NaN);
  if (Number.isNaN(start)) return null;
  const estimate =
    eta?.single ??
    (eta?.plan
      ? { ...eta.plan, basis: eta.basis === "learned" ? ("learned" as const) : ("guess" as const) }
      : null);
  return (
    <span className={cn("tabular-nums text-subtle", className)} data-testid="eta-hint">
      {etaHint(now - start, estimate)}
    </span>
  );
}

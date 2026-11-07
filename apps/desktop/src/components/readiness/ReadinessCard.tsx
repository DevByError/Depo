import type { ReadinessAction, ReadinessCheck, ReadinessRunKind } from "@depo/shared";
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  type LucideIcon,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { sortChecks, stateOf, VERDICT_STYLE } from "./readiness-view";
import { useReadiness, useReadinessRun } from "./use-readiness";

const RUN_ICON: Record<ReadinessRunKind, LucideIcon> = {
  tests: FlaskConical,
  page: ScanSearch,
  security: ShieldCheck,
};
const RUN_ORDER: ReadinessRunKind[] = ["tests", "page", "security"];
const RUNNING_TEXT: Record<ReadinessRunKind, string> = {
  tests: "Running the tests in the private copy.",
  page: "Checking the page. Depo starts the app first if it is not running.",
  security: "Scanning the private copy.",
};

/**
 * One honest answer at review time: is this ready to apply? The verdict, every check with its
 * evidence, and buttons to run the tests, check the page or scan the copy right here.
 */
export function ReadinessCard({
  taskId,
  className,
  scrollable = false,
}: {
  taskId: string;
  className?: string;
  /** Inside a popover with a height limit: reachable by keyboard so it can be scrolled. */
  scrollable?: boolean;
}) {
  const report = useReadiness(taskId);
  const run = useReadinessRun(taskId);
  const r = report.data;
  if (!r) {
    return (
      <section
        aria-label="Readiness"
        className={cn("rounded-lg border border-border bg-panel px-4 py-3 text-xs text-muted", className)}
      >
        {report.isError
          ? `Readiness is not available: ${(report.error as Error).message}`
          : "Reading the checks of this change…"}
      </section>
    );
  }
  const style = VERDICT_STYLE[r.verdict];
  const Icon = style.icon;
  const actions = RUN_ORDER.map((k) => r.checks.find((c) => c.action?.run === k)?.action).filter(
    (a): a is ReadinessAction => !!a,
  );
  const runningKind = run.isPending ? run.variables : null;
  const error = run.error as Error | null;
  return (
    <section
      aria-label="Readiness"
      tabIndex={scrollable ? 0 : undefined}
      className={cn("flex flex-col gap-2 rounded-lg border border-border bg-panel px-4 py-3", className)}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", style.text)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("text-[13px] font-semibold", style.text)}>{r.headline}</p>
          {r.reasons.length > 0 && (
            <p className="text-xs text-muted">
              {r.reasons.map((x) => x[0]?.toUpperCase() + x.slice(1)).join(". ")}.
            </p>
          )}
        </div>
        {report.isFetching && (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-subtle" aria-label="Updating" />
        )}
      </div>
      <ul aria-label="Checks" className="-mx-1.5 flex flex-col">
        {sortChecks(r.checks).map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((a) => {
            const busy = a.running || runningKind === a.run;
            const RunIcon = RUN_ICON[a.run];
            return (
              <Button
                key={a.run}
                size="sm"
                variant="secondary"
                title={a.detail}
                disabled={busy || run.isPending}
                onClick={() => run.mutate(a.run)}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RunIcon aria-hidden />} {a.label}
              </Button>
            );
          })}
        </div>
      )}
      <p role="status" className={cn("text-xs text-muted", !runningKind && !run.data && "sr-only")}>
        {runningKind ? RUNNING_TEXT[runningKind] : run.isSuccess ? run.data.message : ""}
      </p>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** Items with a stable key each (two open comments can read the same). */
function keyed<T extends { text: string }>(items: T[]): (T & { key: string })[] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const n = seen.get(i.text) ?? 0;
    seen.set(i.text, n + 1);
    return { ...i, key: n ? `${i.text}#${n}` : i.text };
  });
}

function CheckRow({ check: c }: { check: ReadinessCheck }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const s = stateOf(c);
  const StateIcon = s.icon;
  const more = c.evidence.length > 0 || c.items.length > 0;
  const line = (
    <>
      <StateIcon className={cn("size-3.5 shrink-0", s.tone)} aria-hidden />
      <span className="sr-only">{s.label}:</span>{" "}
      <span className="w-28 shrink-0 font-medium text-fg">{c.label}</span>
      <span className={cn("min-w-0 flex-1 text-muted", !open && "truncate")}>{c.summary}</span>
    </>
  );
  if (!more)
    return (
      <li className="flex min-h-6 items-center gap-2 px-1.5 py-1 text-xs">
        {line}
        <span className="size-3.5 shrink-0" aria-hidden />
      </li>
    );
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-6 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-hover"
      >
        {line}
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-subtle" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
        )}
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-1 pb-1.5 pl-7 pr-1.5 text-xs text-muted">
          {c.evidence.length > 0 && (
            <ul aria-label={`${c.label} evidence`} className="flex flex-col gap-0.5">
              {c.evidence.map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          )}
          {c.items.length > 0 && (
            <ul aria-label={`${c.label} details`} className="flex flex-col gap-0.5">
              {keyed(c.items).map((i) => (
                <li key={i.key} className="flex items-start gap-1.5 break-words">
                  <span
                    className={cn(
                      "shrink-0",
                      i.ok === true ? "text-success" : i.ok === false ? "text-warning" : "text-subtle",
                    )}
                    aria-hidden
                  >
                    {i.ok === true ? "✓" : i.ok === false ? "✗" : "•"}
                  </span>
                  <span className="sr-only">{i.ok === true ? "Met: " : i.ok === false ? "Open: " : ""}</span>
                  <span className="min-w-0">{i.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

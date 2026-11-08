import { type PlanStep, type PlanStepStatus, planProgress, type StepPlan } from "@depo/shared";
import { AlertTriangle, Circle, CircleCheck, ListChecks, Loader2, MinusCircle } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Depo's step plan for a turn (ADR-0086): every step it will take, shown before the model starts
 * and updated live. Steps Depo added later (fixes for what the final check found) are marked.
 */

const STATUS_WORD: Record<PlanStepStatus, string> = {
  pending: "To do",
  running: "Working on",
  done: "Done",
  blocked: "Not done yet",
  skipped: "Skipped",
};

function StepIcon({ status, active }: { status: PlanStepStatus; active: boolean }) {
  const cls = "mt-px size-3.5 shrink-0";
  switch (status) {
    case "done":
      return <CircleCheck className={cn(cls, "text-success")} aria-hidden />;
    case "running":
      return active ? (
        <Loader2 className={cn(cls, "animate-spin text-accent")} aria-hidden />
      ) : (
        <Circle className={cn(cls, "text-accent")} aria-hidden />
      );
    case "blocked":
      return <AlertTriangle className={cn(cls, "text-warning")} aria-hidden />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-subtle")} aria-hidden />;
    default:
      return <Circle className={cn(cls, "text-subtle")} aria-hidden />;
  }
}

/** The small grey line under a step: the try, the model, or why it is not done. */
export function stepNote(step: PlanStep, active: boolean): string | null {
  if (step.status === "running" && active) {
    const parts = [step.tries > 1 ? `try ${step.tries}` : null, step.model].filter(Boolean);
    const head = parts.join(" · ");
    return step.note ? (head ? `${head} · ${step.note}` : step.note) : head || null;
  }
  return step.note;
}

export function StepPlanCard({ plan, active }: { plan: StepPlan; active: boolean }) {
  const { done, total } = planProgress(plan);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <section
      aria-label="Depo's plan"
      className="rounded-lg border border-border bg-panel"
      data-testid="step-plan"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListChecks className="size-3.5 shrink-0 text-accent" aria-hidden />
        <h2 className="text-xs font-semibold text-fg">Plan</h2>
        <span className="text-xs text-muted tabular-nums">
          {done} of {total} done
        </span>
        <div
          className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-label="Steps done"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </header>
      <ol className="flex flex-col py-1">
        {plan.steps.map((s) => {
          const note = stepNote(s, active);
          return (
            <li key={s.id} className="flex items-start gap-2 px-3 py-1 text-xs" data-status={s.status}>
              <StepIcon status={s.status} active={active} />
              <div className="min-w-0 flex-1">
                <span className="sr-only">{STATUS_WORD[s.status]}: </span>
                <span
                  className={cn(
                    "break-words",
                    s.status === "running" && active
                      ? "font-medium text-fg"
                      : s.status === "pending"
                        ? "text-muted"
                        : "text-fg",
                  )}
                >
                  {s.title}
                </span>
                {s.added && (
                  <span className="ml-1.5 rounded bg-accent-soft px-1 text-[10.5px] text-accent">added</span>
                )}
                {note && (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-[11px]",
                      s.status === "blocked" ? "text-warning" : "text-subtle",
                    )}
                  >
                    {note}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

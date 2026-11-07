import { ClipboardList } from "lucide-react";
import type { ParsedPlan } from "@/lib/step-summary";
import { AgentChip } from "./AgentChip";

/** The Manager's plan in a team run: numbered tasks, each with the agent that owns it. */
export function PlanCard({ plan }: { plan: ParsedPlan }) {
  const n = plan.tasks.length;
  return (
    <section aria-label="Team plan" className="rounded-lg border border-border bg-panel">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <ClipboardList className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-fg">
            Plan · {n} task{n === 1 ? "" : "s"}
          </h2>
          {plan.summary && <p className="mt-0.5 text-xs leading-relaxed text-muted">{plan.summary}</p>}
        </div>
      </header>
      <ol className="flex flex-col py-1">
        {plan.tasks.map((t) => (
          <li key={`${t.n}-${t.title}`} className="flex items-baseline gap-2 px-3 py-1 text-xs">
            <span className="w-4 shrink-0 text-right text-subtle tabular-nums">{t.n}.</span>
            <AgentChip agent={t.owner} />
            <span className="min-w-0 flex-1 text-fg">
              {t.title}
              {t.after.length > 0 && <span className="text-subtle"> · after {t.after.join(", ")}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

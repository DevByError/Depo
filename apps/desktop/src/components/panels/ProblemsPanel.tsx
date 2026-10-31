import { CheckCircle2 } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { EVENT_STYLE, TONE_TEXT } from "@/lib/event-style";
import { formatClock } from "@/lib/format";
import { useEngine } from "@/store/engine";

export function ProblemsPanel() {
  const events = useEngine((s) => s.events);
  const problems = useMemo(() => events.filter((e) => e.type === "error" || e.type === "warning"), [events]);
  if (problems.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
        <CheckCircle2 className="size-4 text-success" aria-hidden /> No problems reported.
      </div>
    );
  }
  return (
    <ul className="h-full overflow-y-auto text-xs" tabIndex={0} aria-label="Problems">
      {problems.map((e) => {
        const s = EVENT_STYLE[e.type];
        const Icon = s.icon;
        return (
          <li key={e.id} className="flex items-start gap-2 border-b border-border/60 px-3 py-1.5">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_TEXT[s.tone])} aria-hidden />
            <span className="flex-1 text-muted">{e.text}</span>
            <time className="tabular-nums text-subtle">{formatClock(e.ts)}</time>
          </li>
        );
      })}
    </ul>
  );
}

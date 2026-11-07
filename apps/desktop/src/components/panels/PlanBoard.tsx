import type { AgentMessage } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { Clock, ListChecks, UsersRound } from "lucide-react";
import { useMemo } from "react";
import { BoardView } from "@/components/team/BoardView";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { agentName } from "@/lib/step-summary";
import { etaAt, etaBasisText, totalEtaText } from "@/lib/team-eta";
import { ACTIVE_TASK } from "@/lib/team-view";
import { useTeamView } from "@/lib/use-team";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/**
 * The plan as a board, live: the same columns, cards and time left as the Team tab's Board mode,
 * plus the messages the agents sent each other. The Team tab has the graph, the agents and the replay.
 */
export function PlanBoard() {
  const status = useEngine((s) => s.status);
  const taskId = useUi((s) => s.taskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const { view, eta, t } = useTeamView(taskId);
  const team = useQuery({
    queryKey: ["team", taskId],
    queryFn: () => call("team.get", { taskId: taskId ?? "" }),
    enabled: status === "open" && !!taskId,
  });
  const plan = view?.plan ?? null;
  const active = !!view && ACTIVE_TASK.includes(view.status);
  const left = useMemo(() => (view && active ? etaAt(view, eta, t) : null), [view, active, eta, t]);

  if (!taskId || !plan) {
    return (
      <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-2 px-6 text-center">
        <ListChecks className="size-8 text-subtle" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">No plan yet</h2>
        <p className="text-[13px] leading-relaxed text-muted">
          Start a task in the Chat tab with a work mode such as Full system or Backend only. The Manager turns
          your request into a task graph, and it appears here as a board you can follow while the team works.
        </p>
      </div>
    );
  }
  const done = plan.nodes.filter((n) => n.status === "done").length;
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-panel px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Plan</h2>
        <span className="text-xs tabular-nums text-muted" data-testid="plan-progress">
          {done} of {plan.nodes.length} tasks done
        </span>
        {left && (
          <span
            className="inline-flex items-center gap-1 text-xs tabular-nums text-muted"
            title={etaBasisText(left.basis, left.samples)}
            data-testid="plan-eta"
          >
            <Clock className="size-3.5 text-subtle" aria-hidden />
            {totalEtaText(left.total)} left on this PC
            {left.basis === "guess" && <span className="text-subtle">(first guess)</span>}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-subtle">{plan.summary}</span>
        <Button size="sm" variant="secondary" onClick={() => setCenterTab("team")}>
          <UsersRound aria-hidden />
          Open Team view
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <BoardView plan={plan} etas={left?.nodes ?? null} />
      </div>
      <Messages messages={team.data?.messages ?? []} />
    </div>
  );
}

function Messages({ messages }: { messages: AgentMessage[] }) {
  if (messages.length === 0) return null;
  const recent = messages.slice(-30).reverse();
  return (
    <details className="shrink-0 border-t border-border bg-panel px-4 py-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        Messages between agents ({messages.length})
      </summary>
      <ol
        className="mt-2 max-h-48 overflow-y-auto"
        tabIndex={0}
        aria-label="Messages between agents, newest first"
      >
        {recent.map((m) => (
          <li key={m.id} className="border-b border-border/50 py-1 last:border-0">
            <span className="text-fg">{agentName(m.from)}</span>
            <span className="text-subtle"> to </span>
            <span className="text-fg">{agentName(m.to)}</span>
            <span className="ml-2 rounded bg-hover px-1 text-[10px] uppercase text-muted">{m.type}</span>
            <span className="ml-2 text-muted">{m.summary.slice(0, 160)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

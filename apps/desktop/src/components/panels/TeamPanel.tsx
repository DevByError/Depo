import type { TaskStatus } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Hourglass, Loader2, MessageSquare, UsersRound } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { AgentAvatar } from "@/components/team/AgentAvatar";
import { AgentCard } from "@/components/team/AgentCard";
import { DecisionTimeline } from "@/components/team/DecisionTimeline";
import { PlanGraph } from "@/components/team/PlanGraph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatDuration } from "@/lib/format";
import { ACTIVE_TASK, type LiveTeam, MODE_LABEL, TASK_STATUS_TEXT, teamTotals } from "@/lib/team-view";
import { useNow, useReducedMotion, useTeamView } from "@/lib/use-team";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: "bg-info/12 text-info",
  running: "bg-accent-soft text-accent",
  waiting: "bg-warning/12 text-warning",
  review: "bg-success/12 text-success",
  done: "bg-raised text-muted",
  failed: "bg-danger/12 text-danger",
  cancelled: "bg-raised text-muted",
};

/**
 * Mission control for a team run: the task graph, one live card per agent, and every decision
 * the agents make, as they make it.
 */
export function TeamPanel() {
  const connected = useEngine((s) => s.status === "open");
  const taskId = useUi((s) => s.taskId);
  const { view, loading, error } = useTeamView(taskId);

  if (!connected) {
    return (
      <Empty icon={Loader2} spin title="Connecting to the engine">
        The team view appears as soon as the engine answers.
      </Empty>
    );
  }
  if (!taskId) {
    return (
      <Empty icon={UsersRound} title="Watch the team work" action>
        Start a task in Chat and pick a work mode other than Single agent, such as Full system or Backend
        only. The Manager plans the work, and here you see every agent and every decision live.
      </Empty>
    );
  }
  if (error) {
    return (
      <Empty icon={CircleAlert} title="The team view could not load">
        {error}
      </Empty>
    );
  }
  if (loading || !view) {
    return (
      <Empty icon={Loader2} spin title="Loading the team">
        One moment.
      </Empty>
    );
  }
  if (view.mode === "single") {
    return (
      <Empty icon={UsersRound} title="This task uses a single agent" action>
        The team view follows tasks run by the agent team. Start a new task in Chat and pick a work mode such
        as Full system or Backend only to see the agents plan, build, review and decide.
      </Empty>
    );
  }
  return <MissionControl view={view} taskId={taskId} />;
}

function MissionControl({ view, taskId }: { view: LiveTeam; taskId: string }) {
  const projectId = useUi((s) => s.projectId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const reduced = useReducedMotion();
  const [filter, setFilter] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const active = ACTIVE_TASK.includes(view.status);
  const now = useNow(active ? 15_000 : null);
  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId: projectId ?? "" }),
    enabled: !!projectId,
  });
  const title = tasks.data?.tasks.find((t) => t.id === taskId)?.title ?? "Team run";
  const nodes = useMemo(() => new Map((view.plan?.nodes ?? []).map((n) => [n.id, n])), [view.plan]);
  const totals = teamTotals(view);
  const elapsed = view.agents.find((a) => a.id === "manager")?.workMs ?? 0;
  // An open approval (the plan, or a command) puts the run on hold until the person answers.
  const waitingFor = active ? view.agents.find((a) => a.state === "waiting") : undefined;
  const status: TaskStatus = waitingFor ? "waiting" : view.status;

  const showNode = (id: string) => {
    setHighlight(id);
    window.setTimeout(() => setHighlight((h) => (h === id ? null : h)), 2400);
  };

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-bg">
      <header className="shrink-0 border-b border-border bg-panel px-4 pt-3 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="min-w-0 truncate text-sm font-semibold text-fg">{title}</h2>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
              STATUS_STYLE[status],
            )}
            data-testid="team-status"
          >
            {active && (
              <span className="relative flex size-1.5" aria-hidden>
                <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                <span className="relative inline-flex size-1.5 rounded-full bg-current" />
              </span>
            )}
            {TASK_STATUS_TEXT[status]}
          </span>
          <span className="shrink-0 text-xs text-subtle">{MODE_LABEL[view.mode] ?? view.mode}</span>
        </div>
        {view.plan?.summary && (
          <p className="mt-1 line-clamp-1 max-w-4xl text-xs text-muted" title={view.plan.summary}>
            {view.plan.summary}
          </p>
        )}
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
          <Stat label="Progress">
            <span>
              {totals.done}
              <span className="text-subtle">/{totals.total}</span>
            </span>
            <span className="relative ml-2 inline-block h-1 w-14 overflow-hidden rounded-full bg-hover align-middle">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${totals.total ? (totals.done / totals.total) * 100 : 0}%` }}
              />
            </span>
          </Stat>
          <Stat label="Agents at work">
            {totals.busy}
            <span className="text-subtle"> of {totals.agents}</span>
          </Stat>
          <Stat label="Decisions">{totals.decisions}</Stat>
          <Stat
            label={
              <>
                Reviews
                {totals.changes > 0 && <span className="text-warning"> · {totals.changes} sent back</span>}
              </>
            }
          >
            {totals.approved}
            <span className="text-xs font-normal text-subtle"> approved</span>
          </Stat>
          <Stat label={active ? "Elapsed" : "Run time"}>{formatDuration(elapsed)}</Stat>
        </dl>
        {waitingFor && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-fg">
            <Hourglass className="size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">
              {waitingFor.id === "manager"
                ? "The Manager is waiting for you to approve the plan."
                : `${waitingFor.name} is waiting for your approval.`}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setCenterTab("chat")}>
              Review in Chat
            </Button>
          </div>
        )}
      </header>

      <section
        tabIndex={0}
        aria-label="Team view"
        className="min-h-0 flex-1 overflow-y-auto @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)] @3xl:grid-rows-1 @3xl:overflow-hidden"
      >
        <section
          tabIndex={0}
          aria-label="Plan and agents"
          className="flex min-w-0 flex-col gap-4 p-4 @3xl:min-h-0 @3xl:overflow-y-auto"
        >
          {view.plan ? (
            <PlanGraph plan={view.plan} highlight={highlight} reducedMotion={reduced} />
          ) : (
            <div className="flex shrink-0 items-center gap-3 rounded-xl border border-dashed border-border-strong bg-panel px-4 py-5">
              <AgentAvatar id="manager" name="Manager" busy />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-fg">The Manager is planning the work</p>
                <p className="text-xs text-muted">The task graph appears here once the plan is ready.</p>
              </div>
            </div>
          )}

          <section aria-labelledby="team-agents-title" className="shrink-0">
            <div className="mb-2 flex items-baseline gap-2">
              <h3 id="team-agents-title" className="text-xs font-semibold text-fg">
                Agents
              </h3>
              <span className="text-[11px] text-subtle">
                {filter
                  ? "Showing one agent's decisions. Select the card again to see all."
                  : "Select a card to see only that agent's decisions."}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2.5">
              {view.agents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  now={now}
                  selected={filter === a.id}
                  onSelect={() => setFilter((f) => (f === a.id ? null : a.id))}
                />
              ))}
            </div>
          </section>
        </section>

        <div className="flex min-h-0 flex-col border-t border-border bg-panel @3xl:border-t-0 @3xl:border-l">
          <DecisionTimeline
            decisions={view.decisions}
            nodes={nodes}
            filter={filter}
            onClearFilter={() => setFilter(null)}
            onNode={showNode}
            reducedMotion={reduced}
          />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg px-3 py-2">
      <dt className="truncate text-[11px] text-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-[15px] leading-5 font-semibold tabular-nums text-fg">{children}</dd>
    </div>
  );
}

function Empty({
  icon: Icon,
  title,
  children,
  spin = false,
  action = false,
}: {
  icon: typeof UsersRound;
  title: string;
  children: ReactNode;
  spin?: boolean;
  action?: boolean;
}) {
  const setCenterTab = useUi((s) => s.setCenterTab);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-raised text-muted">
          <Icon className={cn("size-5", spin && "motion-safe:animate-spin")} aria-hidden />
        </div>
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{children}</p>
        {action && (
          <Button className="mt-4" variant="primary" onClick={() => setCenterTab("chat")}>
            <MessageSquare aria-hidden />
            Open Chat
          </Button>
        )}
      </div>
    </div>
  );
}

import type { TaskStatus } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  Columns3,
  Hourglass,
  Loader2,
  MessageSquare,
  Rewind,
  UsersRound,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ReadinessPill } from "@/components/readiness/ReadinessPill";
import { AgentAvatar } from "@/components/team/AgentAvatar";
import { AgentCard } from "@/components/team/AgentCard";
import { BoardView } from "@/components/team/BoardView";
import { DecisionTimeline } from "@/components/team/DecisionTimeline";
import { PlanGraph } from "@/components/team/PlanGraph";
import { ReplayBar } from "@/components/team/ReplayBar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatClock, formatDuration } from "@/lib/format";
import { etaAt, etaBasisText, totalEtaText } from "@/lib/team-eta";
import { ACTIVE_TASK, MODE_LABEL, TASK_STATUS_TEXT, teamTotals } from "@/lib/team-view";
import { type ReplayPlayer, useReplayPlayer } from "@/lib/use-replay";
import { type TeamViewResult, useNow, useReducedMotion, useTeamView } from "@/lib/use-team";
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

type PlanMode = "graph" | "board";
const MODE_KEY = "depo.team.planMode";

function readMode(): PlanMode {
  try {
    return localStorage.getItem(MODE_KEY) === "board" ? "board" : "graph";
  } catch {
    return "graph";
  }
}

/**
 * Mission control for a team run: the task graph (or the board), one live card per agent, and every
 * decision the agents make, as they make it. A film strip under the header replays the run: the
 * whole screen shows the team as it was at the moment picked.
 */
export function TeamPanel() {
  const connected = useEngine((s) => s.status === "open");
  const taskId = useUi((s) => s.taskId);
  const player = useReplayPlayer(taskId);
  const team = useTeamView(taskId, { cursor: player.cursor });
  player.sync(team.replay, team.edge);
  const { view, loading, error } = team;

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
  return <MissionControl team={{ ...team, view }} player={player} taskId={taskId} />;
}

function MissionControl({
  team,
  player,
  taskId,
}: {
  team: TeamViewResult & { view: NonNullable<TeamViewResult["view"]> };
  player: ReplayPlayer;
  taskId: string;
}) {
  const { view, replay, t, edge, live } = team;
  const projectId = useUi((s) => s.projectId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const moment = useUi((s) => s.teamMoment);
  const clearMoment = useUi((s) => s.clearTeamMoment);
  const reduced = useReducedMotion();
  const [filter, setFilter] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [mode, setModeState] = useState<PlanMode>(readMode);
  const active = ACTIVE_TASK.includes(view.status);
  const wall = useNow(active ? 15_000 : null);
  // Relative times ("2m ago") are relative to the moment shown.
  const now = live ? wall : t;
  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId: projectId ?? "" }),
    enabled: !!projectId,
  });
  const title = tasks.data?.tasks.find((x) => x.id === taskId)?.title ?? "Team run";
  const nodes = useMemo(() => new Map((view.plan?.nodes ?? []).map((n) => [n.id, n])), [view.plan]);
  const totals = teamTotals(view);
  const elapsed = view.agents.find((a) => a.id === "manager")?.workMs ?? 0;
  // An open approval (the plan, or a command) puts the run on hold until the person answers.
  const waitingFor = active ? view.agents.find((a) => a.state === "waiting") : undefined;
  const status: TaskStatus = waitingFor ? "waiting" : view.status;
  const eta = useMemo(() => (active ? etaAt(view, team.eta, t) : null), [active, view, team.eta, t]);
  const upcoming = useMemo(
    () => (replay && !live ? replay.decisions.slice(view.decisions.length) : []),
    [replay, live, view.decisions.length],
  );

  // A shared moment opens here once the run's events are in.
  useEffect(() => {
    if (!moment || moment.taskId !== taskId || !replay) return;
    player.pause();
    player.seek(replay.start + moment.atMs);
    clearMoment();
  }, [moment, taskId, replay, player, clearMoment]);

  const setMode = (m: PlanMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // The choice is only remembered while storage works.
    }
  };
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
            {active && live && (
              <span className="relative flex size-1.5" aria-hidden>
                <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                <span className="relative inline-flex size-1.5 rounded-full bg-current" />
              </span>
            )}
            {TASK_STATUS_TEXT[status]}
          </span>
          <span className="shrink-0 text-xs text-subtle">{MODE_LABEL[view.mode] ?? view.mode}</span>
          {live && view.status === "review" && <ReadinessPill taskId={taskId} align="start" />}
          {!live && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
              data-testid="replay-badge"
            >
              <Rewind className="size-3" aria-hidden />
              Replay at {formatClock(new Date(t).toISOString())}
            </span>
          )}
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
          {eta && (
            <Stat
              label={
                <>
                  {live ? "Time left" : "Time left then"}
                  {eta.basis === "guess" && (
                    <>
                      <span className="hidden text-subtle @4xl:inline"> · first guess</span>
                      <span className="text-subtle @4xl:hidden"> · guess</span>
                    </>
                  )}
                </>
              }
              title={etaBasisText(eta.basis, eta.samples)}
              testId="team-eta"
            >
              {totalEtaText(eta.total)}
              <span className="hidden text-xs font-normal text-subtle @4xl:inline"> on this PC</span>
            </Stat>
          )}
        </dl>
        {waitingFor && live && (
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

      {replay && (
        <ReplayBar
          index={replay}
          player={player}
          t={t}
          edge={edge}
          live={live}
          active={team.active}
          taskId={taskId}
          projectId={projectId}
        />
      )}

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
            <div className="flex shrink-0 flex-col gap-2">
              <fieldset className="flex items-center gap-2 self-end">
                <legend className="sr-only">Show the plan as</legend>
                <ModeButton current={mode} value="graph" onPick={setMode} icon={Workflow}>
                  Graph
                </ModeButton>
                <ModeButton current={mode} value="board" onPick={setMode} icon={Columns3}>
                  Board
                </ModeButton>
              </fieldset>
              {mode === "graph" ? (
                <PlanGraph
                  plan={view.plan}
                  highlight={highlight}
                  reducedMotion={reduced}
                  etas={eta?.nodes ?? null}
                />
              ) : (
                <BoardView plan={view.plan} etas={eta?.nodes ?? null} highlight={highlight} />
              )}
            </div>
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
            upcoming={upcoming}
          />
        </div>
      </section>
    </div>
  );
}

function ModeButton({
  current,
  value,
  onPick,
  icon: Icon,
  children,
}: {
  current: PlanMode;
  value: PlanMode;
  onPick(m: PlanMode): void;
  icon: typeof Workflow;
  children: ReactNode;
}) {
  const on = current === value;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onPick(value)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        on
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-border text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

function Stat({
  label,
  children,
  title,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-lg border border-border bg-bg px-3 py-2"
      title={title}
      data-testid={testId}
    >
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

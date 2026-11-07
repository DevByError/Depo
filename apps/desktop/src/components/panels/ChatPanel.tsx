import type { ChatItem, DepoEvent, Task, TaskStatus } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, FileDiff, FlaskConical, HardDrive, Plus, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { ApprovalCard } from "@/components/chat/ApprovalCard";
import { Composer } from "@/components/chat/Composer";
import { PlanCard } from "@/components/chat/PlanCard";
import { SteerNote } from "@/components/chat/SteerNote";
import { type LiveStep, WorkLog, type WorkState } from "@/components/chat/WorkLog";
import { RunningAppLink } from "@/components/qa/RunningAppLink";
import { EtaHint } from "@/components/team/EtaHint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { describeNote, formatDuration, type ParsedPlan, parsePlan } from "@/lib/step-summary";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { connectionLabel } from "./ConnectionBadge";
import { Markdown } from "./Markdown";

export { formatDuration } from "@/lib/step-summary";

const PILLARS = [
  {
    icon: HardDrive,
    title: "Fully local",
    text: "Models run on this PC through Ollama, llama.cpp or LM Studio. No cloud, no login.",
  },
  {
    icon: ShieldCheck,
    title: "Safe edits",
    text: "Agents build and test in a shadow copy. You approve every change before it lands.",
  },
  {
    icon: FlaskConical,
    title: "Tested work",
    text: "The agent runs your tests in the copy and fixes what fails before handing over.",
  },
];

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "Starting",
  running: "Working",
  waiting: "Needs you",
  review: "Ready for review",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};
const STATUS_DOT: Record<TaskStatus, string> = {
  queued: "bg-info",
  running: "bg-accent animate-pulse",
  waiting: "bg-warning",
  review: "bg-success",
  done: "bg-subtle",
  failed: "bg-danger",
  cancelled: "bg-subtle",
};

export const isActive = (s: TaskStatus | undefined) => s === "queued" || s === "running" || s === "waiting";

export function ChatPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const taskId = useUi((s) => s.taskId);
  const setTaskId = useUi((s) => s.setTaskId);
  const enabled = status === "open" && !!projectId;

  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId: projectId ?? "" }),
    enabled,
  });
  const task = useQuery({
    queryKey: ["tasks", "get", taskId],
    queryFn: () => call("tasks.get", { id: taskId ?? "" }),
    enabled: enabled && !!taskId,
  });
  const list = tasks.data?.tasks ?? [];
  const open = taskId && task.data ? task.data : null;
  // Follow new content only while the reader is at the end; opening a task starts at the end.
  const stick = useStickToBottom<HTMLElement, HTMLDivElement>({
    resetKey: taskId,
    count: open?.messages.length ?? 0,
    anchorSelector: "li",
  });

  return (
    <div className="flex h-full min-h-0">
      {projectId && <TaskList tasks={list} current={taskId} onSelect={setTaskId} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <section
            ref={stick.scrollRef}
            id="chat-scroll"
            tabIndex={0}
            aria-label="Chat transcript"
            className="h-full overflow-y-auto focus-visible:-outline-offset-2"
          >
            <div ref={stick.contentRef}>
              {open ? (
                <Transcript task={open.task} items={open.messages} />
              ) : taskId && enabled && task.isPending ? null : (
                <Welcome hasProject={!!projectId} />
              )}
            </div>
          </section>
          {open && !stick.pinned && <JumpToLatest count={stick.newCount} onClick={stick.jumpToLatest} />}
        </div>
        <Composer task={taskId ? task.data?.task : undefined} onSent={stick.jumpToLatest} />
      </div>
    </div>
  );
}

function JumpToLatest({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-raised py-1 pr-3 pl-2 text-xs font-medium text-fg shadow-pop transition-colors hover:bg-hover"
    >
      <ArrowDown className="size-3.5 text-accent" aria-hidden />
      Jump to latest
      {count > 0 && (
        <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent tabular-nums">
          {count} new
        </span>
      )}
    </button>
  );
}

function TaskList({
  tasks,
  current,
  onSelect,
}: {
  tasks: Task[];
  current: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <nav aria-label="Tasks" className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
      <div className="p-2">
        <Button
          className="w-full justify-start"
          onClick={() => onSelect(null)}
          aria-pressed={current === null}
        >
          <Plus aria-hidden /> New task
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={t.id === current ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover",
                t.id === current && "bg-hover",
              )}
            >
              <span className="truncate text-[13px] text-fg">{t.title}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className={cn("size-1.5 rounded-full", STATUS_DOT[t.status])} aria-hidden />
                {STATUS_TEXT[t.status]}
              </span>
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="px-2 py-1 text-xs text-subtle">No tasks yet.</li>}
      </ul>
    </nav>
  );
}

function Welcome({ hasProject }: { hasProject: boolean }) {
  const status = useEngine((s) => s.status);
  const statusError = useEngine((s) => s.statusError);
  return (
    <div className="mx-auto flex max-w-2xl flex-col px-6 pt-16 pb-8">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">What should we build?</h1>
      <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-muted">
        {hasProject
          ? "Ask for a change to this project. The coding agent works in a private copy, runs your tests, and shows you the diff before anything touches your files."
          : "Open a project folder from the sidebar, then describe the change you want."}
      </p>
      {status !== "open" && (
        <div
          role="status"
          className="mt-6 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-fg"
        >
          <strong className="font-medium">Engine: {connectionLabel(status)}.</strong>{" "}
          <span className="text-muted">{statusError ?? "Starting the local engine…"}</span>
        </div>
      )}
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {PILLARS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-lg border border-border bg-panel p-4">
            <Icon className="size-4 text-accent" aria-hidden />
            <h2 className="mt-2 text-[13px] font-semibold text-fg">{title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Latest live state of a task: the streaming reply, and the latest step the engine reported. */
function useLive(taskId: string): { stream: string | null; step: LiveStep | null } {
  const events = useEngine((s) => s.events);
  return useMemo(() => {
    let stream: string | null = null;
    let streamAt = -1;
    let step: DepoEvent | null = null;
    let stepAt = -1;
    for (let i = events.length - 1; i >= Math.max(0, events.length - 400); i--) {
      const e = events[i];
      if (!e || e.taskId !== taskId) continue;
      if (stream === null && e.type === "thinking" && e.ephemeral) {
        const t = e.details?.text;
        stream = typeof t === "string" ? t : e.text;
        streamAt = i;
      }
      if (step === null && e.type !== "thinking" && e.type !== "command_output") {
        step = e;
        stepAt = i;
      }
      if (step && stream !== null) break;
    }
    // "Waiting for qwen3-coder:30b to answer (step 4)" reads as plain "Thinking" in the chat.
    const waiting =
      step?.type === "planning" && step.ephemeral && /^Waiting for .+ to answer/.test(step.text);
    const live: LiveStep | null =
      streamAt > stepAt
        ? { text: "Writing a reply", agent: events[streamAt]?.agent ?? null }
        : step
          ? { text: waiting ? "Thinking" : step.text, agent: step.agent }
          : null;
    return { stream, step: live };
  }, [events, taskId]);
}

function Transcript({ task, items }: { task: Task; items: ChatItem[] }) {
  const active = isActive(task.status);
  const live = useLive(task.id);
  const enabled = useEngine((s) => s.status === "open");
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => call("approvals.list", {}),
    enabled,
  });
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.taskId === task.id);
  const turns = useMemo(() => groupTurns(items, { working: active }), [items, active]);
  const last = turns.length - 1;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{task.title}</h1>
        <span className="flex items-center gap-1.5 text-xs text-muted" data-testid="task-status">
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[task.status])} aria-hidden />
          {STATUS_TEXT[task.status]}
          <RunTime task={task} items={items} />
          {task.model && <span className="text-subtle">· {task.model}</span>}
        </span>
      </header>
      <ol className="flex flex-col gap-7" aria-label="Conversation">
        {turns.map((t, i) => {
          const latest = i === last;
          const state: WorkState =
            latest && active
              ? task.status === "waiting"
                ? "waiting"
                : "working"
              : latest && task.status === "cancelled"
                ? "stopped"
                : "done";
          return (
            <li key={t.user?.id ?? `turn-${i}`}>
              <TurnView
                turn={t}
                id={t.user?.id ?? `${task.id}:${i}`}
                state={state}
                live={latest && active ? live.step : null}
                stream={latest && active ? live.stream : null}
              />
            </li>
          );
        })}
      </ol>
      {mine.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      {task.status === "review" && <ReviewBanner projectId={task.projectId} taskId={task.id} />}
      <p className="sr-only" role="status" aria-live="polite">
        {active ? (task.status === "waiting" ? "The agent needs you." : (live.step?.text ?? "Working")) : ""}
      </p>
    </div>
  );
}

/** One prompt from the user, everything the agent did for it, and its answer. */
export interface Turn {
  user: ChatItem | null;
  steps: ChatItem[];
  answer: ChatItem | null;
  /** "Note from Depo: …", added after the answer (for example when the last test run failed). */
  note: ChatItem | null;
  /** The Manager's plan in a team run, shown as a card instead of a step. */
  plan: { item: ChatItem; plan: ParsedPlan } | null;
  /** Notes the owner sent while this turn worked (queued, read, or not read). */
  notes?: ChatItem[];
}

const isPlanAuthor = (agent: string | null) => !agent || agent.startsWith("manager@");
/** A note sent while the task worked belongs to the turn it was sent in; one that became the next message starts a turn. */
const isSteerNote = (m: ChatItem) => m.role === "user" && !!m.steer && m.steer.state !== "followup";

/**
 * Groups a transcript into turns. While `working`, the latest turn has no answer yet: its newest
 * text is narration between tool calls, so it stays in the steps.
 */
export function groupTurns(items: ChatItem[], opts: { working?: boolean } = {}): Turn[] {
  const turns: Turn[] = [];
  const empty = (user: ChatItem | null): Turn => ({ user, steps: [], answer: null, note: null, plan: null });
  for (const item of items) {
    if (isSteerNote(item)) {
      if (turns.length === 0) turns.push(empty(null));
      const t = turns[turns.length - 1] as Turn;
      t.notes = [...(t.notes ?? []), item];
    } else if (item.role === "user") turns.push(empty(item));
    else {
      if (turns.length === 0) turns.push(empty(null));
      turns[turns.length - 1]?.steps.push(item);
    }
  }
  turns.forEach((t, i) => {
    for (let j = t.steps.length - 1; j >= 0; j--) {
      const s = t.steps[j];
      if (s?.role !== "assistant" || s.isError || !isPlanAuthor(s.agent)) continue;
      const plan = parsePlan(s.text);
      if (plan) {
        t.plan = { item: s, plan };
        t.steps.splice(j, 1);
        break;
      }
    }
    if (opts.working && i === turns.length - 1) return;
    let last = t.steps.at(-1);
    const prev = t.steps.at(-2);
    if (last?.role === "assistant" && /^Note from Depo:/.test(last.text) && prev?.role === "assistant") {
      t.note = t.steps.pop() ?? null;
      last = prev;
    }
    if (last?.role === "assistant" && (last.isError || describeNote(last.text).kind === "note"))
      t.answer = t.steps.pop() ?? null;
  });
  return turns;
}

function TurnView({
  turn,
  id,
  state,
  live,
  stream,
}: {
  turn: Turn;
  id: string;
  state: WorkState;
  live: LiveStep | null;
  stream: string | null;
}) {
  const working = state === "working" || state === "waiting";
  const startedAt = turn.user?.createdAt ?? turn.steps[0]?.createdAt ?? null;
  const endedAt = (turn.note ?? turn.answer ?? turn.steps.at(-1))?.createdAt ?? null;
  // Notes already read sit after the work; ones still waiting for the next step stay at the end.
  const readNotes = (turn.notes ?? []).filter((n) => n.steer?.state !== "queued");
  const queuedNotes = (turn.notes ?? []).filter((n) => n.steer?.state === "queued");
  return (
    <section aria-label={`Prompt: ${turn.user?.text.slice(0, 80) ?? "task"}`} className="flex flex-col gap-3">
      {turn.user && (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-hover px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
            {turn.user.text}
          </div>
          {turn.user.steer?.state === "followup" && (
            <span className="pr-1 text-[11px] text-subtle">
              Sent while the task worked, so it continues with it
            </span>
          )}
        </div>
      )}
      {turn.plan && <PlanCard plan={turn.plan.plan} />}
      {(turn.steps.length > 0 || working) && (
        <WorkLog
          id={id}
          steps={turn.steps}
          state={state}
          startedAt={startedAt}
          endedAt={endedAt}
          live={live}
        />
      )}
      {readNotes.map((n) => (
        <SteerNote key={n.id} item={n} />
      ))}
      {turn.answer && <Answer item={turn.answer} />}
      {turn.note && (
        <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span className="whitespace-pre-wrap">{turn.note.text}</span>
        </div>
      )}
      {stream && (
        <div className="text-[13.5px] leading-relaxed text-fg [&>p:last-of-type]:inline">
          <Markdown text={stream.slice(-6000)} />
          <span
            className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle"
            aria-hidden
          />
        </div>
      )}
      {queuedNotes.map((n) => (
        <SteerNote key={n.id} item={n} />
      ))}
    </section>
  );
}

function Answer({ item }: { item: ChatItem }) {
  if (item.isError) {
    return (
      <div
        role="alert"
        className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-fg"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        <span className="whitespace-pre-wrap">{item.text}</span>
      </div>
    );
  }
  return (
    <div className="text-[13.5px] leading-relaxed text-fg">
      <Markdown text={item.text} />
    </div>
  );
}

function ReviewBanner({ projectId, taskId }: { projectId: string; taskId: string }) {
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-[13px]">
      <FileDiff className="size-4 text-success" aria-hidden />
      <span className="flex-1 text-fg">The changes are ready. Nothing has touched your files yet.</span>
      <RunningAppLink projectId={projectId} taskId={taskId} />
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setChangeSetId(null);
          setCenterTab("diff");
        }}
      >
        Review changes
      </Button>
    </div>
  );
}

/** "for 1m 20s" while working, "took 3m 05s" once the latest run has finished. */
function RunTime({ task, items }: { task: Task; items: ChatItem[] }) {
  const active = isActive(task.status);
  // The latest run starts at the latest user message and ends with the last message after it
  // (the task's own update time also moves when changes are applied later).
  const lastUser = [...items].reverse().find((m) => m.role === "user" && !isSteerNote(m));
  const start = Date.parse(lastUser?.createdAt ?? task.createdAt);
  if (Number.isNaN(start)) return null;
  // While working: elapsed time plus what Depo learned about this PC's speed ("about 2 to 8 min left").
  if (active) return <EtaHint taskId={task.id} startedAt={start} className="text-muted" />;
  const lastItem = items.at(-1);
  const end = Date.parse(lastItem && lastItem !== lastUser ? lastItem.createdAt : task.updatedAt);
  if (Number.isNaN(end) || end < start) return null;
  return <span className="tabular-nums">· took {formatDuration(end - start)}</span>;
}

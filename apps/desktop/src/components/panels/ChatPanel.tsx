import type { ChatItem, DepoEvent, PendingApprovalDto, Task, TaskStatus, WorkMode } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronRight,
  FileDiff,
  FlaskConical,
  HardDrive,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { EVENT_STYLE, TONE_TEXT } from "@/lib/event-style";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { connectionLabel } from "./ConnectionBadge";
import { Markdown } from "./Markdown";

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

const MODES: { id: WorkMode; label: string }[] = [
  { id: "single", label: "Single agent" },
  { id: "full", label: "Full system" },
  { id: "backend", label: "Backend only" },
  { id: "frontend", label: "Frontend only" },
  { id: "ai", label: "AI integration" },
  { id: "import", label: "Study project" },
  { id: "fix", label: "Fix / debug" },
  { id: "refactor", label: "Refactor / upgrade" },
  { id: "ask", label: "Ask / explain" },
  { id: "business", label: "Business" },
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

  return (
    <div className="flex h-full min-h-0">
      {projectId && <TaskList tasks={list} current={taskId} onSelect={setTaskId} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto" id="chat-scroll">
          {taskId && task.data ? (
            <Transcript task={task.data.task} items={task.data.messages} />
          ) : (
            <Welcome hasProject={!!projectId} />
          )}
        </div>
        <Composer task={taskId ? task.data?.task : undefined} />
      </div>
    </div>
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

/** Latest live event of a task: the streaming reply, or the latest step. */
function useLive(taskId: string): { stream: string | null; step: DepoEvent | null } {
  const events = useEngine((s) => s.events);
  return useMemo(() => {
    let stream: string | null = null;
    let step: DepoEvent | null = null;
    for (let i = events.length - 1; i >= Math.max(0, events.length - 400); i--) {
      const e = events[i];
      if (!e || e.taskId !== taskId) continue;
      if (stream === null && e.type === "thinking" && e.ephemeral) {
        const t = e.details?.text;
        stream = typeof t === "string" ? t : e.text;
      }
      if (step === null && e.type !== "thinking") step = e;
      if (step && stream !== null) break;
    }
    return { stream, step };
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
  const turns = useMemo(() => groupTurns(items), [items]);
  const endRef = useRef<HTMLDivElement>(null);
  // Keep the newest content in view while the agent works.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, live.stream, mine.length]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-6">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{task.title}</h1>
        <span className="flex items-center gap-1.5 text-xs text-muted" data-testid="task-status">
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[task.status])} aria-hidden />
          {STATUS_TEXT[task.status]}
          <RunTime task={task} items={items} />
          {task.model && <span className="text-subtle">· {task.model}</span>}
        </span>
      </header>
      <ol className="flex flex-col gap-6" aria-label="Conversation">
        {turns.map((t, i) => (
          <li key={t.user?.id ?? `turn-${i}`}>
            <TurnView turn={t} latest={i === turns.length - 1} working={active && i === turns.length - 1} />
          </li>
        ))}
      </ol>
      {mine.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      {active && <LiveRow stream={live.stream} step={live.step} />}
      {task.status === "review" && <ReviewBanner />}
      <div ref={endRef} />
    </div>
  );
}

/** One prompt from the user, everything the agent did for it, and its answer. */
export interface Turn {
  user: ChatItem | null;
  steps: ChatItem[];
  answer: ChatItem | null;
}

export function groupTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.role === "user") turns.push({ user: item, steps: [], answer: null });
    else {
      if (turns.length === 0) turns.push({ user: null, steps: [], answer: null });
      turns[turns.length - 1]?.steps.push(item);
    }
  }
  for (const t of turns) {
    const last = t.steps.at(-1);
    if (last?.role === "assistant") t.answer = t.steps.pop() ?? null;
  }
  return turns;
}

function TurnView({ turn, working }: { turn: Turn; latest: boolean; working: boolean }) {
  const failed = turn.answer?.isError === true;
  return (
    <section aria-label={`Prompt: ${turn.user?.text.slice(0, 80) ?? "task"}`} className="flex flex-col gap-3">
      {turn.user && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-hover px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
            {turn.user.text}
          </div>
        </div>
      )}
      <div className={cn("flex flex-col gap-2", failed && "text-danger")}>
        {turn.steps.length > 0 && <Process steps={turn.steps} defaultOpen={working} />}
        {turn.answer && <Answer item={turn.answer} />}
      </div>
    </section>
  );
}

function Process({ steps, defaultOpen }: { steps: ChatItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const n = steps.filter((s) => s.role === "tool").length;
  const failedN = steps.filter((s) => s.role === "tool" && s.isError).length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-fg"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        {open ? "Hide" : "Show"} the work ({n} step{n === 1 ? "" : "s"})
        {failedN > 0 && <span className="text-danger"> · {failedN} failed</span>}
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-1.5 border-l border-border pl-3">
          {steps.map((m) => (
            <li key={m.id}>
              {m.role === "tool" ? (
                <ToolRow item={m} />
              ) : (
                <div className={cn("text-xs leading-relaxed", m.isError ? "text-danger" : "text-muted")}>
                  <Markdown text={m.text} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
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

function ToolRow({ item }: { item: ChatItem }) {
  const firstLine = item.text.split("\n")[0] ?? "";
  return (
    <details className="group rounded-md border border-border bg-panel text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted hover:text-fg">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <Wrench
          className={cn("size-3.5 shrink-0", item.isError ? "text-danger" : "text-subtle")}
          aria-hidden
        />
        {item.agent && <span className="text-subtle">{item.agent.split("@")[0]}</span>}
        <span className="font-mono text-fg">{item.toolName}</span>
        <span className={cn("min-w-0 flex-1 truncate", item.isError && "text-danger")}>{firstLine}</span>
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-muted">
        {item.text}
      </pre>
    </details>
  );
}

function LiveRow({ stream, step }: { stream: string | null; step: DepoEvent | null }) {
  const style = step ? EVENT_STYLE[step.type] : null;
  const Icon = style?.icon;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      {stream && (
        <div className="text-[13.5px] leading-relaxed text-fg">
          <Markdown text={stream.slice(-3000)} />
          <span
            className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle"
            aria-hidden
          />
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
        {step && Icon && style ? (
          <>
            <Icon className={cn("size-3.5", TONE_TEXT[style.tone])} aria-hidden />
            <span className="truncate">{step.text}</span>
          </>
        ) : (
          <span>Working…</span>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: PendingApprovalDto }) {
  const qc = useQueryClient();
  const respond = useMutation({
    mutationFn: (approve: boolean) => call("approvals.respond", { id: approval.id, approve }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const command = approval.details?.command;
  const planText = approval.details?.plan;
  return (
    <section
      aria-label="Approval needed"
      className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-[13px]"
    >
      <div className="flex items-center gap-2 font-medium text-fg">
        <ShieldAlert className="size-4 text-warning" aria-hidden />
        {approval.title}
      </div>
      <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{approval.reason}</p>
      {typeof planText === "string" && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-fg">
          {planText}
        </pre>
      )}
      {typeof command === "string" && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs text-fg">
          {command}
        </pre>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" disabled={respond.isPending} onClick={() => respond.mutate(true)}>
          <Check aria-hidden /> Allow
        </Button>
        <Button size="sm" disabled={respond.isPending} onClick={() => respond.mutate(false)}>
          <X aria-hidden /> Decline
        </Button>
      </div>
    </section>
  );
}

function ReviewBanner() {
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-[13px]">
      <FileDiff className="size-4 text-success" aria-hidden />
      <span className="flex-1 text-fg">The changes are ready. Nothing has touched your files yet.</span>
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

function Composer({ task }: { task: Task | undefined }) {
  const connected = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const setTaskId = useUi((s) => s.setTaskId);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<WorkMode>("single");
  const running = isActive(task?.status);

  const send = useMutation({
    mutationFn: (body: string) =>
      call("tasks.send", {
        projectId: projectId ?? "",
        text: body,
        ...(task ? { taskId: task.id } : {}),
        ...(!task && mode !== "single" ? { mode } : {}),
      }),
    onSuccess: (t) => {
      setText("");
      setTaskId(t.id);
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const stop = useMutation({
    mutationFn: () => call("tasks.cancel", { id: task?.id ?? "" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const canSend = connected && !!projectId && !running && text.trim().length > 0 && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate(text.trim());
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const note = !projectId
    ? "Open a project to start."
    : running
      ? "The agent is working. Stop it to send a new message."
      : task
        ? "Send a follow-up to continue this task in the same private copy."
        : "Enter to send, Shift+Enter for a new line.";

  return (
    <div className="border-t border-border bg-panel px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <label htmlFor="composer" className="sr-only">
          Message the coding agent
        </label>
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl border border-border bg-bg p-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent",
            !projectId && "opacity-70",
          )}
        >
          {!task && (
            <div className="self-end">
              <label htmlFor="work-mode" className="sr-only">
                Work mode
              </label>
              <select
                id="work-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as WorkMode)}
                className="h-8 max-w-36 rounded-lg border border-border bg-panel px-2 text-xs text-fg outline-none focus:border-accent"
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <textarea
            id="composer"
            rows={2}
            value={text}
            disabled={!projectId || !connected}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-describedby="composer-note"
            placeholder={task ? "Ask for a follow-up change…" : "e.g. Add a /health endpoint to this API"}
            className="min-h-10 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] text-fg outline-none placeholder:text-subtle field-in-frame"
          />
          {running ? (
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              aria-label="Stop"
              className="flex size-8 items-center justify-center rounded-lg bg-danger text-white disabled:opacity-50"
            >
              <Square className="size-3.5 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg disabled:opacity-50"
            >
              {send.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="size-4" aria-hidden />
              )}
            </button>
          )}
        </div>
        <p id="composer-note" className={cn("mt-2 text-xs", send.isError ? "text-danger" : "text-subtle")}>
          {send.isError ? (send.error as Error).message : note}
        </p>
      </div>
    </div>
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** "for 1m 20s" while working, "took 3m 05s" once the latest run has finished. */
function RunTime({ task, items }: { task: Task; items: ChatItem[] }) {
  const active = isActive(task.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  // The latest run starts at the latest user message; its end is the task's last status change.
  const lastUser = [...items].reverse().find((m) => m.role === "user");
  const start = Date.parse(lastUser?.createdAt ?? task.createdAt);
  if (Number.isNaN(start)) return null;
  if (active) return <span className="tabular-nums">for {formatDuration(now - start)}</span>;
  const end = Date.parse(task.updatedAt);
  if (Number.isNaN(end) || end < start) return null;
  return <span className="tabular-nums">· took {formatDuration(end - start)}</span>;
}

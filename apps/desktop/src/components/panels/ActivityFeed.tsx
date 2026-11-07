import type { DepoEvent, EventType } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  ChevronRight,
  FileText,
  HeartPulse,
  ScrollText,
  Search,
  Terminal,
  TestTube2,
  XCircle,
} from "lucide-react";
import { memo, useDeferredValue, useMemo, useState } from "react";
import { AGENT_SOFT, agentInitials, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { EVENT_STYLE, TONE_TEXT } from "@/lib/event-style";
import { formatBytes, formatClock, formatDuration } from "@/lib/format";
import { agentName } from "@/lib/step-summary";
import { useFollowList } from "@/lib/use-follow-list";
import { useTaskTitles } from "@/lib/use-task-titles";
import { useEngine } from "@/store/engine";
import { type FeedScope, useUi } from "@/store/ui";
import { HeartbeatPulse } from "./HeartbeatPulse";

export function filterEvents(events: DepoEvent[], query: string): DepoEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return events;
  return events.filter(
    (e) => e.text.toLowerCase().includes(q) || e.agent.toLowerCase().includes(q) || e.type.includes(q),
  );
}

/** "This project" keeps the open project's events plus engine-wide ones (no project). */
export function filterByScope(events: DepoEvent[], scope: FeedScope, projectId: string | null): DepoEvent[] {
  if (scope === "all" || !projectId) return events;
  return events.filter((e) => e.projectId === projectId || e.projectId === null);
}

// ---- categories ---------------------------------------------------------------------------------

export type FeedCategory = "files" | "commands" | "tests" | "agents" | "errors";

export const CATEGORIES: { id: FeedCategory; label: string; icon: typeof FileText }[] = [
  { id: "files", label: "Files", icon: FileText },
  { id: "commands", label: "Commands", icon: Terminal },
  { id: "tests", label: "Tests", icon: TestTube2 },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "errors", label: "Errors", icon: XCircle },
];

const CATEGORY_TYPES: Record<Exclude<FeedCategory, "errors">, ReadonlySet<EventType>> = {
  files: new Set<EventType>([
    "reading_file",
    "writing_file",
    "editing_file",
    "searching",
    "applied_changes",
    "checkpoint_created",
    "rendering_screenshot",
  ]),
  commands: new Set<EventType>(["running_command", "command_output", "installing_dependency"]),
  tests: new Set<EventType>(["testing", "test_result", "linting", "security_scan"]),
  agents: new Set<EventType>([
    "thinking",
    "planning",
    "reviewing",
    "handoff",
    "waiting_for_user",
    "retrying",
    "queued",
    "memory_updated",
  ]),
};

/** Errors, warnings, and anything that failed (a red test run, a command that exited badly). */
export function isProblem(e: DepoEvent): boolean {
  return e.type === "error" || e.type === "warning" || e.status === "failed";
}

export function eventCategories(e: DepoEvent): FeedCategory[] {
  const out: FeedCategory[] = [];
  for (const [cat, types] of Object.entries(CATEGORY_TYPES) as [FeedCategory, ReadonlySet<EventType>][]) {
    if (types.has(e.type)) out.push(cat);
  }
  if (e.type === "error" || e.type === "warning") out.push("errors");
  return out;
}

/** No category selected shows everything; otherwise an event must be in one of them. */
export function filterByCategories(
  events: DepoEvent[],
  cats: FeedCategory[],
  errorsOnly: boolean,
): DepoEvent[] {
  if (cats.length === 0 && !errorsOnly) return events;
  return events.filter((e) => {
    if (errorsOnly && !isProblem(e)) return false;
    if (cats.length === 0) return true;
    const mine = eventCategories(e);
    return cats.some((c) => mine.includes(c));
  });
}

// ---- grouping -----------------------------------------------------------------------------------

export type FeedItem =
  | { kind: "group"; key: string; taskId: string; projectId: string | null; count: number }
  | { kind: "event"; key: string; event: DepoEvent; grouped: boolean };

/** A small header before each run of consecutive events from the same task. */
export function groupByTask(events: DepoEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  let header: Extract<FeedItem, { kind: "group" }> | null = null;
  for (const e of events) {
    if (!e.taskId) {
      header = null;
      items.push({ kind: "event", key: e.id, event: e, grouped: false });
      continue;
    }
    if (!header || header.taskId !== e.taskId) {
      header = { kind: "group", key: `grp-${e.id}`, taskId: e.taskId, projectId: e.projectId, count: 0 };
      items.push(header);
    }
    header.count++;
    items.push({ kind: "event", key: e.id, event: e, grouped: true });
  }
  return items;
}

// ---- the feed -----------------------------------------------------------------------------------

export function ActivityFeed() {
  const events = useEngine((s) => s.events);
  const heartbeats = useEngine((s) => s.heartbeats);
  const query = useUi((s) => s.feedQuery);
  const setQuery = useUi((s) => s.setFeedQuery);
  const showHeartbeats = useUi((s) => s.showHeartbeats);
  const setShowHeartbeats = useUi((s) => s.setShowHeartbeats);
  const deferredQuery = useDeferredValue(query);
  const scope = useUi((s) => s.feedScope);
  const setScope = useUi((s) => s.setFeedScope);
  const projectId = useUi((s) => s.projectId);
  const taskId = useUi((s) => s.taskId);
  const openLogs = useUi((s) => s.openLogs);
  const connected = useEngine((s) => s.status === "open");
  const [cats, setCats] = useState<FeedCategory[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => call("projects.list", { includeArchived: true }),
    enabled: connected,
  });
  const names = useMemo(
    () => new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );

  const rows = useMemo(() => {
    const base = showHeartbeats
      ? [...events, ...heartbeats.map((h) => h.event)].sort((a, b) =>
          a.ts === b.ts ? a.seq - b.seq : a.ts.localeCompare(b.ts),
        )
      : events;
    return filterByCategories(
      filterEvents(filterByScope(base, scope, projectId), deferredQuery),
      cats,
      errorsOnly,
    );
  }, [events, heartbeats, showHeartbeats, deferredQuery, scope, projectId, cats, errorsOnly]);
  const items = useMemo(() => groupByTask(rows), [rows]);
  const taskProjects = useMemo(() => [...new Set(rows.map((e) => e.projectId))], [rows]);
  const titles = useTaskTitles(taskProjects);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => stick.ref.current,
    estimateSize: (i) => (items[i]?.kind === "group" ? 26 : 30),
    overscan: 12,
    getItemKey: (i) => items[i]?.key ?? i,
  });
  const stick = useFollowList(items.length, items.at(-1)?.key ?? null, () => {
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
  });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCat = (c: FeedCategory) =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const filtered = query.trim() !== "" || cats.length > 0 || errorsOnly;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <label className="flex h-7 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
          <Search className="size-3.5 text-subtle" aria-hidden />
          <span className="sr-only">Filter activity</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter activity"
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-subtle"
          />
        </label>
        <button
          type="button"
          onClick={() => setShowHeartbeats(!showHeartbeats)}
          aria-pressed={showHeartbeats}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
            showHeartbeats
              ? "border-accent bg-accent-soft text-fg"
              : "border-border text-muted hover:bg-hover",
          )}
        >
          <HeartPulse className="size-3.5" aria-hidden />
          Heartbeats
        </button>
        {taskId && (
          <button
            type="button"
            onClick={() => openLogs(taskId)}
            aria-label="Open logs for this task"
            title="Open logs for this task"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ScrollText className="size-3.5" aria-hidden />
            Logs
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Show activity from">
          {(["project", "all"] as const).map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control; role and aria-checked are set.
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px]",
                scope === s ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {s === "project" ? "This project" : "All projects"}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={errorsOnly}
          onClick={() => setErrorsOnly(!errorsOnly)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors",
            errorsOnly ? "bg-danger/12 text-danger" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <AlertTriangle className="size-3" aria-hidden />
          Errors only
        </button>
      </div>
      <fieldset
        className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5"
        aria-label="Show kinds of activity"
      >
        {CATEGORIES.map(({ id, label, icon: Icon }) => {
          const on = cats.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleCat(id)}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
                on
                  ? "border-accent bg-accent-soft text-fg"
                  : "border-border text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Icon className="size-3" aria-hidden />
              {label}
            </button>
          );
        })}
      </fieldset>

      <LiveHeartbeatRow />

      <div className="relative min-h-0 flex-1">
        <div
          ref={stick.ref}
          className="h-full overflow-y-auto"
          onScroll={stick.onScroll}
          role="log"
          tabIndex={0}
          aria-live="polite"
          aria-label="Activity feed"
        >
          {items.length === 0 ? (
            <p className="p-6 text-center text-xs text-subtle">
              {filtered ? "No activity matches this filter." : "Waiting for engine activity…"}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((v) => {
                const item = items[v.index];
                if (!item) return null;
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    {item.kind === "group" ? (
                      <TaskHeader
                        project={item.projectId ? (names.get(item.projectId) ?? "Other project") : null}
                        title={titles.get(item.taskId) ?? null}
                        taskId={item.taskId}
                        onLogs={() => openLogs(item.taskId)}
                      />
                    ) : (
                      <EventRow
                        event={item.event}
                        grouped={item.grouped}
                        open={expanded.has(item.event.id)}
                        onToggle={() => toggle(item.event.id)}
                        projectName={
                          !item.grouped &&
                          scope === "all" &&
                          item.event.projectId &&
                          item.event.projectId !== projectId
                            ? (names.get(item.event.projectId) ?? "Other project")
                            : null
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!stick.atBottom && items.length > 0 && (
          <button
            type="button"
            onClick={stick.jumpToLatest}
            className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border-strong bg-raised px-3 py-1 text-[11px] text-fg shadow-pop hover:bg-hover"
          >
            <ArrowDown className="size-3" aria-hidden />
            Jump to latest{stick.unseen > 0 ? ` (${stick.unseen} new)` : ""}
          </button>
        )}
      </div>
    </div>
  );
}

function LiveHeartbeatRow() {
  const last = useEngine((s) => s.heartbeats.at(-1));
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-raised/50 px-3 py-1.5 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium text-fg">Engine</span>
        <HeartbeatPulse />
      </span>
      {last && (
        <span className="tabular-nums text-subtle">
          up {formatDuration(last.details.uptimeMs)} · {formatBytes(last.details.rssBytes)}
        </span>
      )}
    </div>
  );
}

function TaskHeader({
  project,
  title,
  taskId,
  onLogs,
}: {
  project: string | null;
  title: string | null;
  taskId: string;
  onLogs: () => void;
}) {
  return (
    <div className="group flex items-center gap-1.5 border-b border-border/60 bg-raised/60 px-3 pt-1.5 pb-1 text-[11px]">
      {project && (
        <span className="shrink-0 rounded bg-hover px-1 py-px text-[10px] text-muted">{project}</span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-fg" title={title ?? taskId}>
        {title ?? `Task ${taskId.slice(-6)}`}
      </span>
      <button
        type="button"
        onClick={onLogs}
        aria-label={`Logs for ${title ?? "this task"}`}
        className="shrink-0 rounded px-1 text-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        Logs
      </button>
    </div>
  );
}

const EventRow = memo(function EventRow({
  event,
  grouped,
  open,
  onToggle,
  projectName,
}: {
  event: DepoEvent;
  grouped: boolean;
  open: boolean;
  onToggle: () => void;
  /** Shown when the event belongs to a project other than the open one (and has no task header). */
  projectName: string | null;
}) {
  const style = EVENT_STYLE[event.type];
  const Icon = style.icon;
  const hasDetails = event.details !== null && Object.keys(event.details).length > 0;
  const problem = event.type === "error" || event.status === "failed";
  return (
    <div
      className={cn(
        "border-b border-border/60 px-3 py-1.5 text-xs hover:bg-hover/60",
        grouped && "pl-5",
        problem && "bg-danger/5",
      )}
      data-event-type={event.type}
    >
      <button
        type="button"
        onClick={hasDetails ? onToggle : undefined}
        aria-expanded={hasDetails ? open : undefined}
        className={cn("flex w-full items-start gap-2 text-left", !hasDetails && "cursor-default")}
      >
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_TEXT[style.tone])} aria-hidden />
        <span className="min-w-0 flex-1">
          {projectName && (
            <span className="mr-1.5 rounded bg-raised px-1 py-px text-[10px] text-muted">{projectName}</span>
          )}
          <AgentBadge agent={event.agent} />
          <span className="text-subtle"> · </span>
          <span className={cn("break-words", problem ? "text-danger" : "text-muted")}>{event.text}</span>
          {event.durationMs !== null && event.durationMs >= 1000 && (
            <span className="text-subtle"> · {formatDuration(event.durationMs)}</span>
          )}
        </span>
        <time
          className="shrink-0 tabular-nums text-subtle"
          dateTime={event.ts}
          title={new Date(event.ts).toLocaleString()}
        >
          {formatClock(event.ts)}
        </time>
        {hasDetails && (
          <ChevronRight
            className={cn("mt-0.5 size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")}
            aria-hidden
          />
        )}
      </button>
      {open && hasDetails && (
        <pre className="mt-1.5 ml-5.5 overflow-x-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      )}
    </div>
  );
});

/** Agents get their family colour and initials; the engine and the user stay plain. */
function AgentBadge({ agent }: { agent: string }) {
  const label = agentLabel(agent);
  if (agent === "engine" || agent === "user" || !agent.includes("@")) {
    return <span className="font-medium text-fg">{label}</span>;
  }
  const name = agent.split("@")[0] ?? agent;
  const tone = agentTone(name);
  return (
    <span className="inline-flex items-baseline gap-1 align-baseline" title={agent}>
      <span
        className={cn("rounded px-1 py-px text-[9px] font-semibold tracking-wide", AGENT_SOFT[tone])}
        aria-hidden
      >
        {agentInitials(name)}
      </span>
      <span className="font-medium text-fg">{label}</span>
    </span>
  );
}

export function agentLabel(agent: string): string {
  if (agent === "engine") return "Engine";
  if (agent === "user") return "You";
  const [name, version] = agent.split("@");
  if (!name || !version) return agent;
  return agentName(name);
}

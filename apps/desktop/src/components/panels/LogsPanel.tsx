import type { LogLevel, LogLine } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  Check,
  ChevronRight,
  Copy,
  FileArchive,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  ScrollText,
  Search,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatBytes } from "@/lib/format";
import {
  EMPTY_VIEW,
  filterParams,
  formatLogLine,
  LEVEL_BADGE,
  LEVEL_DOT,
  LEVEL_LABEL,
  LEVEL_ORDER,
  LEVEL_TONE,
  type LogFilters,
  type LogView,
  lineDetails,
  logClock,
  mergeTail,
  prependOlder,
  taskChip,
  toggleLevel,
} from "@/lib/logs";
import { useFollowList } from "@/lib/use-follow-list";
import { useTaskTitles } from "@/lib/use-task-titles";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const PAGE = 500;
const POLL_MS = 1000;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The engine's own log: search it, follow it live, and export it for a bug report. */
export function LogsPanel() {
  const connected = useEngine((s) => s.status === "open");
  const engineRun = useEngine((s) => s.info?.startedAt ?? null);
  const currentTask = useUi((s) => s.taskId);
  const logsTaskId = useUi((s) => s.logsTaskId);
  const setLogsTaskId = useUi((s) => s.setLogsTaskId);

  const [levels, setLevels] = useState<LogLevel[]>(["error", "warn", "info", "debug"]);
  const [component, setComponent] = useState<string | null>(null);
  const [text, setText] = useState("");
  const query = useDebounced(text, 250);
  const [live, setLive] = useState(true);
  const [view, setView] = useState<LogView>(EMPTY_VIEW);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<{ bytes: number; truncated: boolean } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const filters: LogFilters = useMemo(
    () => ({ levels, component, text: query, taskId: logsTaskId }),
    [levels, component, query, logsTaskId],
  );

  const components = useQuery({
    queryKey: ["logs", "components"],
    queryFn: () => call("logs.components", {}),
    enabled: connected,
    staleTime: 30_000,
  });

  // Each load gets a number; answers to older loads are dropped, and the tail waits for the load.
  const generation = useRef(0);
  const loaded = useRef(-1);
  const viewRef = useRef(view);
  viewRef.current = view;
  // A new result starts at the newest line; set once the scroll hook exists (below).
  const stickReset = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    const g = ++generation.current;
    if (!connected) return;
    if (filters.levels.length === 0) {
      loaded.current = g;
      setView(EMPTY_VIEW);
      setScan(null);
      return;
    }
    setLoading(true);
    try {
      const res = await call("logs.query", { ...filterParams(filters), limit: PAGE });
      if (g !== generation.current) return;
      stickReset.current();
      setView({ lines: res.lines, counts: res.counts, next: res.next, cursor: res.cursor, trimmed: false });
      setScan({ bytes: res.scannedBytes, truncated: res.truncated });
      setExpanded(new Set());
      setError(null);
      loaded.current = g;
    } catch (err) {
      if (g === generation.current) setError(errorText(err));
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }, [connected, filters]);

  // Reload on filter changes and when the engine restarts (its line numbers start again).
  // biome-ignore lint/correctness/useExhaustiveDependencies: engineRun is a reload trigger.
  useEffect(() => {
    void load();
  }, [load, engineRun]);

  useEffect(() => {
    if (!live || !connected || filters.levels.length === 0) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      const g = generation.current;
      if (busy || loaded.current !== g || document.hidden) return;
      busy = true;
      try {
        // Every level, so the chip counts stay right; mergeTail shows only the selected ones.
        const res = await call("logs.tail", {
          cursor: viewRef.current.cursor,
          ...filterParams(filters, false),
          limit: 1000,
        });
        if (stopped || g !== generation.current) return;
        if (res.reset) void load();
        else setView((v) => mergeTail(v, res.lines, res.cursor, filters.levels));
      } catch {
        // A missed poll is fine; the next one catches up from the same cursor.
      } finally {
        busy = false;
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [live, connected, filters, load]);

  const projectIds = useMemo(() => [...new Set(view.lines.map((l) => l.projectId))], [view.lines]);
  const titles = useTaskTitles(projectIds);

  const virtualizer = useVirtualizer({
    count: view.lines.length,
    getScrollElement: () => stick.ref.current,
    estimateSize: () => 26,
    overscan: 16,
    getItemKey: (i) => view.lines[i]?.id ?? i,
  });
  // Follows new lines (live, or after a new search) only while the reader is at the bottom.
  const stick = useFollowList(view.lines.length, view.lines.at(-1)?.id ?? null, () => {
    if (view.lines.length > 0) virtualizer.scrollToIndex(view.lines.length - 1, { align: "end" });
  });
  stickReset.current = stick.reset;

  const loadOlder = async () => {
    const before = view.next;
    if (!before || loadingOlder) return;
    const g = generation.current;
    setLoadingOlder(true);
    try {
      const res = await call("logs.query", { ...filterParams(filters), limit: PAGE, before });
      if (g !== generation.current) return;
      stick.release();
      setView((v) => prependOlder(v, res.lines, res.next, res.counts));
      setScan((s) => ({ bytes: (s?.bytes ?? 0) + res.scannedBytes, truncated: res.truncated }));
      // Keep the line the reader was looking at in place.
      requestAnimationFrame(() => virtualizer.scrollToIndex(res.lines.length, { align: "start" }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const total = view.counts.error + view.counts.warn + view.counts.info + view.counts.debug;
  const empty = !loading && view.lines.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-1.5">
        <fieldset className="flex items-center gap-1" aria-label="Levels">
          {LEVEL_ORDER.map((level) => {
            const on = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on}
                onClick={() => setLevels((l) => toggleLevel(l, level))}
                className={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors",
                  on
                    ? "border-border-strong bg-raised text-fg"
                    : "border-border text-subtle hover:bg-hover hover:text-muted",
                )}
              >
                <span
                  className={cn("size-1.5 rounded-full", on ? LEVEL_DOT[level] : "bg-border-strong")}
                  aria-hidden
                />
                {LEVEL_LABEL[level]}
                <span className="tabular-nums text-subtle">{view.counts[level]}</span>
              </button>
            );
          })}
        </fieldset>

        <select
          aria-label="Component"
          value={component ?? ""}
          onChange={(e) => setComponent(e.target.value || null)}
          className="h-6 rounded-md border border-border bg-bg px-1.5 text-[11px] text-fg"
        >
          <option value="">All components</option>
          {(components.data?.components ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label className="flex h-6 min-w-36 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
          <Search className="size-3.5 text-subtle" aria-hidden />
          <span className="sr-only">Search logs</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search logs"
            className="w-full bg-transparent text-[11px] text-fg outline-none placeholder:text-subtle"
          />
        </label>

        <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Show logs from">
          {(
            [
              ["all", "All tasks"],
              ["task", "This task"],
            ] as const
          ).map(([id, label]) => {
            const checked = id === "all" ? logsTaskId === null : logsTaskId !== null;
            const disabled = id === "task" && !currentTask && logsTaskId === null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: segmented control; role and aria-checked are set.
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={disabled}
                title={disabled ? "Open a task in Chat first" : undefined}
                onClick={() => setLogsTaskId(id === "all" ? null : (currentTask ?? logsTaskId))}
                className={cn(
                  "h-6 rounded-md px-2 text-[11px] disabled:opacity-50",
                  checked ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          aria-pressed={live}
          onClick={() => setLive((v) => !v)}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
            live ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:bg-hover",
          )}
        >
          {live ? <Pause className="size-3" aria-hidden /> : <Play className="size-3" aria-hidden />}
          Live
        </button>

        <div className="ml-auto flex items-center gap-1">
          <RecordLevel />
          <ExportButton />
          <OpenFolderButton />
        </div>
      </div>

      {logsTaskId && (
        <div className="flex items-center gap-2 border-b border-border bg-accent-soft/40 px-3 py-1 text-[11px] text-muted">
          <span>
            Showing lines for <span className="font-medium text-fg">{taskChip(logsTaskId, titles)}</span>
          </span>
          <button
            type="button"
            onClick={() => setLogsTaskId(null)}
            className="rounded px-1 text-accent underline-offset-2 hover:underline"
          >
            Show all
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={stick.ref}
          onScroll={stick.onScroll}
          className="h-full overflow-y-auto font-mono"
          role="log"
          tabIndex={0}
          aria-label="Engine logs"
          aria-busy={loading}
        >
          {error ? (
            <p className="p-6 text-center font-sans text-danger">Could not read the logs: {error}</p>
          ) : !connected ? (
            <p className="p-6 text-center font-sans text-subtle">Waiting for the engine…</p>
          ) : levels.length === 0 ? (
            <p className="p-6 text-center font-sans text-subtle">Pick a level to see lines.</p>
          ) : empty ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center font-sans text-subtle">
              <ScrollText className="size-5" aria-hidden />
              {text || component || logsTaskId || levels.length < 4
                ? "No log lines match this filter."
                : "No log lines yet."}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const line = view.lines[item.index];
                if (!line) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <LogRow
                      line={line}
                      open={expanded.has(line.id)}
                      onToggle={() => toggle(line.id)}
                      task={line.taskId ? taskChip(line.taskId, titles) : null}
                      onTask={line.taskId ? () => setLogsTaskId(line.taskId) : undefined}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!stick.atBottom && view.lines.length > 0 && (
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

      <div className="flex items-center gap-3 border-t border-border px-3 py-1 text-[11px] text-subtle">
        <span className="tabular-nums" aria-live="polite">
          {loading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Reading logs…
            </span>
          ) : (
            `${view.lines.length} of ${total} lines${scan ? ` · read ${formatBytes(scan.bytes)}` : ""}`
          )}
        </span>
        {view.next && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className="rounded px-1 text-accent underline-offset-2 hover:underline disabled:opacity-50"
          >
            {loadingOlder ? "Loading…" : scan?.truncated ? "Search older lines" : "Load older"}
          </button>
        )}
        {view.trimmed && <span>Older lines left the view. Search to find them.</span>}
      </div>
    </div>
  );
}

const LogRow = memo(function LogRow({
  line,
  open,
  onToggle,
  task,
  onTask,
}: {
  line: LogLine;
  open: boolean;
  onToggle: () => void;
  task: string | null;
  onTask: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatLogLine(line));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be blocked; nothing else to do.
    }
  };
  return (
    <div
      className={cn(
        "group border-b border-border/50 hover:bg-hover/60",
        line.level === "error" && "bg-danger/5",
      )}
      data-level={line.level}
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <time
            className="shrink-0 tabular-nums text-subtle"
            dateTime={line.ts}
            title={new Date(line.ts).toLocaleString()}
          >
            {logClock(line.ts)}
          </time>
          <span
            className={cn(
              "w-12 shrink-0 rounded px-1 text-center text-[10px] font-semibold tracking-wide",
              LEVEL_TONE[line.level],
            )}
          >
            {LEVEL_BADGE[line.level]}
          </span>
          <span className="w-20 shrink-0 truncate text-muted">{line.component}</span>
          <span className="min-w-0 flex-1 truncate font-sans text-fg">
            {line.msg}
            {line.err && <span className="text-danger"> · {line.err.message}</span>}
            {line.durationMs !== null && <span className="text-subtle"> · {line.durationMs} ms</span>}
          </span>
        </button>
        {task && onTask && (
          <button
            type="button"
            onClick={onTask}
            title="Show only this task"
            className="max-w-40 shrink-0 truncate rounded bg-raised px-1.5 py-px font-sans text-[10px] text-muted hover:text-fg"
          >
            {task}
          </button>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy line"
          title="Copy line"
          className="shrink-0 rounded p-0.5 text-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? (
            <Check className="size-3.5 text-success" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      {open && (
        <div className="space-y-1.5 px-3 pb-2 pl-8">
          <pre className="overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] leading-relaxed text-muted">
            {JSON.stringify(lineDetails(line), null, 2)}
          </pre>
          {line.err?.stack && (
            <pre className="overflow-x-auto rounded border border-danger/30 bg-danger/5 p-2 text-[11px] leading-relaxed text-danger">
              {line.err.stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

/** Which lines the engine writes at all (the `logs.level` setting). */
function RecordLevel() {
  const connected = useEngine((s) => s.status === "open");
  const setting = useQuery({
    queryKey: ["setting", "logs.level"],
    queryFn: () => call("settings.get", { key: "logs.level" }),
    enabled: connected,
  });
  const value = typeof setting.data?.value === "string" ? setting.data.value : "info";
  return (
    <select
      aria-label="Lines to record"
      title="Lines the engine writes to its log files"
      value={value}
      disabled={!connected}
      onChange={(e) => {
        call("settings.set", { key: "logs.level", value: e.target.value })
          .then(() => setting.refetch())
          .catch(() => {});
      }}
      className="h-6 rounded-md border border-border bg-bg px-1.5 text-[11px] text-fg"
    >
      <option value="debug">Record everything</option>
      <option value="info">Record info and up</option>
      <option value="warn">Record warnings and errors</option>
      <option value="error">Record errors only</option>
    </select>
  );
}

function ExportButton() {
  const connected = useEngine((s) => s.status === "open");
  const [state, setState] = useState<{ busy: boolean; path: string | null; error: string | null }>({
    busy: false,
    path: null,
    error: null,
  });
  const run = async () => {
    setState({ busy: true, path: null, error: null });
    try {
      const res = await call("logs.export", {}, { timeoutMs: 120_000 });
      setState({ busy: false, path: res.path, error: null });
    } catch (err) {
      setState({ busy: false, path: null, error: errorText(err) });
    }
  };
  return (
    <span className="flex items-center gap-1.5">
      {state.path && (
        <span className="max-w-64 truncate text-[11px] text-success" role="status" title={state.path}>
          Saved to {state.path}
        </span>
      )}
      {state.error && (
        <span className="max-w-64 truncate text-[11px] text-danger" role="alert">
          {state.error}
        </span>
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={!connected || state.busy}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        {state.busy ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <FileArchive className="size-3" aria-hidden />
        )}
        Export diagnostics
      </button>
    </span>
  );
}

function OpenFolderButton() {
  const connected = useEngine((s) => s.status === "open");
  return (
    <button
      type="button"
      aria-label="Open logs folder"
      title="Open logs folder"
      disabled={!connected}
      onClick={() => void call("logs.openFolder", {}).catch(() => {})}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
    >
      <FolderOpen className="size-3.5" aria-hidden />
    </button>
  );
}

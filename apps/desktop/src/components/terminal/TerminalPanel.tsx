import type { TerminalLine, TerminalRun, TerminalRunState } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eraser,
  Loader2,
  Play,
  Square,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { draftForTerminalRun } from "@/lib/fix-request";
import { formatRelative } from "@/lib/format";
import {
  historyStep,
  isActive,
  lineClass,
  NO_INPUT_HINT,
  newestRun,
  pushHistory,
  runFailed,
  runStateText,
} from "@/lib/terminal";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
import { useEngine } from "@/store/engine";
import { useBottomTarget, useTerminal } from "@/store/terminal";
import { useUi } from "@/store/ui";
import { FixWithAgent } from "./FixWithAgent";
import { TargetPicker } from "./TargetPicker";

export const STATE_LABEL: Record<TerminalRunState, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
  timed_out: "Timed out",
};

export function RunStateIcon({ state, className }: { state: TerminalRunState; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (state) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-accent")} aria-hidden />;
    case "succeeded":
      return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
    case "failed":
      return <XCircle className={cn(cls, "text-danger")} aria-hidden />;
    case "stopped":
      return <Square className={cn(cls, "text-muted")} aria-hidden />;
    case "timed_out":
      return <Clock className={cn(cls, "text-warning")} aria-hidden />;
  }
}

export function TerminalPanel() {
  const projectId = useUi((s) => s.projectId);
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
        <SquareTerminal className="size-4" aria-hidden /> Open a project to use the Terminal.
      </div>
    );
  }
  return <TerminalView projectId={projectId} />;
}

/** Ticks once a second while `on`, for the running time. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

async function terminalDraft(run: TerminalRun): Promise<string> {
  let lines: TerminalLine[] = useTerminal.getState().outputs[run.id]?.lines ?? [];
  if (lines.length === 0) {
    try {
      lines = (await call("terminal.read", { runId: run.id })).lines;
    } catch {
      lines = [];
    }
  }
  return draftForTerminalRun(run, lines.map((l) => l.text).join("\n"));
}

function TerminalView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const connected = useEngine((s) => s.status === "open");
  const taskId = useBottomTarget(projectId);
  const selectedId = useTerminal((s) => s.selected[projectId] ?? null);
  const outputs = useTerminal((s) => s.outputs);
  const select = useTerminal((s) => s.select);
  const clear = useTerminal((s) => s.clear);

  const listed = useQuery({
    queryKey: ["terminal", "list", projectId],
    queryFn: () => call("terminal.list", { projectId, limit: 30 }),
    enabled: connected,
  });
  const history = useQuery({
    queryKey: ["terminal", "history", projectId],
    queryFn: () => call("terminal.history", { projectId }),
    enabled: connected,
  });

  // Runs the list does not have yet (just started) come first, then the list with live states.
  const runs = useMemo(() => {
    const fromList = listed.data?.runs ?? [];
    const ids = new Set(fromList.map((r) => r.id));
    const fresh = Object.values(outputs)
      .map((o) => o.run)
      .filter((r): r is TerminalRun => !!r && r.projectId === projectId && !ids.has(r.id))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return [...fresh, ...fromList.map((r) => newestRun(r, outputs[r.id]?.run))];
  }, [listed.data, outputs, projectId]);

  const selected = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null;
  const out = selected ? outputs[selected.id] : undefined;
  const [readError, setReadError] = useState<{ runId: string; message: string } | null>(null);

  // Catch up from the engine's buffer: a run picked from the list, lines that never arrived, or a
  // run that was still going when the connection came back.
  const gap = out?.gap ?? false;
  const selectedRunId = selected?.id ?? null;
  useEffect(() => {
    if (!selectedRunId || !connected) return;
    const o = useTerminal.getState().outputs[selectedRunId];
    if (o && !gap && o.run?.state !== "running") return;
    let cancelled = false;
    call("terminal.read", { runId: selectedRunId }).then(
      (r) => !cancelled && useTerminal.getState().merge(r.run, r.lines, r.dropped),
      (err: unknown) =>
        !cancelled &&
        setReadError({ runId: selectedRunId, message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, gap, connected]);

  const visible = useMemo(() => (out ? out.lines.filter((l) => l.seq > out.clearedAt) : []), [out]);
  const stick = useStickToBottom({ resetKey: selectedRunId, count: visible.length });
  const active = isActive(selected);
  const now = useNow(active);

  const [command, setCommand] = useState("");
  const [histIndex, setHistIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const hintId = useId();

  const run = useMutation({
    mutationFn: (cmd: string) =>
      call("terminal.run", { projectId, command: cmd, ...(taskId ? { taskId } : {}) }),
    onSuccess: (r, cmd) => {
      useTerminal.getState().merge(r.run, []);
      select(projectId, r.run.id);
      setCommand("");
      setHistIndex(-1);
      setDraft("");
      qc.setQueryData(["terminal", "history", projectId], (old: { commands: string[] } | undefined) => ({
        commands: pushHistory(old?.commands ?? [], cmd),
      }));
      void qc.invalidateQueries({ queryKey: ["terminal", "list", projectId] });
    },
  });
  const stop = useMutation({
    mutationFn: (runId: string) => call("terminal.kill", { runId }),
  });

  const submit = () => {
    const cmd = command.trim();
    if (cmd && connected && !run.isPending) run.mutate(cmd);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const list = history.data?.commands ?? [];
    if (list.length === 0) return;
    e.preventDefault();
    const typed = histIndex === -1 ? command : draft;
    if (histIndex === -1) setDraft(command);
    const step = historyStep(list, histIndex, e.key === "ArrowUp" ? "up" : "down", typed);
    setHistIndex(step.index);
    setCommand(step.value);
  };

  const error = run.error ?? stop.error;
  const shownReadError =
    readError && readError.runId === selectedRunId && !out?.lines.length ? readError : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <TargetPicker projectId={projectId} />
          {selected && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted" aria-live="polite">
              <RunStateIcon state={selected.state} />
              <span className="truncate">{runStateText(selected, now)}</span>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selected && active && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => stop.mutate(selected.id)}
                disabled={stop.isPending}
              >
                <Square aria-hidden />
                Stop
              </Button>
            )}
            {selected && runFailed(selected) && (
              <FixWithAgent taskId={selected.taskId} draft={() => terminalDraft(selected)} />
            )}
            {selected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clear(selected.id)}
                disabled={visible.length === 0}
              >
                <Eraser aria-hidden />
                Clear
              </Button>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={stick.scrollRef}
            role="log"
            aria-label="Terminal output"
            tabIndex={0}
            className="h-full overflow-y-auto bg-bg px-3 py-2 font-mono text-[12px] leading-[18px]"
          >
            <div ref={stick.contentRef}>
              {selected ? (
                <>
                  <div className="text-subtle">
                    <span className="text-accent">{selected.target}</span> $ {selected.command}
                  </div>
                  {out?.dropped && (
                    <div className="text-subtle italic">Earlier lines are not kept (only the last 2000).</div>
                  )}
                  {visible.map((l) => (
                    <OutputLine key={l.seq} line={l} />
                  ))}
                  {shownReadError && <div className="text-subtle italic">{shownReadError.message}</div>}
                  {!active && (
                    <div
                      className={cn("mt-1", selected.state === "succeeded" ? "text-success" : "text-muted")}
                    >
                      {STATE_LABEL[selected.state]}. {runStateText(selected, now)}.
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col gap-1 font-sans text-xs text-muted">
                  <p>
                    Run a command in your project, or in a task's private copy, like{" "}
                    <code className="font-mono text-fg">npm test</code> or{" "}
                    <code className="font-mono text-fg">pytest -q</code>.
                  </p>
                  <p className="text-subtle">
                    Your command rules apply, and it runs only on this PC with a 10 minute limit.
                  </p>
                </div>
              )}
            </div>
          </div>
          {!stick.pinned && visible.length > 0 && (
            <button
              type="button"
              onClick={stick.jumpToLatest}
              className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border-strong bg-raised px-3 py-1 text-[11px] text-fg shadow-pop hover:bg-hover"
            >
              <ArrowDown className="size-3" aria-hidden />
              Jump to latest
            </button>
          )}
        </div>

        <form
          className="flex shrink-0 flex-col gap-1 border-t border-border px-2 pt-1.5 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {error && (
            <p role="alert" className="px-1 text-xs text-danger">
              {(error as Error).message}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <ChevronRight className="size-3.5 shrink-0 text-accent" aria-hidden />
            <input
              aria-label="Command"
              aria-describedby={hintId}
              value={command}
              onChange={(e) => {
                setCommand(e.target.value);
                setHistIndex(-1);
              }}
              onKeyDown={onKey}
              placeholder={connected ? "Type a command, then press Enter" : "Waiting for the engine…"}
              disabled={!connected}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-[12px] text-fg outline-none placeholder:text-subtle focus:border-accent disabled:opacity-60"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!command.trim() || !connected || run.isPending}
            >
              <Play aria-hidden />
              Run
            </Button>
          </div>
          <p id={hintId} className="truncate px-1 text-[11px] text-subtle">
            {NO_INPUT_HINT} Up and Down go through earlier commands.
          </p>
        </form>
      </div>

      <RunsList runs={runs} selectedId={selected?.id ?? null} onSelect={(id) => select(projectId, id)} />
    </div>
  );
}

const OutputLine = memo(function OutputLine({ line }: { line: TerminalLine }) {
  return <div className={cn("whitespace-pre-wrap break-all", lineClass(line))}>{line.text || "\u00a0"}</div>;
});

function RunsList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: TerminalRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-44 shrink-0 flex-col border-l border-border md:w-60">
      <h2 className="shrink-0 px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle">Recent runs</h2>
      {runs.length === 0 ? (
        <p className="px-2.5 text-[11px] text-subtle">Nothing run yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1" tabIndex={0} aria-label="Recent runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-current={r.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(r.id)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-2.5 py-1 text-left transition-colors",
                  r.id === selectedId ? "bg-hover" : "hover:bg-hover",
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <RunStateIcon state={r.state} />
                  <span className="sr-only">{STATE_LABEL[r.state]}:</span>
                  <span className="truncate font-mono text-[11.5px] text-fg">{r.command}</span>
                </span>
                <span className="w-full truncate pl-5 text-[11px] text-subtle">
                  {r.taskId ? r.target : "Your project"} · {formatRelative(r.startedAt)}
                  {r.exitCode !== null && r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { TestRun } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, FileCode2, FlaskConical, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { draftForTestRun } from "@/lib/fix-request";
import { formatRelative } from "@/lib/format";
import { uniqueKeys } from "@/lib/problems";
import { agentName } from "@/lib/step-summary";
import { shortDuration } from "@/lib/terminal";
import { useEngine } from "@/store/engine";
import { requestFile } from "@/store/nav";
import { useTerminal } from "@/store/terminal";
import { useUi } from "@/store/ui";
import { FixWithAgent } from "./FixWithAgent";

/** Test runs, newest first: the agents' runs and test commands run in the Terminal. */
export function TestResultsPanel() {
  const projectId = useUi((s) => s.projectId);
  const connected = useEngine((s) => s.status === "open");
  const runs = useQuery({
    queryKey: ["tests", "runs", projectId],
    queryFn: () => call("tests.runs", { projectId: projectId ?? "", limit: 50 }),
    enabled: connected && !!projectId,
  });
  const [open, setOpen] = useState<string | null>(null);

  if (!projectId) return <Empty>Open a project to see its test results.</Empty>;
  if (runs.isError) {
    return (
      <p role="alert" className="p-3 text-xs text-danger">
        {(runs.error as Error).message}
      </p>
    );
  }
  if (!runs.data) return <Empty>{connected ? "Loading test runs…" : "Waiting for the engine…"}</Empty>;
  const list = runs.data.runs;
  if (list.length === 0) {
    return (
      <Empty>
        No test runs yet. Tests that agents run, and test commands you run in the Terminal, show up here.
      </Empty>
    );
  }
  return (
    <ul className="h-full overflow-y-auto text-xs" tabIndex={0} aria-label="Test runs">
      {list.map((r) => (
        <TestRunRow
          key={r.id}
          run={r}
          projectId={projectId}
          open={open === r.id}
          onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
        />
      ))}
    </ul>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-xs text-subtle">
      <FlaskConical className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** "12 passed, 2 failed", or the summary when the counts are unknown. */
export function countsText(r: Pick<TestRun, "passed" | "failed" | "summary" | "ok">): string {
  const parts: string[] = [];
  if (r.passed !== null) parts.push(`${r.passed} passed`);
  if (r.failed !== null && (r.failed > 0 || r.passed === null)) parts.push(`${r.failed} failed`);
  if (parts.length > 0) return parts.join(", ");
  return r.summary || (r.ok ? "Passed" : "Failed");
}

function TestRunRow({
  run,
  projectId,
  open,
  onToggle,
}: {
  run: TestRun;
  projectId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const setBottomTab = useUi((s) => s.setBottomTab);
  const detailsId = `test-run-${run.id}`;
  const again = useMutation({
    mutationFn: () =>
      call("terminal.run", {
        projectId,
        command: run.command,
        ...(run.taskId ? { taskId: run.taskId } : {}),
      }),
    onSuccess: (r) => {
      const t = useTerminal.getState();
      t.setTarget(projectId, run.taskId);
      t.merge(r.run, []);
      t.select(projectId, r.run.id);
      void qc.invalidateQueries({ queryKey: ["terminal"] });
      setBottomTab("terminal");
    },
  });
  const who = run.source === "terminal" ? "You" : agentName(run.by) || "An agent";
  const where = run.taskId ? run.target : "Your project";
  return (
    <li className="border-b border-border/60">
      <div className="flex items-start gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left"
        >
          <ChevronRight
            className={cn("mt-0.5 size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")}
            aria-hidden
          />
          {run.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", run.ok ? "text-success" : "text-danger")}>
                {run.ok ? "Passed" : "Failed"}
              </span>
              <span className="text-fg">{countsText(run)}</span>
              <code className="min-w-0 truncate font-mono text-[11.5px] text-muted">{run.command}</code>
            </span>
            <span className="truncate text-[11px] text-subtle">
              {who} in {where} · {formatRelative(run.at)}
              {run.durationMs !== null ? ` · took ${shortDuration(run.durationMs)}` : ""}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {!run.ok && (
            <FixWithAgent
              taskId={run.taskId}
              label={`Fix with an agent: ${run.command}`}
              draft={() => draftForTestRun(run)}
              compact
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => again.mutate()}
            disabled={again.isPending}
            aria-label={`Run again: ${run.command}`}
          >
            <RotateCcw aria-hidden />
            Run again
          </Button>
        </div>
      </div>
      {again.isError && (
        <p role="alert" className="px-9 pb-1.5 text-xs text-danger">
          {(again.error as Error).message}
        </p>
      )}
      {open && (
        <div id={detailsId} className="flex flex-col gap-2 px-9 pb-3">
          <RunDetails run={run} />
        </div>
      )}
    </li>
  );
}

function RunDetails({ run }: { run: TestRun }) {
  const setCenterTab = useUi((s) => s.setCenterTab);
  if (run.ok && run.failures.length === 0) {
    return <p className="text-muted">All tests passed. {run.summary}</p>;
  }
  if (run.failures.length === 0) {
    return (
      <>
        <p className="text-muted">
          Depo could not read the failures one by one{run.format ? "" : " from this output"}. Here is the end
          of the output.
        </p>
        {run.outputTail.trim() && (
          <pre className="rounded-md border border-border bg-bg p-2 font-mono text-[11.5px] whitespace-pre-wrap break-all text-fg">
            {run.outputTail}
          </pre>
        )}
      </>
    );
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Failures">
      {uniqueKeys(run.failures, (f) => `${f.name}|${f.file}|${f.line}`).map(([key, f]) => (
        <li key={key} className="flex flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <XCircle className="size-3 shrink-0 text-danger" aria-hidden />
            <span className="sr-only">Failed:</span>
            <span className="min-w-0 break-all font-medium text-fg">{f.name}</span>
            {f.file && (
              <button
                type="button"
                onClick={() => {
                  requestFile(f.file ?? "", f.line);
                  setCenterTab("files");
                }}
                className="inline-flex items-center gap-1 rounded-sm font-mono text-[11px] text-accent hover:underline"
              >
                <FileCode2 className="size-3" aria-hidden />
                {f.line !== null ? `${f.file}:${f.line}` : f.file}
              </button>
            )}
          </div>
          {f.message && (
            <pre className="rounded-md border border-border bg-bg p-2 font-mono text-[11.5px] whitespace-pre-wrap break-all text-muted">
              {f.message}
            </pre>
          )}
        </li>
      ))}
      {run.failures.length >= 50 && <li className="text-subtle">Only the first 50 failures are shown.</li>}
    </ul>
  );
}

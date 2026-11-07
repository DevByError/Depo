import type { DiagnosticsResult, Problem, ProblemSeverity, RuntimeProblem } from "@depo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  Info,
  Loader2,
  type LucideIcon,
  Play,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FixWithAgent } from "@/components/terminal/FixWithAgent";
import { TargetPicker, useTargetLabel } from "@/components/terminal/TargetPicker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { EVENT_STYLE, TONE_TEXT } from "@/lib/event-style";
import { codeExcerpt, draftForFile, draftForProblem, draftForRuntime } from "@/lib/fix-request";
import { formatClock, formatRelative } from "@/lib/format";
import {
  countProblems,
  countsLabel,
  type FileGroup,
  groupByFile,
  listWords,
  type ProblemFilters,
  position,
  severityShown,
  uniqueKeys,
} from "@/lib/problems";
import { useEngine } from "@/store/engine";
import { requestFile } from "@/store/nav";
import { useBottomTarget } from "@/store/terminal";
import { useUi } from "@/store/ui";

const SEVERITY: Record<ProblemSeverity, { icon: LucideIcon; label: string; tone: string }> = {
  error: { icon: XCircle, label: "Error", tone: "text-danger" },
  warning: { icon: AlertTriangle, label: "Warning", tone: "text-warning" },
  info: { icon: Info, label: "Note", tone: "text-info" },
};

/** The diagnostics queries for the project folder or a task copy. */
export function diagnosticsKey(kind: "latest" | "runtime", projectId: string, taskId: string | null) {
  return ["diagnostics", kind, projectId, taskId ?? ""] as const;
}

/** The newest check of the project folder or a task copy (shared with the tab's count). */
export function useLatestDiagnostics(projectId: string | null, taskId: string | null) {
  const connected = useEngine((s) => s.status === "open");
  return useQuery({
    queryKey: diagnosticsKey("latest", projectId ?? "", taskId),
    queryFn: () => call("diagnostics.latest", { projectId: projectId ?? "", ...(taskId ? { taskId } : {}) }),
    enabled: connected && !!projectId,
  });
}

export function ProblemsPanel() {
  const projectId = useUi((s) => s.projectId);
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-subtle">
        <Bug className="size-4" aria-hidden /> Open a project to check it for problems.
      </div>
    );
  }
  return <ProblemsView projectId={projectId} />;
}

function openFile(file: string | null, line: number | null) {
  if (!file) return;
  requestFile(file, line);
  useUi.getState().setCenterTab("files");
}

function ProblemsView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const connected = useEngine((s) => s.status === "open");
  const taskId = useBottomTarget(projectId);
  const events = useEngine((s) => s.events);
  const [filters, setFilters] = useState<ProblemFilters>({ errors: true, warnings: true, runtime: true });

  const latest = useLatestDiagnostics(projectId, taskId);
  const targetLabel = useTargetLabel(projectId, taskId);
  const runtime = useQuery({
    queryKey: diagnosticsKey("runtime", projectId, taskId),
    queryFn: () => call("diagnostics.runtime", { projectId, ...(taskId ? { taskId } : {}) }),
    enabled: connected,
    // A running app can crash at any time; its log has no event for that.
    refetchInterval: 15_000,
  });
  const check = useMutation({
    mutationFn: () =>
      call("diagnostics.run", { projectId, ...(taskId ? { taskId } : {}) }, { timeoutMs: 30 * 60_000 }),
    onSuccess: (r) => {
      qc.setQueryData(diagnosticsKey("latest", projectId, taskId), { result: r.result });
      void qc.invalidateQueries({ queryKey: diagnosticsKey("runtime", projectId, taskId) });
    },
  });

  const result = latest.data?.result ?? null;
  const runtimeProblems = runtime.data?.problems ?? [];
  const agentProblems = useMemo(
    () =>
      events.filter(
        (e) =>
          (e.type === "error" || e.type === "warning") && (e.projectId === projectId || e.projectId === null),
      ),
    [events, projectId],
  );
  const counts = result?.counts ?? { error: 0, warning: 0, info: 0 };
  const agentErrors = agentProblems.filter((e) => e.type === "error").length;

  const toggle = (k: keyof ProblemFilters) => setFilters((f) => ({ ...f, [k]: !f[k] }));
  const checking = check.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1">
        <TargetPicker projectId={projectId} />
        <Button size="sm" variant="primary" onClick={() => check.mutate()} disabled={!connected || checking}>
          {checking ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
          {checking ? "Checking…" : "Check now"}
        </Button>
        <span className="min-w-0 truncate text-[11px] text-subtle" aria-live="polite">
          {checking
            ? "Running the compilers and linters this project has installed…"
            : result
              ? `Checked ${formatRelative(result.at)}${result.tools.length > 0 ? ` with ${listWords(result.tools)}` : ""}`
              : "Not checked yet"}
        </span>
        <fieldset className="m-0 ml-auto flex items-center gap-1 border-0 p-0">
          <legend className="sr-only">Show</legend>
          <Chip on={filters.errors} onClick={() => toggle("errors")} icon={XCircle} tone="text-danger">
            Errors {counts.error + agentErrors}
          </Chip>
          <Chip
            on={filters.warnings}
            onClick={() => toggle("warnings")}
            icon={AlertTriangle}
            tone="text-warning"
          >
            Warnings {counts.warning + counts.info + agentProblems.length - agentErrors}
          </Chip>
          <Chip on={filters.runtime} onClick={() => toggle("runtime")} icon={Bug} tone="text-danger">
            Runtime {runtimeProblems.length}
          </Chip>
        </fieldset>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto text-xs" tabIndex={0} aria-label="Problems">
        {check.isError && (
          <p role="alert" className="px-3 py-2 text-danger">
            {(check.error as Error).message}
          </p>
        )}
        <ChecksSection projectId={projectId} result={result} filters={filters} loading={latest.isPending} />
        {filters.runtime && (
          <RuntimeSection problems={runtimeProblems} where={{ taskId, target: targetLabel }} />
        )}
        {agentProblems.length > 0 && (filters.errors || filters.warnings) && (
          <Section title="From agents">
            <ul aria-label="From agents">
              {agentProblems
                .filter((e) => (e.type === "error" ? filters.errors : filters.warnings))
                .map((e) => {
                  const s = EVENT_STYLE[e.type];
                  const Icon = s.icon;
                  return (
                    <li key={e.id} className="flex items-start gap-2 border-b border-border/60 px-3 py-1.5">
                      <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_TEXT[s.tone])} aria-hidden />
                      <span className="sr-only">{e.type === "error" ? "Error:" : "Warning:"}</span>
                      <span className="flex-1 text-muted">{e.text}</span>
                      <time className="tabular-nums text-subtle">{formatClock(e.ts)}</time>
                    </li>
                  );
                })}
            </ul>
          </Section>
        )}
      </section>
    </div>
  );
}

function Chip({
  on,
  onClick,
  icon: Icon,
  tone,
  children,
}: {
  on: boolean;
  onClick: () => void;
  icon: LucideIcon;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] tabular-nums transition-colors",
        on
          ? "border-border-strong bg-raised text-fg"
          : "border-border text-subtle hover:bg-hover hover:text-muted",
      )}
    >
      <Icon className={cn("size-3", on ? tone : "text-subtle")} aria-hidden />
      {children}
    </button>
  );
}

function Section({ title, extra, children }: { title: string; extra?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60">
      <h2 className="flex items-baseline gap-2 bg-panel px-3 pt-2 pb-1 text-[11px] font-medium text-subtle">
        {title}
        {extra && <span className="font-normal">{extra}</span>}
      </h2>
      {children}
    </div>
  );
}

function ChecksSection({
  projectId,
  result,
  filters,
  loading,
}: {
  projectId: string;
  result: DiagnosticsResult | null;
  filters: ProblemFilters;
  loading: boolean;
}) {
  const shown = useMemo(
    () => (result ? result.problems.filter((p) => severityShown(p.severity, filters)) : []),
    [result, filters],
  );
  const groups = useMemo(() => groupByFile(shown), [shown]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!result) {
    return (
      <Section title="Code checks">
        <p className="px-3 pb-2 text-muted">
          {loading
            ? "Loading the last check…"
            : "Check now runs the compilers and linters this project already has installed, like tsc, ESLint, Ruff, go vet or cargo check. Nothing is installed or uploaded."}
        </p>
      </Section>
    );
  }
  const where = { taskId: result.taskId, target: result.target };
  const failed = result.runs.filter((r) => r.error);
  return (
    <Section title="Code checks" extra={countsLabel(result.counts)}>
      {result.tools.length === 0 ? (
        <p className="px-3 pb-2 text-muted">Depo found no compilers or linters to run for this project.</p>
      ) : result.problems.length === 0 ? (
        <p className="flex items-center gap-2 px-3 pb-2 text-muted">
          <CheckCircle2 className="size-3.5 text-success" aria-hidden />
          No problems found by {listWords(result.tools)}.
        </p>
      ) : groups.length === 0 ? (
        <p className="px-3 pb-2 text-muted">Nothing matches the filters.</p>
      ) : (
        <ul aria-label="Problems by file">
          {groups.map((g) => {
            const key = g.file ?? "";
            const isOpen = !collapsed.has(key);
            return (
              <FileGroupRow
                key={key}
                group={g}
                open={isOpen}
                onToggle={() =>
                  setCollapsed((s) => {
                    const next = new Set(s);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                draftAll={() => draftForFile(g.file ?? "the project", g.problems, where)}
                draftOne={(p) => problemDraft(projectId, p, where)}
                taskId={result.taskId}
              />
            );
          })}
        </ul>
      )}
      {result.truncated && (
        <p className="px-3 py-1 text-subtle">Only the first 1000 problems are shown. Fix the errors first.</p>
      )}
      {(result.notes.length > 0 || failed.length > 0) && (
        <ul className="flex flex-col gap-0.5 px-3 pt-1 pb-2 text-[11px] text-subtle" aria-label="Not checked">
          {failed.map((r) => (
            <li key={`run-${r.tool}`}>
              {r.tool} did not finish: {r.error}
            </li>
          ))}
          {result.notes.map((n) => (
            <li key={`note-${n.tool}`}>
              Not checked with {n.tool}: {n.reason}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A problem's draft, with the code around it when it is in the project folder. */
async function problemDraft(
  projectId: string,
  p: Problem,
  where: { taskId: string | null; target: string },
): Promise<string> {
  let code: string | null = null;
  // The Files tab (files.read) shows the project folder; a task copy's agent reads its own copy.
  if (!where.taskId && p.file && p.line !== null) {
    try {
      const f = await call("files.read", { projectId, path: p.file });
      if (f.text !== null) code = codeExcerpt(f.text, p.line);
    } catch {
      code = null;
    }
  }
  return draftForProblem(p, where, code);
}

function FileGroupRow({
  group,
  open,
  onToggle,
  draftAll,
  draftOne,
  taskId,
}: {
  group: FileGroup;
  open: boolean;
  onToggle: () => void;
  draftAll: () => string;
  draftOne: (p: Problem) => Promise<string>;
  taskId: string | null;
}) {
  const name = group.file ?? "Not about one file";
  return (
    <li>
      <div className="flex items-center gap-1 px-2 py-0.5 hover:bg-hover/60">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <FileCode2 className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">{name}</span>
          <span className="shrink-0 text-[11px] text-subtle">
            {countsLabel(countProblems(group.problems))}
          </span>
        </button>
        <FixWithAgent
          compact
          taskId={taskId}
          label={`Fix with an agent: all problems in ${name}`}
          draft={draftAll}
        />
      </div>
      {open && (
        <ul aria-label={`Problems in ${name}`}>
          {uniqueKeys(group.problems, (p) => `${p.tool}|${p.line}|${p.column}|${p.code}|${p.message}`).map(
            ([key, p]) => (
              <ProblemRow key={key} problem={p} taskId={taskId} draft={() => draftOne(p)} />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

function ProblemRow({
  problem: p,
  taskId,
  draft,
}: {
  problem: Problem;
  taskId: string | null;
  draft: () => Promise<string>;
}) {
  const s = SEVERITY[p.severity];
  const Icon = s.icon;
  const pos = position(p);
  const content = (
    <>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", s.tone)} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="whitespace-pre-wrap break-words text-fg">{p.message}</span>
        <span className="text-[11px] text-subtle">
          <span className={s.tone}>{s.label}</span>
          {p.code ? ` · ${p.code}` : ""} · {p.tool}
        </span>
      </span>
      {pos && <span className="shrink-0 pt-px font-mono text-[11px] tabular-nums text-subtle">{pos}</span>}
    </>
  );
  return (
    <li className="flex items-start gap-1 py-0.5 pr-2 pl-8 hover:bg-hover/60">
      {p.file ? (
        <button
          type="button"
          onClick={() => openFile(p.file, p.line)}
          title={`Open ${p.file}${pos ? ` at line ${p.line}` : ""}`}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm py-0.5 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 py-0.5">{content}</div>
      )}
      <FixWithAgent
        compact
        taskId={taskId}
        label={`Fix with an agent: ${p.file ?? p.tool}${pos ? `:${pos}` : ""}`}
        draft={draft}
      />
    </li>
  );
}

function RuntimeSection({
  problems,
  where,
}: {
  problems: RuntimeProblem[];
  where: { taskId: string | null; target: string };
}) {
  return (
    <Section title="Runtime" extra={problems.length > 0 ? `${problems.length}` : undefined}>
      {problems.length === 0 ? (
        <p className="px-3 pb-2 text-muted">
          No crashes in running previews, and no console errors in page checks.
        </p>
      ) : (
        <ul aria-label="Runtime problems">
          {uniqueKeys(problems, (p) => `${p.source}|${p.file}|${p.line}|${p.message}`).map(([key, p]) => {
            const pos = position(p);
            return (
              <li key={key} className="flex items-start gap-2 border-b border-border/40 px-3 py-1.5">
                <Bug className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="whitespace-pre-wrap break-words text-fg">{p.message}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-subtle">
                    <span className="text-danger">
                      {p.source === "preview" ? "App crash" : "Console error"}
                    </span>
                    {p.count > 1 && <span>{p.count} times</span>}
                    <span>{formatRelative(p.at)}</span>
                    {p.file && (
                      <button
                        type="button"
                        onClick={() => openFile(p.file, p.line)}
                        className="rounded-sm font-mono text-accent hover:underline"
                      >
                        {p.file}
                        {pos ? `:${pos}` : ""}
                      </button>
                    )}
                  </span>
                  {p.excerpt.trim() && (
                    <details>
                      <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
                        {p.source === "preview" ? "Show the log" : "Show details"}
                      </summary>
                      <pre className="mt-1 rounded-md border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted">
                        {p.excerpt}
                      </pre>
                    </details>
                  )}
                </div>
                <FixWithAgent
                  compact
                  taskId={where.taskId}
                  label={`Fix with an agent: ${p.message.slice(0, 80)}`}
                  draft={() => draftForRuntime(p, where)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

import type { ChatItem } from "@depo/shared";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookMarked,
  Boxes,
  Camera,
  ChevronRight,
  ClipboardList,
  Eye,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FileX,
  FolderTree,
  Gauge,
  GitBranch,
  ListTree,
  Loader2,
  type LucideIcon,
  MessageSquareText,
  Presentation,
  Search,
  Send,
  ShieldCheck,
  StickyNote,
  Terminal,
  TestTube2,
  Type,
  UserRound,
  Workflow,
  Wrench,
  XCircle,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Tokens } from "@/components/code/Tokens";
import { Markdown } from "@/components/panels/Markdown";
import { PageCheckStep } from "@/components/qa/PageCheckView";
import { cn } from "@/lib/cn";
import { type LanguageId, languageForPath } from "@/lib/highlight/languages";
import { splitLines } from "@/lib/highlight/tokens";
import { useDiffHighlight, useHighlight } from "@/lib/highlight/use-highlight";
import {
  describeNote,
  diffLines,
  type EditHunk,
  editHunks,
  formatDuration,
  parseCommandResult,
  plural,
  type StepKind,
  type StepSummary,
  summarizeStep,
} from "@/lib/step-summary";
import { AgentChip } from "./AgentChip";

const KIND_ICON: Record<StepKind, LucideIcon> = {
  read: FileText,
  list: FolderTree,
  find: FileSearch,
  search: Search,
  write: FilePlus2,
  edit: FilePen,
  delete: FileX,
  command: Terminal,
  test: TestTube2,
  git: GitBranch,
  map: ListTree,
  memory: BookMarked,
  board: StickyNote,
  message: Send,
  diagram: Workflow,
  screenshot: Camera,
  deck: Presentation,
  audit: ClipboardList,
  security: ShieldCheck,
  performance: Gauge,
  block: Boxes,
  fonts: Type,
  tool: Wrench,
};

// Open/closed choices live outside React state too, so they survive remounts (switching tabs).
const expandedIds = new Set<string>();

/** An open/closed toggle that only the reader changes: new data never opens or closes it. */
export function useExpanded(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => expandedIds.has(id));
  const toggle = () => {
    const next = !open;
    if (next) expandedIds.add(id);
    else expandedIds.delete(id);
    setOpen(next);
  };
  return [open, toggle];
}

export type WorkState = "working" | "waiting" | "stopped" | "done";

export interface LiveStep {
  text: string;
  /** `backend@1.0.0` in team runs. */
  agent: string | null;
}

/** Counts tool steps (or, with none, every listed line) and failed ones for the work line. */
export function workCounts(steps: ChatItem[]): { steps: number; failed: number } {
  let n = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.role !== "tool") continue;
    n++;
    if (summarizeStep(s).failed) failed++;
  }
  // A team run's lines are mostly handoffs, reviews and notes rather than tool calls: count those.
  if (n === 0) n = steps.length;
  return { steps: n, failed };
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{formatDuration(now - since)}</>;
}

const isTeamAgent = (agent: string | null | undefined): agent is string =>
  !!agent && !agent.startsWith("coder@") && agent !== "engine";

/**
 * One turn's work as a single line ("Worked for 1m 20s · 12 steps · 1 failed"), also while the agent
 * works ("Working · 7 steps · Reading app/main.py"). Clicking it lists every step, one line each.
 */
export function WorkLog({
  id,
  steps,
  state,
  startedAt,
  endedAt,
  live,
}: {
  /** Keeps the reader's open/closed choice for this turn. */
  id: string;
  steps: ChatItem[];
  state: WorkState;
  startedAt: string | null;
  endedAt: string | null;
  live: LiveStep | null;
}) {
  const [open, toggle] = useExpanded(`work:${id}`);
  const listId = useId();
  const counts = useMemo(() => workCounts(steps), [steps]);
  const team = useMemo(() => steps.some((s) => isTeamAgent(s.agent)), [steps]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  const took =
    !Number.isNaN(start) && !Number.isNaN(end) && end >= start ? formatDuration(end - start) : null;
  const active = state === "working" || state === "waiting";

  const headline =
    state === "working"
      ? "Working"
      : state === "waiting"
        ? "Needs you"
        : state === "stopped"
          ? took
            ? `Stopped after ${took}`
            : "Stopped"
          : took
            ? `Worked for ${took}`
            : "Worked";
  const stepsText = plural(counts.steps, "step");
  const liveText = state === "waiting" ? "Waiting for your answer" : live?.text;

  const line = (
    <>
      {state === "working" && <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />}
      {state === "waiting" && <UserRound className="size-3.5 shrink-0 text-warning" aria-hidden />}
      <span className="shrink-0 text-fg">{headline}</span>
      {(counts.steps > 0 || !active) && (
        <>
          <span className="shrink-0" aria-hidden>
            ·
          </span>
          <span className="shrink-0">{stepsText}</span>
        </>
      )}
      {counts.failed > 0 && (
        <>
          <span className="shrink-0" aria-hidden>
            ·
          </span>
          <span className="shrink-0 text-danger">{counts.failed} failed</span>
        </>
      )}
      {steps.length > 0 && (
        <span className="sr-only">
          . {open ? "Hide" : "Show"} the work ({stepsText})
        </span>
      )}
      {active && liveText && (
        <span className="flex min-w-0 items-center gap-1.5" aria-hidden>
          <span className="shrink-0">·</span>
          {live && isTeamAgent(live.agent) && state === "working" && <AgentChip agent={live.agent} />}
          <span className="truncate">{liveText}</span>
        </span>
      )}
      {active && !Number.isNaN(start) && (
        <span className="ml-auto shrink-0 pl-3 text-subtle tabular-nums" aria-hidden>
          <Elapsed since={start} />
        </span>
      )}
    </>
  );

  return (
    <div className="flex flex-col">
      {steps.length > 0 ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="group -mx-1.5 flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted transition-colors hover:bg-hover"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-subtle transition-transform group-hover:text-fg",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {line}
        </button>
      ) : (
        <div className="-mx-1.5 flex min-h-7 min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs text-muted">
          <span className="size-3.5 shrink-0" aria-hidden />
          {line}
        </div>
      )}
      {open && steps.length > 0 && (
        <ol
          id={listId}
          aria-label="Steps"
          className="mt-0.5 mb-1 ml-[7px] flex flex-col gap-px border-l border-border pl-3"
        >
          {steps.map((s) => (
            <li key={s.id}>
              {s.role === "tool" ? (
                <StepRow item={s} showAgent={team} />
              ) : (
                <NoteRow item={s} showAgent={team} />
              )}
            </li>
          ))}
          {active && (
            <li className="flex min-h-6 items-center gap-2 px-1 text-xs text-muted">
              {state === "waiting" ? (
                <UserRound className="size-3.5 shrink-0 text-warning" aria-hidden />
              ) : (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
              )}
              {live && isTeamAgent(live.agent) && state === "working" && <AgentChip agent={live.agent} />}
              <span className="min-w-0 truncate">{liveText ?? "Thinking"}</span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function StepRow({ item, showAgent }: { item: ChatItem; showAgent: boolean }) {
  const s = useMemo(() => summarizeStep(item), [item]);
  const [open, toggle] = useExpanded(`step:${item.id}`);
  const Icon = s.failed ? XCircle : KIND_ICON[s.kind];
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex min-h-6 w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-hover"
      >
        <Icon className={cn("size-3.5 shrink-0", s.failed ? "text-danger" : "text-subtle")} aria-hidden />
        {showAgent && isTeamAgent(item.agent) && <AgentChip agent={item.agent} />}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            s.failed ? "text-danger" : "text-muted group-hover:text-fg",
          )}
        >
          {s.failed && <span className="sr-only">Failed: </span>}
          {s.title}
          {s.meta && <span className={s.failed ? undefined : "text-subtle"}> · {s.meta}</span>}
          {s.failed && s.reason && <span> · {s.reason}</span>}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-subtle">{item.toolName}</span>
        <ChevronRight
          className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && <StepDetails item={item} summary={s} />}
    </div>
  );
}

function NoteRow({ item, showAgent }: { item: ChatItem; showAgent: boolean }) {
  const info = useMemo(() => describeNote(item.text), [item.text]);
  const [open, toggle] = useExpanded(`note:${item.id}`);
  const chip = showAgent && isTeamAgent(item.agent) ? <AgentChip agent={item.agent} /> : null;

  if (info.kind === "handoff") {
    return (
      <div className="flex min-h-6 items-start gap-2 px-1 py-0.5 text-xs text-muted">
        <ArrowRightLeft className="mt-px size-3.5 shrink-0 text-accent" aria-hidden />
        {chip ?? <AgentChip agent={info.agent} />}
        <span className="min-w-0 flex-1">Started: {info.title}</span>
      </div>
    );
  }
  if (info.kind === "review") {
    return (
      <div className="flex min-h-6 items-start gap-2 px-1 py-0.5 text-xs text-muted">
        <Eye
          className={cn("mt-px size-3.5 shrink-0", info.approved ? "text-success" : "text-warning")}
          aria-hidden
        />
        {chip}
        <span className="min-w-0 flex-1">{info.text}</span>
      </div>
    );
  }
  const tone = item.isError ? "text-danger" : "text-muted";
  if (!info.more) {
    return (
      <div className={cn("flex min-h-6 items-start gap-2 px-1 py-0.5 text-xs", tone)}>
        <MessageSquareText className="mt-px size-3.5 shrink-0 text-subtle" aria-hidden />
        {chip}
        <span className="min-w-0 flex-1">{info.line}</span>
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "group flex min-h-6 w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-hover",
          tone,
        )}
      >
        <MessageSquareText className="size-3.5 shrink-0 text-subtle" aria-hidden />
        {chip}
        <span className="min-w-0 flex-1 truncate group-hover:text-fg">{info.line}</span>
        <ChevronRight
          className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && (
        <div className={cn("mt-0.5 mb-1.5 ml-6 text-xs leading-relaxed", tone)}>
          <Markdown text={item.text} />
        </div>
      )}
    </div>
  );
}

/** A scrollable block of output; focusable so keyboard users can scroll it. */
function Output({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <figure
      tabIndex={0}
      aria-label={label}
      className="m-0 max-h-72 overflow-auto focus-visible:-outline-offset-2"
    >
      <pre
        className={cn(
          "px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted",
          className,
        )}
      >
        {children}
      </pre>
    </figure>
  );
}

/** File content written by a step, with syntax colours when the file type is known. */
function CodeOutput({ label, code, lang }: { label: string; code: string; lang: LanguageId | null }) {
  const hl = useHighlight(code, lang);
  const lines = useMemo(() => splitLines(code), [code]);
  return (
    <Output label={label} className="text-fg">
      {hl.lines
        ? lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of fixed content
            <Fragment key={i}>
              {i > 0 && "\n"}
              {line && <Tokens tokens={hl.lines?.[i]} text={line} />}
            </Fragment>
          ))
        : code}
    </Output>
  );
}

const DIFF_MARK = { same: " ", removed: "-", added: "+" } as const;

function Diff({ hunk, label, lang }: { hunk: EditHunk; label: string; lang: LanguageId | null }) {
  const rows = useMemo(() => diffLines(hunk.search, hunk.replace), [hunk]);
  const marked = useMemo(() => rows.map((r) => ({ t: DIFF_MARK[r.type], text: r.text })), [rows]);
  const hl = useDiffHighlight(marked, lang);
  return (
    <figure
      tabIndex={0}
      aria-label={label}
      className="m-0 max-h-72 overflow-auto focus-visible:-outline-offset-2"
    >
      <pre className="py-1.5 font-mono text-[11px] leading-[1.6]">
        {rows.map((r, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff
            key={i}
            className={cn(
              "flex px-2.5",
              r.type === "removed" && "bg-danger/10",
              r.type === "added" && "bg-success/10",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "w-4 shrink-0 select-none",
                r.type === "removed" ? "text-danger" : r.type === "added" ? "text-success" : "text-subtle",
              )}
            >
              {r.type === "removed" ? "-" : r.type === "added" ? "+" : " "}
            </span>
            {r.type !== "same" && (
              <span className="sr-only">{r.type === "removed" ? "Removed: " : "Added: "}</span>
            )}
            <span
              className={cn(
                "min-w-0 flex-1 break-words whitespace-pre-wrap",
                r.type === "same" ? "text-muted" : "text-fg",
              )}
            >
              <Tokens tokens={hl.tokens[i]} text={r.text} />
            </span>
          </span>
        ))}
      </pre>
    </figure>
  );
}

function StepDetails({ item, summary }: { item: ChatItem; summary: StepSummary }) {
  const tool = item.toolName ?? "tool";
  const path = typeof item.args?.path === "string" ? item.args.path : null;
  const hunks = tool === "edit_file" ? editHunks(item.args) : [];
  const content = tool === "write_file" && typeof item.args?.content === "string" ? item.args.content : null;
  const command = tool === "run_command" && typeof item.args?.command === "string" ? item.args.command : null;
  const result = tool === "run_command" && !item.isError ? parseCommandResult(item.text) : null;
  const lang = path ? languageForPath(path) : null;

  return (
    <div className="mt-0.5 mb-1.5 ml-5 overflow-hidden rounded-md border border-border bg-panel">
      {summary.failed && summary.reason && (
        <p className="flex items-start gap-1.5 border-b border-border px-2.5 py-1.5 text-[11.5px] text-danger">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{summary.reason}</span>
        </p>
      )}
      {tool === "run_command" && (command || result) && (
        <div className="flex items-start gap-2 border-b border-border px-2.5 py-1.5 font-mono text-[11px]">
          <span className="text-subtle" aria-hidden>
            $
          </span>
          <span className="min-w-0 flex-1 break-all text-fg">{command ?? "command"}</span>
          {result?.exitCode !== null && result?.exitCode !== undefined && (
            <span className={cn("shrink-0", result.exitCode === 0 ? "text-success" : "text-danger")}>
              exit code {result.exitCode}
            </span>
          )}
          {result?.timedOut && <span className="shrink-0 text-danger">timed out</span>}
          {result?.cancelled && <span className="shrink-0 text-muted">stopped</span>}
        </div>
      )}
      {hunks.length > 0 ? (
        <div className="divide-y divide-border">
          {hunks.map((h, i) => (
            <Diff
              // biome-ignore lint/suspicious/noArrayIndexKey: edits of one call, in order
              key={i}
              hunk={h}
              lang={lang}
              label={`Change ${i + 1} of ${hunks.length}${path ? ` in ${path}` : ""}`}
            />
          ))}
        </div>
      ) : tool === "check_page" && !item.isError ? (
        <PageCheckStep text={item.text} />
      ) : content !== null ? (
        <CodeOutput label={`Content written to ${path ?? "the file"}`} code={content} lang={lang} />
      ) : (
        <Output label={`Output of ${tool}`}>
          {(result ? result.output.trim() : item.text.trim()) || "No output."}
        </Output>
      )}
    </div>
  );
}

import type { ApiResult, DepoEvent, Task, TaskStatus } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BookMarked,
  ExternalLink,
  FileDiff,
  ListChecks,
  ListTree,
  MonitorPlay,
  Signpost,
} from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "@/components/team/AgentAvatar";
import { ErrorText } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { TONE_TEXT } from "@/lib/event-style";
import { formatRelative } from "@/lib/format";
import { openExternal } from "@/lib/open-url";
import { queryClient } from "@/lib/query";
import { agentName } from "@/lib/step-summary";
import { decisionFromEvent, decisionLabel, decisionTone } from "@/lib/team-view";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { Card, CardLink } from "./parts";

type Overview = ApiResult<"projects.overview">;

export const TASK_LABELS: [TaskStatus, string][] = [
  ["running", "Working"],
  ["queued", "Starting"],
  ["waiting", "Needs you"],
  ["review", "To review"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["cancelled", "Stopped"],
];
const LABEL = new Map(TASK_LABELS);
const STATUS_DOT: Record<TaskStatus, string> = {
  running: "bg-accent",
  queued: "bg-info",
  waiting: "bg-warning",
  review: "bg-info",
  done: "bg-success",
  failed: "bg-danger",
  cancelled: "bg-border-strong",
};
const ACTIVE: TaskStatus[] = ["running", "queued", "waiting", "review"];

/** Active tasks first (working, starting, needing you, to review), then the latest, at most `max`. */
export function homeTasks(tasks: Task[], max = 5): Task[] {
  const rank = (t: Task) => (ACTIVE.includes(t.status) ? 0 : 1);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, max);
}

export function TasksCard({ overview }: { overview: Overview }) {
  const projectId = overview.project.id;
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setTaskId = useUi((s) => s.setTaskId);
  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId }),
    enabled,
  });
  const list = homeTasks(tasks.data?.tasks ?? []);
  const counts = overview.taskCounts;
  return (
    <Card
      title="Tasks"
      icon={ListChecks}
      action={<CardLink onClick={() => setCenterTab("chat")}>Open Chat</CardLink>}
    >
      {Object.keys(counts).length === 0 ? (
        <p className="text-xs text-subtle">No tasks yet. Start one with New task.</p>
      ) : (
        <dl className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {TASK_LABELS.filter(([k]) => counts[k]).map(([k, label]) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[k])} aria-hidden />
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium text-fg tabular-nums">{counts[k]}</dd>
            </div>
          ))}
        </dl>
      )}
      {list.length > 0 && (
        <ul className="-mx-2 flex flex-col">
          {list.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  setTaskId(t.id);
                  setCenterTab(t.mode === "single" ? "chat" : "team");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-hover"
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[t.status])} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                <span className="shrink-0 text-[11px] text-muted">{LABEL.get(t.status)}</span>
                <span className="w-16 shrink-0 text-right text-[11px] text-subtle">
                  {formatRelative(t.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PreviewsCard({ projectId }: { projectId: string }) {
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const [error, setError] = useState<unknown>(null);
  const list = useQuery({
    queryKey: ["previews", "list", projectId],
    queryFn: () => call("preview.list", { projectId }),
    enabled,
    refetchInterval: (q) => (q.state.data?.previews.some((p) => p.state === "starting") ? 1500 : false),
  });
  const live = (list.data?.previews ?? []).filter((p) => p.state === "running" || p.state === "starting");
  return (
    <Card
      title="Previews"
      icon={MonitorPlay}
      action={<CardLink onClick={() => setCenterTab("preview")}>Open Preview</CardLink>}
    >
      {live.length === 0 ? (
        <p className="text-xs text-subtle">Nothing running. Start the app from the Preview tab.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {live.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  p.state === "running" ? "bg-success" : "bg-warning motion-safe:animate-pulse",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-fg">
                {p.label}
                <span className="text-subtle">
                  {" · "}
                  {p.taskId ? "task copy" : "project"} · {p.state === "running" ? "running" : p.phase}
                </span>
              </span>
              {p.state === "running" && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    openExternal(p.url).catch((err: unknown) => setError(err));
                  }}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-accent hover:bg-hover"
                  aria-label={`Open ${p.label} at ${p.url}`}
                >
                  {p.url.replace(/^https?:\/\//, "")}
                  <ExternalLink className="size-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

/** The latest team decisions (plans, reviews, handoffs), newest first, with the event they came from. */
export function latestDecisions(events: DepoEvent[], max = 5) {
  return events
    .map((e) => ({ e, d: decisionFromEvent(e) }))
    .filter((x): x is { e: DepoEvent; d: NonNullable<ReturnType<typeof decisionFromEvent>> } => x.d !== null)
    .sort((a, b) => b.e.ts.localeCompare(a.e.ts) || b.e.seq - a.e.seq)
    .slice(0, max);
}

export function DecisionsCard({ projectId }: { projectId: string }) {
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setTaskId = useUi((s) => s.setTaskId);
  const q = useQuery({
    queryKey: ["team", projectId, "decisions"],
    queryFn: () => call("events.recent", { projectId, types: ["decision"], limit: 30 }),
    enabled,
  });
  const items = latestDecisions(q.data?.events ?? []);
  return (
    <Card title="Latest decisions" icon={Signpost}>
      {items.length === 0 ? (
        <p className="text-xs text-subtle">
          No decisions yet. Team runs record their plans, reviews and handoffs here.
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {items.map(({ e, d }) => (
            <li key={d.id}>
              <button
                type="button"
                disabled={!e.taskId}
                onClick={() => {
                  if (!e.taskId) return;
                  setTaskId(e.taskId);
                  setCenterTab("team");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs enabled:hover:bg-hover"
              >
                <AgentAvatar id={d.agent} name={agentName(d.tag)} size="xs" />
                <span className={cn("shrink-0 text-[11px] font-medium", TONE_TEXT[decisionTone(d)])}>
                  {decisionLabel(d)}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg" title={d.text}>
                  {d.text}
                </span>
                <span className="shrink-0 text-[11px] text-subtle">{formatRelative(d.ts)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const KIND_LABEL = {
  fact: "Fact",
  preference: "Preference",
  decision: "Decision",
  lesson: "Lesson",
} as const;

export function MemoryCard({ overview }: { overview: Overview }) {
  const projectId = overview.project.id;
  const enabled = useEngine((s) => s.status === "open");
  const setCenterTab = useUi((s) => s.setCenterTab);
  const memory = useQuery({
    queryKey: ["memory", projectId],
    queryFn: () => call("memory.get", { projectId }),
    enabled,
  });
  const top = [...(memory.data?.facts ?? [])]
    .sort((a, b) => b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const m = overview.memory;
  return (
    <Card
      title="Memory"
      icon={BookMarked}
      action={<CardLink onClick={() => setCenterTab("memory")}>Open Memory</CardLink>}
    >
      <p className="text-xs text-fg">
        {m.facts} item{m.facts === 1 ? "" : "s"} · {m.lessons} lesson{m.lessons === 1 ? "" : "s"} learned
      </p>
      {top.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {top.map((f) => (
            <li key={f.id} className="flex gap-2 text-xs">
              <span className="w-16 shrink-0 text-[11px] text-subtle">{KIND_LABEL[f.kind]}</span>
              <span className="line-clamp-2 min-w-0 flex-1 text-muted">{f.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-subtle">Agents read the project memory before every task.</p>
      )}
    </Card>
  );
}

export function RecentChangesCard({ overview }: { overview: Overview }) {
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  return (
    <Card title="Recent changes" icon={FileDiff}>
      {overview.recentChanges.length === 0 ? (
        <p className="text-xs text-subtle">No changes yet.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {overview.recentChanges.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setChangeSetId(c.id);
                  setCenterTab("diff");
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate text-fg">{c.title}</span>
                <span className="shrink-0 text-subtle">
                  {c.files} file{c.files === 1 ? "" : "s"}
                </span>
                <span className="w-24 shrink-0 text-right text-subtle">{c.status.replace("_", " ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function useRebuildIndex(projectId: string) {
  return useMutation({
    mutationFn: () => call("index.rebuild", { projectId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["codemap", projectId] });
    },
  });
}

export function CodeIndexCard({
  overview,
  rebuild,
}: {
  overview: Overview;
  rebuild: ReturnType<typeof useRebuildIndex>;
}) {
  const idx = overview.index;
  // Rebuilding is a quick action at the top of the home; this card says how the index stands.
  return (
    <Card title="Code index" icon={ListTree}>
      <p className="text-xs text-fg" data-testid="index-status">
        {idx.state === "disabled"
          ? "Turned off for this project."
          : idx.state === "indexing"
            ? `Indexing${idx.progress ? ` ${idx.progress.done}/${idx.progress.total}` : ""}…`
            : `${idx.files} files · ${idx.symbols} symbols${idx.chunks ? ` · ${idx.chunks} chunks` : ""}`}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-subtle">
        {idx.embeddingModel
          ? `Semantic search with ${idx.embeddingModel}.`
          : "Symbols only. Download an embedding model in Models for search by meaning."}
        {idx.watching ? " Watching for changes." : ""}
        {idx.lastIndexedAt ? ` Updated ${formatRelative(idx.lastIndexedAt)}.` : ""}
      </p>
      {idx.error && <p className="mt-1 text-[11px] text-warning">{idx.error}</p>}
      <ErrorText error={rebuild.error} />
    </Card>
  );
}

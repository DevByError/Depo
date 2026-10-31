import type { ProjectSettings } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookMarked,
  CheckCircle2,
  FileDiff,
  FolderKanban,
  ListTree,
  Loader2,
  Pencil,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, inputClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatRelative } from "@/lib/format";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const TASK_LABELS: [string, string][] = [
  ["running", "Working"],
  ["queued", "Starting"],
  ["waiting", "Needs you"],
  ["review", "To review"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["cancelled", "Stopped"],
];

/** The project dashboard: what the project is, how its work is going, its index and its settings. */
export function OverviewPanel() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const setDialog = useUi((s) => s.setProjectDialog);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setChangeSetId = useUi((s) => s.setChangeSetId);
  const overview = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => call("projects.overview", { id: projectId ?? "" }),
    enabled: enabled && !!projectId,
    refetchInterval: (q) => (q.state.data?.index.state === "indexing" ? 1500 : false),
  });
  const rebuild = useMutation({
    mutationFn: () => call("index.rebuild", { projectId: projectId ?? "" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overview", projectId] }),
  });

  if (!projectId) {
    return (
      <Empty>
        <FolderKanban className="size-6 text-muted" aria-hidden />
        <p>Create, import or open a project from the sidebar to see its dashboard here.</p>
      </Empty>
    );
  }
  if (overview.isError) {
    return (
      <Empty>
        <ErrorText error={overview.error} />
      </Empty>
    );
  }
  const o = overview.data;
  if (!o) {
    return (
      <Empty>
        <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
      </Empty>
    );
  }
  const p = o.project;
  const idx = o.index;
  return (
    <section aria-label="Project overview" className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-fg">{p.name}</h1>
            <p className="mt-0.5 truncate font-mono text-[11px] text-subtle" title={p.rootPath}>
              {p.rootPath}
            </p>
            {p.description && <p className="mt-2 text-[13px] leading-relaxed text-muted">{p.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              {p.stack && <Chip>{p.stack}</Chip>}
              {p.branch && <Chip>branch {p.branch}</Chip>}
              <Chip>
                {p.origin === "created" ? "Created in Depo" : p.origin === "duplicated" ? "Copy" : "Imported"}
              </Chip>
              {p.archivedAt && <Chip>Archived</Chip>}
            </div>
          </div>
          <Button size="sm" onClick={() => setDialog({ kind: "rename", projectId: p.id })}>
            <Pencil aria-hidden /> Edit details
          </Button>
        </header>

        {!p.exists && (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            The project folder is missing. Move it back, or remove the project from Depo.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card title="Tasks">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {TASK_LABELS.filter(([k]) => o.taskCounts[k]).map(([k, label]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-muted">{label}</dt>
                  <dd className="font-medium text-fg tabular-nums">{o.taskCounts[k]}</dd>
                </div>
              ))}
            </dl>
            {Object.keys(o.taskCounts).length === 0 && <p className="text-xs text-subtle">No tasks yet.</p>}
            <Button size="sm" className="mt-3" onClick={() => setCenterTab("chat")}>
              Open Chat
            </Button>
          </Card>

          <Card title="Last test run">
            {o.lastTestRun ? (
              <div className="flex items-start gap-2 text-xs">
                {o.lastTestRun.passed ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Passed" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-danger" aria-label="Failed" />
                )}
                <div className="min-w-0">
                  <p className="text-fg">{o.lastTestRun.text}</p>
                  <p className="mt-0.5 text-subtle">{formatRelative(o.lastTestRun.at)}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-subtle">
                Agents run the tests in their copy; the latest result shows here.
              </p>
            )}
          </Card>

          <Card
            title="Code index"
            icon={ListTree}
            action={
              <Button
                size="sm"
                variant="ghost"
                disabled={idx.state === "disabled" || idx.state === "indexing" || rebuild.isPending}
                onClick={() => rebuild.mutate()}
              >
                <RefreshCw className={cn(idx.state === "indexing" && "animate-spin")} aria-hidden />
                Rebuild
              </Button>
            }
          >
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

          <Card title="Memory" icon={BookMarked}>
            <p className="text-xs text-fg">
              {o.memory.facts} fact{o.memory.facts === 1 ? "" : "s"} · {o.memory.lessons} lesson
              {o.memory.lessons === 1 ? "" : "s"} learned
            </p>
            <p className="mt-1 text-[11px] text-subtle">Agents read the project memory before every task.</p>
            <Button size="sm" className="mt-3" onClick={() => setCenterTab("memory")}>
              Open Memory
            </Button>
          </Card>
        </div>

        <Card title="Recent changes" icon={FileDiff}>
          {o.recentChanges.length === 0 ? (
            <p className="text-xs text-subtle">No changes yet.</p>
          ) : (
            <ul className="flex flex-col">
              {o.recentChanges.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setChangeSetId(c.id);
                      setCenterTab("diff");
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1 truncate text-fg">{c.title}</span>
                    <span className="text-subtle">
                      {c.files} file{c.files === 1 ? "" : "s"}
                    </span>
                    <span className="w-28 text-right text-subtle">{c.status.replace("_", " ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ProjectSettingsForm projectId={p.id} />
      </div>
    </section>
  );
}

function ProjectSettingsForm({ projectId }: { projectId: string }) {
  const settings = useQuery({
    queryKey: ["projectSettings", projectId],
    queryFn: () => call("projects.settings.get", { id: projectId }),
  });
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  useEffect(() => {
    if (settings.data) {
      setDraft(settings.data);
      setAllow(settings.data.commandAllow.join("\n"));
      setDeny(settings.data.commandDeny.join("\n"));
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<ProjectSettings>) => call("projects.settings.set", { id: projectId, patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(["projectSettings", projectId], next);
      void queryClient.invalidateQueries({ queryKey: ["overview", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["scheduler"] });
    },
  });
  if (!draft) return null;
  const lines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return (
    <Card title="Project settings">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...draft, commandAllow: lines(allow), commandDeny: lines(deny) });
        }}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Toggle
            label="Keep a code index"
            hint="Symbols and search for agents. Updates as files change."
            checked={draft.indexEnabled}
            onChange={(v) => setDraft({ ...draft, indexEnabled: v })}
          />
          <Toggle
            label="Pause this project"
            hint="Its tasks keep their place but start no new model work."
            checked={draft.paused}
            onChange={(v) => setDraft({ ...draft, paused: v })}
          />
          <Field
            label="Tasks at once"
            hint="How many of this project's tasks may use the model at the same time."
          >
            <input
              type="number"
              min={1}
              max={8}
              value={draft.maxParallel}
              onChange={(e) => setDraft({ ...draft, maxParallel: Number(e.target.value) || 1 })}
              className={inputClass}
            />
          </Field>
          <Field label="Most steps per task" hint="A task stops and hands over after this many model steps.">
            <input
              type="number"
              min={5}
              max={200}
              value={draft.maxSteps}
              onChange={(e) => setDraft({ ...draft, maxSteps: Number(e.target.value) || 40 })}
              className={inputClass}
            />
          </Field>
          <Field
            label="Commands to run without asking"
            hint="One per line, matched at the start, e.g. npm run lint. Never overrides Depo's blocked list."
          >
            <textarea
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              rows={3}
              className={`${inputClass} field-in-frame h-auto py-1.5 font-mono text-[11px]`}
            />
          </Field>
          <Field label="Commands to block" hint="One per line. Agents are refused these in this project.">
            <textarea
              value={deny}
              onChange={(e) => setDeny(e.target.value)}
              rows={3}
              className={`${inputClass} field-in-frame h-auto py-1.5 font-mono text-[11px]`}
            />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className="flex items-center justify-end gap-2">
          {save.isSuccess && !save.isPending && (
            <span role="status" className="text-xs text-success">
              Saved
            </span>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium text-fg">{label}</span>
        <span className="mt-0.5 block text-[11px] text-subtle">{hint}</span>
      </span>
    </label>
  );
}

function Card({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon?: typeof ListTree;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        {Icon && <Icon className="size-4 text-muted" aria-hidden />}
        <h2 className="flex-1 text-[13px] font-semibold text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-border px-2 py-0.5 text-muted">{children}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted">
      {children}
    </div>
  );
}

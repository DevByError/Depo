import type { ApiResult } from "@depo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  FolderKanban,
  Loader2,
  MonitorPlay,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CodeMapView } from "@/components/codemap/CodeMapView";
import { HealthCards } from "@/components/overview/HealthCards";
import {
  CodeIndexCard,
  DecisionsCard,
  MemoryCard,
  PreviewsCard,
  RecentChangesCard,
  TasksCard,
  useRebuildIndex,
} from "@/components/overview/HomeCards";
import { ProjectHeader } from "@/components/overview/ProjectHeader";
import { ProjectSettingsSection } from "@/components/overview/ProjectSettingsForm";
import { Card, Empty } from "@/components/overview/parts";
import { TestDatabaseCard } from "@/components/overview/TestDatabaseCard";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/code-map";
import { call } from "@/lib/engine";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/**
 * The project home: what the project is, how healthy it is, the work going on, what the team
 * decided and remembers, and a map of the code. "Open code map" swaps in the full-size map.
 */
export function OverviewPanel() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const [view, setView] = useState<"home" | "map">("home");
  // biome-ignore lint/correctness/useExhaustiveDependencies: another project opens on its home.
  useEffect(() => setView("home"), [projectId]);
  const overview = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => call("projects.overview", { id: projectId ?? "" }),
    enabled: enabled && !!projectId,
    refetchInterval: (q) => (q.state.data?.index.state === "indexing" ? 1500 : false),
  });

  if (!projectId) {
    return (
      <Empty>
        <FolderKanban className="size-6 text-muted" aria-hidden />
        <p>Create, import or open a project from the sidebar to see its home here.</p>
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
  if (view === "map") {
    return (
      <section aria-label="Code map" tabIndex={0} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
          <header className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost" onClick={() => setView("home")}>
              <ArrowLeft aria-hidden /> Back to project
            </Button>
            <h1 className="text-lg font-semibold text-fg">Code map</h1>
            <span className="min-w-0 truncate text-[13px] text-muted">{o.project.name}</span>
          </header>
          <p className="-mt-2 text-[13px] leading-relaxed text-muted">
            How the folders and files depend on each other, read from the code. Pick a module to see its
            files, and a file to see what it imports and what imports it. It updates as files change.
          </p>
          <CodeMapView projectId={o.project.id} compact={false} disabled={o.index.state === "disabled"} />
        </div>
      </section>
    );
  }
  return <Home overview={o} onOpenMap={() => setView("map")} />;
}

function Home({ overview: o, onOpenMap }: { overview: ApiResult<"projects.overview">; onOpenMap(): void }) {
  const p = o.project;
  const enabled = useEngine((s) => s.status === "open");
  const setDialog = useUi((s) => s.setProjectDialog);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const setTaskId = useUi((s) => s.setTaskId);
  const repo = useQuery({
    queryKey: ["codemap", p.id, "repo"],
    queryFn: () => call("codemap.repo", { projectId: p.id }),
    enabled: enabled && p.exists,
    staleTime: 30_000,
  });
  const rebuild = useRebuildIndex(p.id);
  const scan = useMutation({
    mutationFn: () => call("security.scan", { projectId: p.id }, { timeoutMs: 300_000 }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["security", "last"] });
      void queryClient.invalidateQueries({ queryKey: ["scores", p.id] });
    },
  });
  const idx = o.index;

  return (
    <section aria-label="Project overview" tabIndex={0} className="h-full overflow-y-auto">
      <div className="@container mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <ProjectHeader
          overview={o}
          repo={repo.data}
          onEdit={() => setDialog({ kind: "rename", projectId: p.id })}
        />

        <fieldset
          aria-label="Quick actions"
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
        >
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setTaskId(null);
              setCenterTab("chat");
            }}
          >
            <Plus aria-hidden /> New task
          </Button>
          <Button size="sm" onClick={() => setCenterTab("preview")}>
            <MonitorPlay aria-hidden /> Preview
          </Button>
          <Button size="sm" disabled={scan.isPending || !p.exists} onClick={() => scan.mutate()}>
            {scan.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
            {scan.isPending ? "Scanning…" : "Scan"}
          </Button>
          <Button
            size="sm"
            disabled={idx.state === "disabled" || idx.state === "indexing" || rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            <RefreshCw className={cn(idx.state === "indexing" && "animate-spin")} aria-hidden /> Rebuild index
          </Button>
          <span role="status" className="text-[11px] text-muted">
            {scan.data
              ? `Scan finished: ${scan.data.findings.length ? plural(scan.data.findings.length, "finding") : "nothing found"}.`
              : ""}
          </span>
        </fieldset>
        <ErrorText error={scan.error} />

        {!p.exists && (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            The project folder is missing. Move it back, or remove the project from Depo.
          </p>
        )}

        <HealthCards overview={o} />

        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          <TasksCard overview={o} />
          <PreviewsCard projectId={p.id} />
          <TestDatabaseCard projectId={p.id} />
          <DecisionsCard projectId={p.id} />
          <MemoryCard overview={o} />
        </div>

        <Card
          title="Code map"
          icon={Network}
          action={
            <Button size="sm" variant="ghost" onClick={onOpenMap}>
              Open code map
            </Button>
          }
        >
          <CodeMapView projectId={p.id} compact disabled={idx.state === "disabled"} />
        </Card>

        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          <RecentChangesCard overview={o} />
          <CodeIndexCard overview={o} rebuild={rebuild} />
        </div>

        <ProjectSettingsSection projectId={p.id} />
      </div>
    </section>
  );
}

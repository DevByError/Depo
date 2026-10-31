import type { Project } from "@depo/shared";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/connection";
import { call } from "@/lib/engine";
import { afterProjectAdded, openProject, pickFolder, selectProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

export function ProjectsSection() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const setDialog = useUi((s) => s.setProjectDialog);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => call("projects.list", { includeArchived: true }),
    enabled,
  });
  const active = useQuery({
    queryKey: ["tasks", "active"],
    queryFn: () => call("tasks.active", {}),
    enabled,
  });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => call("scheduler.status", {}),
    enabled,
  });
  const [typing, setTyping] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [path, setPath] = useState("");
  const open = useMutation({
    mutationFn: (p: string) => openProject(p),
    onSuccess: () => {
      setTyping(false);
      setPath("");
    },
  });

  const onOpen = async () => {
    if (!isTauri()) {
      setTyping((t) => !t);
      return;
    }
    const picked = await pickFolder();
    if (picked) open.mutate(picked);
  };

  const all = projects.data?.projects ?? [];
  const list = all.filter((p) => !p.archivedAt);
  const archived = all.filter((p) => p.archivedAt);
  const busy = new Map<string, number>();
  for (const t of active.data?.tasks ?? []) busy.set(t.projectId, (busy.get(t.projectId) ?? 0) + 1);
  const paused = new Set(scheduler.data?.pausedProjects ?? []);

  return (
    <div>
      <div className="mt-3 mb-1.5 flex items-center gap-0.5 px-2">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">Projects</h2>
        <HeaderButton label="New project" disabled={!enabled} onClick={() => setDialog({ kind: "new" })}>
          <Plus className="size-3.5" />
        </HeaderButton>
        <HeaderButton
          label="Import a folder or git repository"
          disabled={!enabled}
          onClick={() => setDialog({ kind: "import" })}
        >
          <FolderInput className="size-3.5" />
        </HeaderButton>
        <HeaderButton label="Open a project folder" disabled={!enabled} onClick={() => void onOpen()}>
          <FolderPlus className="size-3.5" />
        </HeaderButton>
      </div>
      {typing && (
        <form
          className="mx-1 mb-2 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) open.mutate(path.trim());
          }}
        >
          <input
            aria-label="Project folder path"
            placeholder={"C:\\path\\to\\project"}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="h-7 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px] text-fg outline-none placeholder:text-subtle focus:border-accent"
          />
          <button
            type="submit"
            className="h-7 rounded-md bg-accent text-xs font-medium text-accent-fg hover:opacity-90"
          >
            Open
          </button>
        </form>
      )}
      {open.isError && (
        <p role="alert" className="mx-2 mb-2 text-[11px] text-danger">
          {open.error instanceof Error ? open.error.message : String(open.error)}
        </p>
      )}
      {open.isPending && (
        <p className="mx-2 mb-2 flex items-center gap-1.5 text-[11px] text-muted">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Opening…
        </p>
      )}
      {list.length === 0 && !typing ? (
        <div className="mx-1 flex flex-col gap-2 rounded-lg border border-dashed border-border p-3 text-xs leading-relaxed text-subtle">
          <FolderPlus className="size-4 text-muted" aria-hidden />
          Start a new project or import one. Depo works on a copy and only changes your files when you
          approve.
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={!enabled}
              onClick={() => setDialog({ kind: "new" })}
              className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg hover:opacity-90"
            >
              New project
            </button>
            <button
              type="button"
              disabled={!enabled}
              onClick={() => setDialog({ kind: "import" })}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
            >
              Import
            </button>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Projects">
          {list.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              active={p.id === projectId}
              running={busy.get(p.id) ?? 0}
              paused={paused.has(p.id)}
              onNotice={setNotice}
            />
          ))}
        </ul>
      )}
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={cn("mx-2 mt-1.5 break-all text-[11px]", notice.error ? "text-danger" : "text-muted")}
        >
          {notice.text}
        </p>
      )}
      {archived.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] text-subtle hover:text-muted"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", showArchived && "rotate-90")}
              aria-hidden
            />
            Archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="flex flex-col gap-0.5" aria-label="Archived projects">
              {archived.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={p.id === projectId}
                  running={0}
                  paused={false}
                  onNotice={setNotice}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function ProjectRow({
  project: p,
  active,
  running,
  paused,
  onNotice,
}: {
  project: Project;
  active: boolean;
  running: number;
  paused: boolean;
  onNotice: (n: { text: string; error?: boolean } | null) => void;
}) {
  const Icon = active ? FolderOpen : Folder;
  const setDialog = useUi((s) => s.setProjectDialog);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });
  const run = async (what: string, fn: () => Promise<unknown>) => {
    onNotice({ text: `${what}…` });
    try {
      await fn();
    } catch (err) {
      onNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };
  const archived = !!p.archivedAt;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => selectProject(p.id)}
        aria-current={active ? "true" : undefined}
        title={p.exists ? p.rootPath : `Folder missing: ${p.rootPath}`}
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-left text-xs",
          active ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
          archived && "opacity-70",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", !p.exists && "text-danger")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {paused && <Pause className="size-3 shrink-0 text-warning" aria-label="Paused" />}
        {running > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-accent"
            title={`${running} running`}
          >
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {running}
          </span>
        )}
        {p.branch && running === 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-subtle group-hover:hidden">
            <GitBranch className="size-3" aria-hidden />
            {p.branch}
          </span>
        )}
      </button>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Actions for ${p.name}`}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-subtle opacity-0 hover:bg-hover hover:text-fg focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-44 rounded-lg border border-border bg-panel p-1 text-xs shadow-xl"
          >
            <Item icon={Pencil} onSelect={() => setDialog({ kind: "rename", projectId: p.id })}>
              Edit details
            </Item>
            <Item
              icon={Copy}
              onSelect={() =>
                void run(`Duplicating ${p.name}`, async () => {
                  const copy = await call("projects.duplicate", { id: p.id }, { timeoutMs: 10 * 60_000 });
                  await afterProjectAdded(copy);
                  onNotice({ text: `Made a copy at ${copy.rootPath}` });
                })
              }
            >
              Duplicate
            </Item>
            <Item
              icon={Download}
              onSelect={() =>
                void run(`Exporting ${p.name}`, async () => {
                  const r = await call("projects.export", { id: p.id }, { timeoutMs: 10 * 60_000 });
                  onNotice({ text: `Exported ${r.files} files to ${r.path}` });
                })
              }
            >
              Export as .zip
            </Item>
            <Item
              icon={archived ? ArchiveRestore : Archive}
              onSelect={() =>
                void run(archived ? "Restoring" : "Archiving", async () => {
                  await call("projects.update", { id: p.id, archived: !archived });
                  await refresh();
                  onNotice(null);
                })
              }
            >
              {archived ? "Restore from archive" : "Archive"}
            </Item>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Item icon={Trash2} danger onSelect={() => setDialog({ kind: "remove", projectId: p.id })}>
              Remove from Depo…
            </Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </li>
  );
}

function Item({
  icon: Icon,
  onSelect,
  danger,
  children,
}: {
  icon: typeof Pencil;
  onSelect: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover",
        danger ? "text-danger" : "text-fg",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {children}
    </Menu.Item>
  );
}

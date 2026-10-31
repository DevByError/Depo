import { useMutation, useQuery } from "@tanstack/react-query";
import { Folder, FolderOpen, FolderPlus, GitBranch, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/connection";
import { call } from "@/lib/engine";
import { openProject, pickFolder, selectProject } from "@/lib/projects";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

export function ProjectsSection() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => call("projects.list", {}), enabled });
  const [typing, setTyping] = useState(false);
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

  const list = projects.data?.projects ?? [];
  return (
    <div>
      <div className="mt-3 mb-1.5 flex items-center px-2">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">Projects</h2>
        <button
          type="button"
          onClick={() => void onOpen()}
          disabled={!enabled}
          aria-label="Open a project folder"
          title="Open a project folder"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <FolderPlus className="size-3.5" />
        </button>
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
            placeholder="C:\\path\\to\\project"
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
        <button
          type="button"
          onClick={() => void onOpen()}
          disabled={!enabled}
          className="mx-1 flex w-[calc(100%-8px)] flex-col items-start rounded-lg border border-dashed border-border p-3 text-left text-xs leading-relaxed text-subtle hover:border-accent hover:text-muted"
        >
          <FolderPlus className="mb-1.5 size-4 text-muted" aria-hidden />
          Open a project folder to start. Depo works on a copy and only changes your files when you approve.
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Projects">
          {list.map((p) => {
            const active = p.id === projectId;
            const Icon = active ? FolderOpen : Folder;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => selectProject(p.id)}
                  aria-current={active ? "true" : undefined}
                  title={p.rootPath}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    active ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.branch && (
                    <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-subtle">
                      <GitBranch className="size-3" aria-hidden />
                      {p.branch}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

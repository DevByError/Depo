import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useNav } from "@/store/nav";
import { useUi } from "@/store/ui";

/** Read-only project browser. Agents work on a copy; this always shows the real files. */
export function FilesPanel() {
  const projectId = useUi((s) => s.projectId);
  const request = useNav((s) => s.file);
  const [selected, setSelected] = useState<string | null>(request?.path ?? null);
  const [goto, setGoto] = useState<{ line: number; seq: number } | null>(null);
  // A jump from search or the code map: open that file (at that line, if given).
  useEffect(() => {
    if (!request) return;
    setSelected(request.path);
    setGoto(request.line ? { line: request.line, seq: request.seq } : null);
    useNav.getState().clearFile();
  }, [request]);
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-sm">
          <FolderTree className="mx-auto mb-3 size-6 text-muted" aria-hidden />
          <h2 className="text-[14px] font-semibold text-fg">No project open</h2>
          <p className="mt-1 text-[13px] text-muted">
            Open a project folder from the sidebar to browse its files.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <nav className="w-64 shrink-0 overflow-y-auto border-r border-border py-1" aria-label="Project files">
        <Dir
          projectId={projectId}
          path="."
          depth={0}
          selected={selected}
          onSelect={(p) => {
            setSelected(p);
            setGoto(null);
          }}
        />
      </nav>
      <section
        className="min-w-0 flex-1 overflow-auto"
        tabIndex={0}
        aria-label={selected ? `File ${selected}` : "File preview"}
      >
        {selected ? (
          <Viewer projectId={projectId} path={selected} goto={goto} />
        ) : (
          <p className="p-4 text-xs text-muted">Choose a file to preview it.</p>
        )}
      </section>
    </div>
  );
}

function Dir({
  projectId,
  path,
  depth,
  selected,
  onSelect,
}: {
  projectId: string;
  path: string;
  depth: number;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  const enabled = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["files", projectId, path],
    queryFn: () => call("files.list", { projectId, path }),
    enabled,
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isError) return <p className="px-2 text-[11px] text-danger">{String(q.error)}</p>;
  return (
    <ul>
      {(q.data?.entries ?? []).map((e) => {
        const isOpen = open.has(e.path);
        const pad = { paddingLeft: `${8 + depth * 12}px` };
        if (e.type === "dir") {
          return (
            <li key={e.path}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  const next = new Set(open);
                  if (isOpen) next.delete(e.path);
                  else next.add(e.path);
                  setOpen(next);
                }}
                style={pad}
                className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-muted hover:bg-hover hover:text-fg"
              >
                {isOpen ? (
                  <ChevronDown className="size-3" aria-hidden />
                ) : (
                  <ChevronRight className="size-3" aria-hidden />
                )}
                <Folder className="size-3.5 text-subtle" aria-hidden />
                <span className="truncate">{e.name}</span>
              </button>
              {isOpen && (
                <Dir
                  projectId={projectId}
                  path={e.path}
                  depth={depth + 1}
                  selected={selected}
                  onSelect={onSelect}
                />
              )}
            </li>
          );
        }
        return (
          <li key={e.path}>
            <button
              type="button"
              onClick={() => onSelect(e.path)}
              aria-current={selected === e.path ? "true" : undefined}
              style={{ paddingLeft: `${20 + depth * 12}px` }}
              className={cn(
                "flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs",
                selected === e.path ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <File className="size-3.5 shrink-0 text-subtle" aria-hidden />
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Viewer({
  projectId,
  path,
  goto,
}: {
  projectId: string;
  path: string;
  goto: { line: number; seq: number } | null;
}) {
  const q = useQuery({
    queryKey: ["files", projectId, "read", path],
    queryFn: () => call("files.read", { projectId, path }),
  });
  const body = useRef<HTMLTableSectionElement>(null);
  const loaded = !!q.data;
  useEffect(() => {
    if (!goto || !loaded) return;
    body.current?.querySelector(`[data-line="${goto.line}"]`)?.scrollIntoView?.({ block: "center" });
  }, [goto, loaded]);
  if (q.isLoading) return <p className="p-4 text-xs text-muted">Loading…</p>;
  if (q.isError) return <p className="p-4 text-xs text-danger">{String(q.error)}</p>;
  const f = q.data;
  if (!f) return null;
  if (f.binary || f.text === null)
    return <p className="p-4 text-xs text-muted">Binary file ({f.size} bytes).</p>;
  const lines = f.text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <div className="p-3">
      <div className="mb-2 font-mono text-xs text-fg">{f.path}</div>
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody ref={body}>
          {lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            <tr key={i} data-line={i + 1} className={goto?.line === i + 1 ? "bg-accent-soft" : undefined}>
              <td className="w-10 select-none pr-3 text-right align-top text-[11px] text-subtle">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all text-fg">{l || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {f.truncated && <p className="mt-2 text-xs text-muted">Showing the first 512 KB.</p>}
    </div>
  );
}

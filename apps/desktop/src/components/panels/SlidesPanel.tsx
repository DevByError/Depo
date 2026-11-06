import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Download, Presentation } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

export function SlidesPanel() {
  const status = useEngine((s) => s.status);
  const projectId = useUi((s) => s.projectId);
  const taskId = useUi((s) => s.taskId);
  const list = useQuery({
    queryKey: ["decks", projectId, taskId],
    queryFn: () => call("decks.list", { projectId: projectId ?? "", ...(taskId ? { taskId } : {}) }),
    enabled: status === "open" && !!projectId,
  });
  const decks = list.data?.decks ?? [];
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    if (!dir && decks[0]) setDir(decks[0].dir);
  }, [dir, decks]);
  const deck = decks.find((d) => d.dir === dir) ?? null;

  const html = useQuery({
    queryKey: ["decks", "html", projectId, taskId, dir],
    queryFn: () =>
      call("decks.html", { projectId: projectId ?? "", ...(taskId ? { taskId } : {}), dir: dir ?? "" }),
    enabled: status === "open" && !!projectId && !!dir,
  });
  const exp = useMutation({
    mutationFn: (format: "pptx" | "pdf" | "html") =>
      call("decks.export", {
        projectId: projectId ?? "",
        ...(taskId ? { taskId } : {}),
        dir: dir ?? "",
        format,
      }),
  });

  if (!projectId || decks.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
        <Presentation className="size-8 text-subtle" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">No decks yet</h2>
        <p className="text-[13px] leading-relaxed text-muted">
          {projectId
            ? "The Project Management agent builds a pitch or progress deck in docs/deck at the end of a Full system task, using real screenshots. Ask for one in the Chat tab with the Business work mode."
            : "Open a project to see its decks."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Decks" className="w-56 shrink-0 border-r border-border bg-panel p-2">
        <ul>
          {decks.map((d) => (
            <li key={d.dir}>
              <button
                type="button"
                onClick={() => setDir(d.dir)}
                aria-current={d.dir === dir ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-hover",
                  d.dir === dir && "bg-hover",
                )}
              >
                <span className="truncate text-[13px] text-fg">{d.title}</span>
                <span className="text-[11px] text-subtle">
                  {d.kind === "pitch" ? "Pitch" : "Progress"} · {d.slides} slides
                  {d.source === "workspace" ? " · not applied yet" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{deck?.title}</h2>
          {(["pptx", "pdf", "html"] as const).map((f) => (
            <Button key={f} size="sm" disabled={exp.isPending} onClick={() => exp.mutate(f)}>
              <Download aria-hidden /> {f.toUpperCase()}
            </Button>
          ))}
        </div>
        {exp.isSuccess && (
          <p role="status" className="flex items-center gap-1.5 px-4 pt-2 text-xs text-success">
            <Check className="size-3.5" aria-hidden /> Saved to {exp.data.path}
          </p>
        )}
        {exp.isError && (
          <p role="alert" className="px-4 pt-2 text-xs text-danger">
            {(exp.error as Error).message}
          </p>
        )}
        <div className="min-h-0 flex-1 p-4">
          {html.data ? (
            <iframe
              title={`Deck: ${deck?.title ?? ""}`}
              srcDoc={html.data.html}
              sandbox="allow-scripts"
              className="size-full rounded-lg border border-border bg-black"
            />
          ) : (
            <p className="text-xs text-muted">Loading the deck…</p>
          )}
        </div>
        <p className="px-4 pb-2 text-[11px] text-subtle">
          Click the right or left half of a slide, or use the arrow keys.
        </p>
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { isActive } from "@/components/panels/ChatPanel";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/** Tasks of the open project that are still working; clicking one opens it in Chat. */
export function RunningSection() {
  const enabled = useEngine((s) => s.status === "open");
  const projectId = useUi((s) => s.projectId);
  const setTaskId = useUi((s) => s.setTaskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const tasks = useQuery({
    queryKey: ["tasks", "list", projectId],
    queryFn: () => call("tasks.list", { projectId: projectId ?? "" }),
    enabled: enabled && !!projectId,
  });
  const running = (tasks.data?.tasks ?? []).filter((t) => isActive(t.status));
  if (running.length === 0) {
    return (
      <div className="mx-1 flex items-center gap-2 px-2 py-1 text-xs text-subtle">
        <Play className="size-3.5" aria-hidden /> Nothing running
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Running tasks">
      {running.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => {
              setTaskId(t.id);
              setCenterTab("chat");
            }}
            className="mx-1 flex w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
            <span className="truncate">{t.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

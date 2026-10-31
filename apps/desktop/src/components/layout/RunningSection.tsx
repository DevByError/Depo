import { useMutation, useQuery } from "@tanstack/react-query";
import { Hourglass, Loader2, Pause, Play, UserRound } from "lucide-react";
import { useEffect } from "react";
import { call } from "@/lib/engine";
import { selectProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

/**
 * Every task that is still working, in any project, with its project's name. Clicking one opens
 * that project's Chat on the task. The line below shows the shared model queue.
 */
export function RunningSection() {
  const enabled = useEngine((s) => s.status === "open");
  const setTaskId = useUi((s) => s.setTaskId);
  const setCenterTab = useUi((s) => s.setCenterTab);
  const active = useQuery({
    queryKey: ["tasks", "active"],
    queryFn: () => call("tasks.active", {}),
    enabled,
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => call("projects.list", { includeArchived: true }),
    enabled,
  });
  const busy = (active.data?.tasks.length ?? 0) > 0;
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: () => call("scheduler.status", {}),
    enabled,
    refetchInterval: busy ? 3000 : false,
  });
  // Refresh the queue line when a task starts or finishes.
  const count = active.data?.tasks.length ?? 0;
  useEffect(() => {
    if (enabled && count >= 0) void queryClient.invalidateQueries({ queryKey: ["scheduler"] });
  }, [count, enabled]);
  const toggle = useMutation({
    mutationFn: (pause: boolean) => call(pause ? "scheduler.pause" : "scheduler.resume", {}),
    onSuccess: (s) => queryClient.setQueryData(["scheduler"], s),
  });

  const names = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const running = active.data?.tasks ?? [];
  const s = scheduler.data;
  const queuedTasks = new Set((s?.queued ?? []).map((j) => j.taskId));

  return (
    <div>
      {running.length === 0 ? (
        <div className="mx-1 flex items-center gap-2 px-2 py-1 text-xs text-subtle">
          <Play className="size-3.5" aria-hidden /> Nothing running
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Running tasks">
          {running.map((t) => {
            const waitingForUser = t.status === "waiting";
            const queued = queuedTasks.has(t.id);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (useUi.getState().projectId !== t.projectId) selectProject(t.projectId);
                    setTaskId(t.id);
                    setCenterTab("chat");
                  }}
                  className="mx-1 flex w-[calc(100%-8px)] items-start gap-2 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
                >
                  {waitingForUser ? (
                    <UserRound className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="Needs you" />
                  ) : queued ? (
                    <Hourglass
                      className="mt-0.5 size-3.5 shrink-0 text-subtle"
                      aria-label="Waiting for the model"
                    />
                  ) : (
                    <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t.title}</span>
                    <span className="block truncate text-[10px] text-subtle">
                      {names.get(t.projectId) ?? "Project"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {s && ((running.length > 0 && (s.running.length > 0 || s.queued.length > 0)) || s.pausedAll) && (
        <div
          className="mx-1 mt-1 flex items-center gap-2 px-2 text-[11px] text-subtle"
          data-testid="model-queue"
        >
          <span className="flex-1">
            {s.pausedAll
              ? "Paused: no new model work starts"
              : `Model: ${s.running.length} working${s.queued.length ? `, ${s.queued.length} waiting` : ""}`}
          </span>
          <button
            type="button"
            onClick={() => toggle.mutate(!s.pausedAll)}
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-fg"
          >
            {s.pausedAll ? <Play className="size-3" aria-hidden /> : <Pause className="size-3" aria-hidden />}
            {s.pausedAll ? "Resume all" : "Pause all"}
          </button>
        </div>
      )}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { useBottomTarget, useTerminal } from "@/store/terminal";

/** The places a command or check can run: the project folder and task copies not applied yet. */
export function useTargets(projectId: string) {
  const connected = useEngine((s) => s.status === "open");
  return useQuery({
    queryKey: ["previews", "targets", projectId],
    queryFn: () => call("preview.targets", { projectId }),
    enabled: connected,
  });
}

/** "Your project", or the title of the task whose copy it is. */
export function useTargetLabel(projectId: string, taskId: string | null): string {
  const targets = useTargets(projectId);
  if (!taskId) return "Your project";
  return targets.data?.targets.find((t) => t.taskId === taskId)?.label ?? "the task's copy";
}

/**
 * Where the Terminal runs commands and Problems checks code: the project folder, or a task's
 * private copy whose changes are not applied yet. Shared by both tabs, per project.
 */
export function TargetPicker({ projectId }: { projectId: string }) {
  const value = useBottomTarget(projectId);
  const setTarget = useTerminal((s) => s.setTarget);
  const targets = useTargets(projectId);
  const list = targets.data?.targets ?? [{ taskId: null, label: "Project folder", status: null }];

  // A task copy that was applied or removed is gone: fall back to the project folder.
  useEffect(() => {
    if (value && targets.data && !targets.data.targets.some((t) => t.taskId === value)) {
      setTarget(projectId, null);
    }
  }, [value, targets.data, projectId, setTarget]);

  return (
    <label className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted">
      <span className="shrink-0">Where</span>
      <select
        value={value ?? ""}
        onChange={(e) => setTarget(projectId, e.target.value || null)}
        onFocus={() => void targets.refetch()}
        className="h-7 min-w-0 max-w-48 truncate rounded-md border border-border bg-raised px-1.5 text-xs text-fg outline-none focus:border-accent"
      >
        {list.map((t) => (
          <option key={t.taskId ?? "project"} value={t.taskId ?? ""}>
            {t.taskId ? `Task copy: ${t.label} (not applied yet)` : "Your project"}
          </option>
        ))}
      </select>
    </label>
  );
}

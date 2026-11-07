import type { PreviewInfo } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/engine";
import { openExternal } from "@/lib/open-url";
import { useEngine } from "@/store/engine";

const RANK: Record<PreviewInfo["role"], number> = { frontend: 0, app: 1, backend: 2 };

/** The running copy of a task (a frontend before an app before a backend). */
export function runningAppFor(previews: PreviewInfo[], taskId: string): PreviewInfo | null {
  const mine = previews.filter((p) => p.taskId === taskId);
  const pick = (state: PreviewInfo["state"]) =>
    mine.filter((p) => p.state === state).sort((a, b) => RANK[a.role] - RANK[b.role])[0] ?? null;
  return pick("running") ?? pick("starting");
}

/**
 * "Open the running app" next to Review changes: the task's private copy, started by Depo when the
 * changes became ready (or by the owner in the Preview tab). Nothing shows when no copy is running.
 */
export function RunningAppLink({ projectId, taskId }: { projectId: string; taskId: string }) {
  const connected = useEngine((s) => s.status === "open");
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["previews", "list", projectId],
    queryFn: () => call("preview.list", { projectId }),
    enabled: connected,
    refetchInterval: (q) => (q.state.data?.previews.some((p) => p.state === "starting") ? 1000 : false),
  });
  const app = runningAppFor(list.data?.previews ?? [], taskId);
  if (!app) return null;
  if (app.state === "starting")
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Starting the app
      </span>
    );
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        title={app.url}
        onClick={() => {
          setError(null);
          openExternal(app.url).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
      >
        <ExternalLink /> Open the running app
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </>
  );
}

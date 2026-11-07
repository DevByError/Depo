import type { ChangeSet } from "@depo/shared";
import { CheckCircle2, GitCommitHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { committedFromEvents, useGitStatus } from "@/lib/git";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { CommitDialog } from "./CommitDialog";

/**
 * Shown in Diff Review under an applied change set when the project is a git repository:
 * offers to commit the applied files, or says where they were committed.
 */
export function CommitChangesBar({ projectId, changeSet }: { projectId: string; changeSet: ChangeSet }) {
  const status = useGitStatus(projectId);
  const events = useEngine((s) => s.events);
  const committed = useMemo(() => committedFromEvents(events, changeSet.id), [events, changeSet.id]);
  const [open, setOpen] = useState(false);
  const applied = changeSet.status === "applied" || changeSet.status === "partially_applied";
  if (!applied || !status.data?.isRepo) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-raised/40 px-4 py-1.5 text-xs text-muted">
      {committed ? (
        <>
          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
          <span className="min-w-0 flex-1">
            Committed as <code className="font-mono text-fg">{committed.shortHash}</code>
            {committed.branch ? (
              <>
                {" "}
                on <span className="font-mono text-fg">{committed.branch}</span>
              </>
            ) : null}
            .
          </span>
          <Button size="sm" variant="ghost" onClick={() => useUi.getState().setBottomTab("history")}>
            Show history
          </Button>
        </>
      ) : (
        <>
          <GitCommitHorizontal className="size-3.5 shrink-0 text-subtle" aria-hidden />
          <span className="min-w-0 flex-1">
            These changes are in your project. Commit them to keep a clean history.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Commit these changes
          </Button>
        </>
      )}
      <CommitDialog projectId={projectId} changeSetId={changeSet.id} open={open} onOpenChange={setOpen} />
    </div>
  );
}

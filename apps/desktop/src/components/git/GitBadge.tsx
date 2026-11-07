import { GitBranch } from "lucide-react";
import { cn } from "@/lib/cn";
import { changesHint, useGitStatus } from "@/lib/git";
import { useUi } from "@/store/ui";

/**
 * The project's branch and how many changes are not committed, as a small button that opens the
 * commit history. Renders nothing when the project is not a git repository.
 * Made to sit in the Project tab's header, next to the project name.
 */
export function GitBranchBadge({ projectId, className }: { projectId: string; className?: string }) {
  const status = useGitStatus(projectId);
  const st = status.data;
  if (!st?.isRepo) return null;
  const branch = st.branch ?? (st.detached ? "detached HEAD" : "no branch");
  return (
    <button
      type="button"
      onClick={() => useUi.getState().setBottomTab("history")}
      title="Show the commit history"
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border bg-raised px-2 text-[11px] text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-medium text-fg">{branch}</span>
      <span className={cn("shrink-0", st.changes > 0 ? "text-warning" : "text-subtle")}>
        · {changesHint(st.changes)}
      </span>
    </button>
  );
}

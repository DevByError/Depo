import type { GitCommitSummary } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, History, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { changesHint, relativeTime, useGitStatus } from "@/lib/git";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { CommitDiff } from "./CommitDiff";

const PAGE = 50;

/** The project's recent commits; choose one to read its changes. Read-only. */
export function HistoryPanel() {
  const projectId = useUi((s) => s.projectId);
  if (!projectId) return <Note icon={History}>Open a project to see its commit history.</Note>;
  return <ProjectHistory projectId={projectId} />;
}

function ProjectHistory({ projectId }: { projectId: string }) {
  const connected = useEngine((s) => s.status === "open");
  const status = useGitStatus(projectId);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const isRepo = status.data?.isRepo === true;
  const log = useQuery({
    queryKey: ["git", "log", projectId, limit],
    queryFn: () => call("git.log", { projectId, limit }),
    enabled: connected && isRepo,
    staleTime: 5000,
    refetchInterval: () => (typeof document !== "undefined" && document.hidden ? false : 30_000),
  });
  const commits = log.data?.commits ?? [];
  const current = commits.find((c) => c.hash === selected) ?? commits[0] ?? null;

  // A new project starts at its newest commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the project changes.
  useEffect(() => {
    setSelected(null);
    setLimit(PAGE);
  }, [projectId]);

  if (status.isLoading)
    return (
      <Note icon={Loader2} spin>
        Reading the repository…
      </Note>
    );
  const st = status.data;
  if (!st)
    return <Note icon={History}>{status.error ? String(status.error) : "History is not available."}</Note>;
  if (!st.gitAvailable)
    return (
      <Note icon={History}>
        Git is not installed. Install Git for Windows to see history and commit from Depo.
      </Note>
    );
  if (!st.isRepo)
    return (
      <Note icon={History}>
        This project is not a git repository. Depo still saves a checkpoint for every apply, so you can undo
        it in Diff Review.
      </Note>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-muted">
        <GitBranch className="size-3.5 shrink-0 text-subtle" aria-hidden />
        <span className="truncate font-medium text-fg">
          {st.branch ?? (st.detached ? "detached HEAD" : "no branch")}
        </span>
        <span className={cn("shrink-0", st.changes > 0 ? "text-warning" : "text-subtle")}>
          {changesHint(st.changes)}
        </span>
        <span className="flex-1" />
        <IconButton
          icon={RefreshCw}
          label="Refresh the history"
          onClick={() => {
            void status.refetch();
            void log.refetch();
          }}
        />
      </header>
      {log.isError ? (
        <p role="alert" className="p-3 text-xs text-danger">
          {String(log.error)}
        </p>
      ) : commits.length === 0 ? (
        <Note icon={GitCommitHorizontal}>{log.isLoading ? "Loading commits…" : "No commits yet."}</Note>
      ) : (
        <div className="flex min-h-0 flex-1">
          <CommitList
            commits={commits}
            current={current?.hash ?? null}
            onSelect={setSelected}
            canLoadMore={commits.length >= limit && limit < 200}
            onMore={() => setLimit((l) => Math.min(200, l + PAGE))}
          />
          {current && <CommitDetail projectId={projectId} commit={current} />}
        </div>
      )}
    </div>
  );
}

function CommitList({
  commits,
  current,
  onSelect,
  canLoadMore,
  onMore,
}: {
  commits: GitCommitSummary[];
  current: string | null;
  onSelect: (hash: string) => void;
  canLoadMore: boolean;
  onMore: () => void;
}) {
  const now = Date.now();
  return (
    <section
      className="w-[min(24rem,45%)] shrink-0 overflow-y-auto border-r border-border py-1"
      tabIndex={0}
      aria-label="Commits, newest first"
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-hash]")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
          e.preventDefault();
          next.focus();
          onSelect(next.dataset.hash ?? "");
        }
      }}
    >
      <ol>
        {commits.map((c) => (
          <li key={c.hash}>
            <button
              type="button"
              data-hash={c.hash}
              aria-current={c.hash === current ? "true" : undefined}
              onClick={() => onSelect(c.hash)}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left",
                c.hash === current ? "bg-accent-soft" : "hover:bg-hover",
              )}
            >
              <span className="truncate text-xs text-fg">{c.subject || "(no message)"}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                <span className="truncate">{c.author}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{relativeTime(c.date, now)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">
                  {c.files} file{c.files === 1 ? "" : "s"}
                </span>
                <span className="ml-auto shrink-0 font-mono text-subtle">{c.shortHash}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {canLoadMore && (
        <button
          type="button"
          onClick={onMore}
          className="mx-3 my-1.5 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
        >
          Show older commits
        </button>
      )}
    </section>
  );
}

function CommitDetail({ projectId, commit }: { projectId: string; commit: GitCommitSummary }) {
  const connected = useEngine((s) => s.status === "open");
  const show = useQuery({
    queryKey: ["git", "show", projectId, commit.hash],
    queryFn: () => call("git.show", { projectId, hash: commit.hash }, { timeoutMs: 30_000 }),
    enabled: connected,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const date = new Date(commit.date);
  return (
    <section
      className="min-w-0 flex-1 overflow-auto"
      tabIndex={0}
      aria-label={`Changes in commit ${commit.shortHash}`}
    >
      <div className="border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold text-fg">{commit.subject || "(no message)"}</h3>
        <p className="mt-0.5 text-[11px] text-muted">
          {commit.author} · {Number.isNaN(date.getTime()) ? commit.date : date.toLocaleString()} ·{" "}
          <span className="font-mono">{commit.shortHash}</span> ·{" "}
          <span className="text-success">+{commit.additions}</span>{" "}
          <span className="text-danger">−{commit.deletions}</span>
        </p>
        {commit.body && (
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">{commit.body}</p>
        )}
      </div>
      {show.isLoading ? (
        <p className="p-3 text-xs text-muted">Loading the changes…</p>
      ) : show.isError ? (
        <p role="alert" className="p-3 text-xs text-danger">
          {String(show.error)}
        </p>
      ) : (
        <CommitDiff files={show.data?.files ?? []} />
      )}
    </section>
  );
}

function Note({
  icon: Icon,
  spin,
  children,
}: {
  icon: typeof History;
  spin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <p className="flex max-w-md items-start gap-2 text-xs leading-relaxed text-muted">
        <Icon
          className={cn("mt-0.5 size-3.5 shrink-0 text-subtle", spin && "motion-safe:animate-spin")}
          aria-hidden
        />
        <span>{children}</span>
      </p>
    </div>
  );
}

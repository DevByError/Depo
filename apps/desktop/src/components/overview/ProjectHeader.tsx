import type { ApiResult } from "@depo/shared";
import { GitBranch, GitCommitHorizontal, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { Chip } from "./parts";

type Overview = ApiResult<"projects.overview">;
type Repo = ApiResult<"codemap.repo">;

/** Detected stack badges: languages, then frameworks and databases, at most eight. */
export function stackBadges(repo: Repo | undefined, fallback: string): string[] {
  const s = repo?.stack;
  const detected = s ? [...new Set([...s.languages, ...s.frameworks, ...s.databases])].slice(0, 8) : [];
  if (detected.length > 0) return detected;
  return fallback ? [fallback] : [];
}

/** Name, folder, what it is, the stack and where git stands. */
export function ProjectHeader({
  overview,
  repo,
  onEdit,
}: {
  overview: Overview;
  repo: Repo | undefined;
  onEdit(): void;
}) {
  const p = overview.project;
  const git = repo?.git ?? null;
  const branch = git?.branch ?? p.branch;
  const badges = stackBadges(repo, p.stack);
  return (
    <header className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold text-fg">{p.name}</h1>
        <p className="mt-0.5 truncate font-mono text-[11px] text-subtle" title={p.rootPath}>
          {p.rootPath}
        </p>
        {p.description && <p className="mt-2 text-[13px] leading-relaxed text-muted">{p.description}</p>}
        <ul aria-label="About this project" className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
          {badges.map((b) => (
            <li key={b}>
              <Chip className="bg-raised text-fg">{b}</Chip>
            </li>
          ))}
          {branch && (
            <li>
              <Chip>
                <GitBranch className="size-3" aria-hidden />
                {branch}
                {git && (
                  <span className="text-subtle">
                    {" · "}
                    {git.changed ? `${git.changed} changed` : "no changes"}
                    {git.ahead ? ` · ${git.ahead} ahead` : ""}
                    {git.behind ? ` · ${git.behind} behind` : ""}
                  </span>
                )}
              </Chip>
            </li>
          )}
          <li>
            <Chip>
              {p.origin === "created" ? "Created in Depo" : p.origin === "duplicated" ? "Copy" : "Imported"}
            </Chip>
          </li>
          {p.archivedAt && (
            <li>
              <Chip>Archived</Chip>
            </li>
          )}
        </ul>
        {git?.lastCommit && (
          <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-subtle">
            <GitCommitHorizontal className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              Last commit {formatRelative(git.lastCommit.date)}: {git.lastCommit.subject}
            </span>
          </p>
        )}
      </div>
      <Button size="sm" onClick={onEdit}>
        <Pencil aria-hidden /> Edit details
      </Button>
    </header>
  );
}

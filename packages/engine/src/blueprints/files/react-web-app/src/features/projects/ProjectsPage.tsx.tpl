import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, ButtonLink } from "@/components/ui/Button";
import { controlClass } from "@/components/ui/Field";
import { EmptyState, ErrorState, Loading } from "@/components/ui/States";
import { formatDate } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { type ProjectSort, type ProjectStatus, projectsApi, STATUS_LABELS } from "./api";
import { StatusBadge } from "./StatusBadge";

const PAGE_SIZE = 10;

/** The list screen: search, filter, sort, pages, and the loading, empty and error states. */
export function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ProjectStatus | "">("");
  const [sort, setSort] = useState<ProjectSort>("-created_at");
  const [page, setPage] = useState(1);

  // Wait until typing pauses before asking the API.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useAsync(
    (signal) => projectsApi.list({ q, status, sort, page, page_size: PAGE_SIZE }, signal),
    [q, status, sort, page],
  );
  const filtered = q !== "" || status !== "";

  return (
    <section aria-labelledby="projects-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="projects-title" className="text-xl font-semibold text-fg">
          Projects
        </h1>
        <ButtonLink to="/projects/new" variant="primary" className="ml-auto">
          New project
        </ButtonLink>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={controlClass}
        />
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as ProjectStatus | "");
            setPage(1);
          }}
          className={controlClass}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as ProjectSort)}
          className={controlClass}
        >
          <option value="-created_at">Newest first</option>
          <option value="created_at">Oldest first</option>
          <option value="name">Name A to Z</option>
          <option value="-name">Name Z to A</option>
          <option value="-updated_at">Recently changed</option>
        </select>
      </div>

      {list.status === "error" && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.status === "loading" && !list.data && <Loading label="Loading projects" />}
      {list.data && list.data.items.length === 0 && list.status !== "loading" && (
        <EmptyState
          title={filtered ? "No project matches" : "No projects yet"}
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch("");
                  setStatus("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <ButtonLink to="/projects/new" variant="primary">
                Create your first project
              </ButtonLink>
            )
          }
        >
          {filtered ? "Try another search or status." : "Projects you create show up here."}
        </EmptyState>
      )}
      {list.data && list.data.items.length > 0 && (
        <>
          <ul aria-busy={list.status === "loading"} className="divide-y divide-border rounded-lg border border-border bg-panel">
            {list.data.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link to={`/projects/${p.id}`} className="font-medium text-fg underline-offset-2 hover:underline">
                  {p.name}
                </Link>
                <StatusBadge status={p.status} />
                <span className="ml-auto text-xs text-muted">Changed {formatDate(p.updated_at)}</span>
              </li>
            ))}
          </ul>
          <nav aria-label="Pages" className="flex items-center justify-between gap-2 text-sm text-muted">
            <span>
              Page {list.data.page} of {Math.max(1, list.data.pages)} ({list.data.total} in total)
            </span>
            <div className="flex gap-2">
              <Button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
                Previous
              </Button>
              <Button disabled={page >= list.data.pages} onClick={() => setPage((n) => n + 1)}>
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}

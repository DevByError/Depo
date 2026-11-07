import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Alert, ErrorState, Loading } from "@/components/ui/States";
import { formatDate } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { projectsApi } from "./api";
import { StatusBadge } from "./StatusBadge";

export function ProjectDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const project = useAsync((signal) => projectsApi.get(id, signal), [id]);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setDeleting(true);
    setError("");
    try {
      await projectsApi.remove(id);
      navigate("/projects", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the project.");
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="project-title" className="flex flex-col gap-4">
      <Link to="/projects" className="text-sm text-muted underline-offset-2 hover:underline">
        Back to projects
      </Link>
      {project.status === "loading" && <Loading label="Loading the project" />}
      {project.status === "error" && <ErrorState error={project.error} onRetry={project.reload} />}
      {project.status === "success" && (
        <article className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 id="project-title" className="text-xl font-semibold text-fg">
              {project.data.name}
            </h1>
            <StatusBadge status={project.data.status} />
            <div className="ml-auto flex gap-2">
              <ButtonLink to={`/projects/${id}/edit`}>Edit</ButtonLink>
              {!confirming && (
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  Delete
                </Button>
              )}
            </div>
          </div>
          {confirming && (
            <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2 rounded-md bg-danger-soft px-3 py-2">
              <span className="text-sm text-fg">Delete this project? This cannot be undone.</span>
              <Button variant="danger" disabled={deleting} onClick={remove}>
                {deleting ? "Deleting..." : "Yes, delete it"}
              </Button>
              <Button onClick={() => setConfirming(false)}>Keep it</Button>
            </div>
          )}
          {error && <Alert>{error}</Alert>}
          <p className="whitespace-pre-wrap text-sm text-fg">{project.data.description || "No description yet."}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Created</dt>
            <dd className="text-fg">{formatDate(project.data.created_at)}</dd>
            <dt className="text-muted">Changed</dt>
            <dd className="text-fg">{formatDate(project.data.updated_at)}</dd>
          </dl>
        </article>
      )}
    </section>
  );
}

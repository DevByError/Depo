import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/Button";
import { SelectField, TextArea, TextField } from "@/components/ui/Field";
import { Alert, ErrorState, Loading } from "@/components/ui/States";
import { ApiError } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { type Project, type ProjectInput, projectsApi, STATUS_LABELS } from "./api";

const EMPTY: ProjectInput = { name: "", description: "", status: "active" };

export function validateProject(input: ProjectInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = "Enter a name.";
  else if (input.name.trim().length > 120) errors.name = "Keep the name under 120 characters.";
  if (input.description.length > 2000) errors.description = "Keep the description under 2000 characters.";
  return errors;
}

/** Create and edit share one form: /projects/new and /projects/:id/edit. */
export function ProjectFormPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const existing = useAsync<Project | null>((signal) => (id ? projectsApi.get(id, signal) : Promise.resolve(null)), [id]);
  if (existing.status === "loading") return <Loading label="Loading the project" />;
  if (existing.status === "error") return <ErrorState error={existing.error} onRetry={existing.reload} />;
  return <ProjectForm project={existing.data} />;
}

function ProjectForm({ project }: { project: Project | null }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<ProjectInput>(
    project ? { name: project.name, description: project.description, status: project.status } : EMPTY,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const title = project ? `Edit ${project.name}` : "New project";

  useEffect(() => {
    document.title = title;
  }, [title]);

  const set = (field: keyof ProjectInput) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateProject(values);
    setErrors(found);
    setFormError("");
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const input = { ...values, name: values.name.trim() };
      const saved = project ? await projectsApi.update(project.id, input) : await projectsApi.create(input);
      navigate(`/projects/${saved.id}`);
    } catch (err) {
      // Show the server's field messages next to the fields (409: the name is taken).
      if (err instanceof ApiError && err.details.length) setErrors(err.fieldErrors());
      else if (err instanceof ApiError && err.status === 409) setErrors({ name: err.message });
      setFormError(err instanceof Error ? err.message : "Could not save. Try again.");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="form-title" className="flex max-w-xl flex-col gap-4">
      <Link to={project ? `/projects/${project.id}` : "/projects"} className="text-sm text-muted underline-offset-2 hover:underline">
        Back
      </Link>
      <h1 id="form-title" className="text-xl font-semibold text-fg">
        {title}
      </h1>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-5">
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Name" value={values.name} onChange={set("name")} error={errors.name} maxLength={120} required />
        <TextArea
          label="Description"
          hint="Optional."
          value={values.description}
          onChange={set("description")}
          error={errors.description}
        />
        <SelectField label="Status" value={values.status} onChange={set("status")} error={errors.status}>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving..." : project ? "Save changes" : "Create project"}
          </Button>
          <Button onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

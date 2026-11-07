import { type ProjectStatus, STATUS_LABELS } from "./api";

const tone: Record<ProjectStatus, string> = {
  active: "border-success text-success",
  paused: "border-warning text-warning",
  done: "border-border text-muted",
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

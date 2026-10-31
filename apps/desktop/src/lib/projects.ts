import type { Project } from "@depo/shared";
import { useUi } from "@/store/ui";
import { isTauri } from "./connection";
import { call } from "./engine";
import { queryClient } from "./query";

/** Native folder picker in the desktop app; null when cancelled or not available. */
export async function pickFolder(title = "Open a project folder"): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export async function openProject(path: string): Promise<Project> {
  const project = await call("projects.open", { path });
  await afterProjectAdded(project);
  return project;
}

/** Select a project that was just created, imported, opened or duplicated. */
export async function afterProjectAdded(project: Project): Promise<void> {
  selectProject(project.id);
  await queryClient.invalidateQueries({ queryKey: ["projects"] });
}

export function selectProject(id: string | null): void {
  useUi.getState().setProjectId(id);
  void call("settings.set", { key: "ui.project_id", value: id }).catch(() => {});
}

/** The folder new projects and clones go into by default: last used, else next to the open project. */
export async function defaultParentDir(): Promise<string> {
  try {
    const last = await call("settings.get", { key: "ui.last_parent_dir" });
    if (typeof last.value === "string" && last.value) return last.value;
  } catch {
    // fall through
  }
  const current = useUi.getState().projectId;
  const list = queryClient.getQueryData<{ projects: Project[] }>(["projects"]);
  const root = list?.projects.find((p) => p.id === current)?.rootPath;
  if (!root) return "";
  const sep = root.includes("\\") ? "\\" : "/";
  return root.slice(0, root.lastIndexOf(sep)) || root;
}

export function rememberParentDir(dir: string): void {
  void call("settings.set", { key: "ui.last_parent_dir", value: dir }).catch(() => {});
}

import type { Project } from "@depo/shared";
import { useUi } from "@/store/ui";
import { isTauri } from "./connection";
import { call } from "./engine";
import { queryClient } from "./query";

/** Native folder picker in the desktop app; null when cancelled or not available. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open a project folder" });
  return typeof picked === "string" ? picked : null;
}

export async function openProject(path: string): Promise<Project> {
  const project = await call("projects.open", { path });
  selectProject(project.id);
  await queryClient.invalidateQueries({ queryKey: ["projects"] });
  return project;
}

export function selectProject(id: string | null): void {
  useUi.getState().setProjectId(id);
  void call("settings.set", { key: "ui.project_id", value: id }).catch(() => {});
}

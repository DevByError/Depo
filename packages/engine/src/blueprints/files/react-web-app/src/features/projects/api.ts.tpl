import { api } from "@/lib/session";

/** The projects endpoints, typed. Copy this file for a new resource. */

export type ProjectStatus = "active" | "paused" | "done";
export type ProjectSort = "name" | "-name" | "created_at" | "-created_at" | "updated_at" | "-updated_at";

export interface Project {
  id: number;
  owner_id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  description: string;
  status: ProjectStatus;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export type ProjectFilters = {
  page?: number;
  page_size?: number;
  status?: ProjectStatus | "";
  q?: string;
  sort?: ProjectSort;
};

export const STATUS_LABELS: Record<ProjectStatus, string> = { active: "Active", paused: "Paused", done: "Done" };

export const projectsApi = {
  list: (filters: ProjectFilters, signal?: AbortSignal) =>
    api.get<Page<Project>>("/api/projects", filters, signal),
  get: (id: number, signal?: AbortSignal) => api.get<Project>(`/api/projects/${id}`, undefined, signal),
  create: (input: ProjectInput) => api.post<Project>("/api/projects", input),
  update: (id: number, input: Partial<ProjectInput>) => api.patch<Project>(`/api/projects/${id}`, input),
  remove: (id: number) => api.del(`/api/projects/${id}`),
};

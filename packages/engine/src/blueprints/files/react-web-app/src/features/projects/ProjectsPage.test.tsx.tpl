import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { Page, Project } from "./api";
import { ProjectsPage } from "./ProjectsPage";
import { validateProject } from "./ProjectFormPage";

const list = vi.fn<(filters: Record<string, unknown>) => Promise<Page<Project>>>();
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  projectsApi: { list: (filters: Record<string, unknown>) => list(filters) },
}));

function project(id: number, name: string, status: Project["status"] = "active"): Project {
  const at = "2026-01-02T10:00:00+00:00";
  return { id, owner_id: 1, name, description: "", status, created_at: at, updated_at: at };
}

function page(items: Project[], total = items.length, pages = 1): Page<Project> {
  return { items, total, page: 1, page_size: 10, pages };
}

function show() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => list.mockReset());

describe("ProjectsPage", () => {
  it("shows a loading state, then the projects as links", async () => {
    list.mockResolvedValue(page([project(1, "Launch"), project(2, "Mobile app", "paused")], 12, 2));
    show();
    expect(screen.getByRole("status").textContent).toContain("Loading projects");
    const link = await screen.findByRole("link", { name: "Launch" });
    expect(link.getAttribute("href")).toBe("/projects/1");
    expect(within(screen.getByRole("list")).getByText("Paused")).toBeTruthy();
    expect(screen.getByText(/Page 1 of 2/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("has an empty state that invites the first project", async () => {
    list.mockResolvedValue(page([]));
    show();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create your first project" })).toBeTruthy();
  });

  it("shows the error and tries again", async () => {
    list.mockRejectedValueOnce(new ApiError("Could not reach the server.", 0, "network_error"));
    list.mockResolvedValueOnce(page([project(1, "Launch")]));
    show();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the server.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Launch" })).toBeTruthy();
  });

  it("filters by status and searches after typing pauses", async () => {
    list.mockResolvedValue(page([project(1, "Launch")]));
    show();
    await screen.findByRole("link", { name: "Launch" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "done" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "done", page: 1 })));
    list.mockResolvedValue(page([]));
    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "  site " } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "site" })));
    expect(await screen.findByText("No project matches")).toBeTruthy();
  });
});

describe("validateProject", () => {
  it("explains what to fix", () => {
    expect(validateProject({ name: " ", description: "", status: "active" })).toEqual({ name: "Enter a name." });
    expect(validateProject({ name: "x".repeat(121), description: "", status: "active" }).name).toContain("120");
    expect(validateProject({ name: "Launch", description: "", status: "done" })).toEqual({});
  });
});

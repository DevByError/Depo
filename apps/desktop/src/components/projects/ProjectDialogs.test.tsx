import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const PROJECT = {
  id: "prj_new",
  name: "Shop",
  rootPath: "/home/me/code/Shop",
  lastOpenedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  isGit: true,
  branch: "main",
  description: "",
  stack: "",
  origin: "created",
  archivedAt: null,
  exists: true,
};
const BLUEPRINTS = [
  {
    id: "fullstack",
    title: "Full stack app",
    summary: "The API and the web app together.",
    stack: ["Python", "FastAPI", "React", "Vite", "Tailwind CSS"],
    features: ["Everything in the API, in api/", "One script starts both"],
    runCommand: "run.cmd",
    testCommand: "test.cmd",
    ports: [8000, 5173],
    extendGuide: "Add a feature end to end.",
    fileCount: 90,
  },
  {
    id: "fastapi-service",
    title: "FastAPI service",
    summary: "A REST API with accounts and roles.",
    stack: ["Python", "FastAPI", "SQLite"],
    features: ["Sign-up and sign-in with JWT", "Admin and user roles on every route"],
    runCommand: "python -m uvicorn app.main:app --reload --port 8000",
    testCommand: "python -m pytest -q",
    ports: [8000],
    extendGuide: "Copy the projects resource.",
    fileCount: 50,
  },
];

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "blueprints.list") return Promise.resolve({ blueprints: BLUEPRINTS });
    if (method === "blueprints.create")
      return Promise.resolve({ project: PROJECT, files: 50, git: "committed" });
    if (method === "projects.create") return Promise.resolve(PROJECT);
    if (method === "settings.get")
      return Promise.resolve({ key: "ui.last_parent_dir", value: "/home/me/code" });
    if (method === "settings.set") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { ProjectDialogs } from "./ProjectDialogs";

beforeEach(() => {
  calls.length = 0;
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: null, projectDialog: { kind: "new" }, centerTab: "chat" });
});
afterEach(cleanup);

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectDialogs />
    </QueryClientProvider>,
  );
}

async function fillBasics() {
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Shop" } });
  await waitFor(() =>
    expect((within(dialog).getByLabelText("Folder to create the project in") as HTMLInputElement).value).toBe(
      "/home/me/code",
    ),
  );
  return dialog;
}

test("New project: an empty folder is the default and keeps the Stack field", async () => {
  mount();
  const dialog = await fillBasics();
  const group = within(dialog).getByRole("radiogroup", { name: "Start from" });
  await within(group).findByRole("radio", { name: "Full stack app" });
  expect(within(group).getByRole("radio", { name: "Empty folder" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Stack/ }), { target: { value: "Python" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(calls.some((c) => c.method === "projects.create")).toBe(true));
  const sent = calls.find((c) => c.method === "projects.create")?.params as Record<string, unknown>;
  expect(sent).toMatchObject({ name: "Shop", parentDir: "/home/me/code", stack: "Python", initGit: true });
  expect(calls.some((c) => c.method === "blueprints.create")).toBe(false);
  await waitFor(() => expect(useUi.getState().projectDialog).toBeNull());
  expect(useUi.getState().projectId).toBe("prj_new");
});

test("New project: a blueprint card shows what you get, moves with the arrow keys, and creates from it", async () => {
  mount();
  const dialog = await fillBasics();
  const card = await within(dialog).findByRole("radio", { name: "Full stack app" });
  fireEvent.click(card);
  expect(card.getAttribute("aria-checked")).toBe("true");
  expect(card.getAttribute("tabindex")).toBe("0");
  expect(
    within(dialog).getByText("A tested starting point. Agents build your features on top of it."),
  ).toBeTruthy();
  expect(within(dialog).getByText("What you get")).toBeTruthy();
  expect(within(dialog).getByText("One script starts both")).toBeTruthy();
  // The blueprint brings its own stack.
  expect(within(dialog).queryByRole("textbox", { name: /^Stack/ })).toBeNull();
  expect(within(dialog).getByText(/goes in as the first commit/)).toBeTruthy();

  fireEvent.keyDown(card, { key: "ArrowDown" });
  const api = within(dialog).getByRole("radio", { name: "FastAPI service" });
  expect(api.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(api);
  expect(card.getAttribute("tabindex")).toBe("-1");
  expect(within(dialog).getByText("Admin and user roles on every route")).toBeTruthy();

  fireEvent.change(within(dialog).getByRole("textbox", { name: /What is it/ }), {
    target: { value: "Orders and stock" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(calls.some((c) => c.method === "blueprints.create")).toBe(true));
  const sent = calls.find((c) => c.method === "blueprints.create")?.params as Record<string, unknown>;
  expect(sent).toEqual({
    id: "fastapi-service",
    name: "Shop",
    parentDir: "/home/me/code",
    description: "Orders and stock",
    initGit: true,
  });
  expect(calls.some((c) => c.method === "projects.create")).toBe(false);
  await waitFor(() => expect(useUi.getState().projectDialog).toBeNull());
  expect(useUi.getState().projectId).toBe("prj_new");
  expect(useUi.getState().centerTab).toBe("overview");
});

test("New project: opened from a blueprint, that blueprint is already chosen", async () => {
  useUi.setState({ projectDialog: { kind: "new", blueprint: "fastapi-service" } });
  mount();
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  const api = await within(dialog).findByRole("radio", { name: "FastAPI service" });
  expect(api.getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByRole("radio", { name: "Empty folder" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  fireEvent.keyDown(api, { key: "Home" });
  expect(within(dialog).getByRole("radio", { name: "Empty folder" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(within(dialog).getByRole("textbox", { name: /^Stack/ })).toBeTruthy();
});

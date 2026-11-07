import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const BLUEPRINT = {
  id: "fastapi-service",
  title: "FastAPI service",
  summary: "A REST API with accounts and roles, tested with pytest.",
  stack: ["FastAPI", "SQLite", "pytest"],
  features: ["Admin and user roles on every route", "One JSON error format"],
  runCommand: "python -m uvicorn app.main:app --reload --port 8000",
  testCommand: "python -m pytest -q",
  ports: [8000],
  extendGuide: "Copy the projects resource.",
  fileCount: 3,
};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "blocks.list")
      return Promise.resolve({
        blocks: [
          {
            id: "auth-ts",
            name: "Login and sessions (TypeScript)",
            description: "Password hashing and signed tokens.",
            stack: "ts",
            tags: ["auth", "login"],
            files: ["src/auth/index.ts"],
            test: "bun test src/auth",
            notes: ["Create a users table."],
          },
          {
            id: "auth-py",
            name: "Login and sessions (Python)",
            description: "Standard library only.",
            stack: "py",
            tags: ["auth"],
            files: ["app/auth.py"],
            test: "",
            notes: ["Read the secret from the environment."],
          },
        ],
      });
    if (method === "tasks.send") return Promise.resolve({ id: "tsk_1" });
    if (method === "blueprints.list") return Promise.resolve({ blueprints: [BLUEPRINT] });
    if (method === "blueprints.get")
      return Promise.resolve({
        ...BLUEPRINT,
        files: [
          { path: "README.md", size: 900 },
          { path: "app/main.py", size: 2048 },
          { path: "app/core/config.py", size: 512 },
        ],
        totalBytes: 3460,
      });
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));

import { BlocksPanel } from "./BlocksPanel";

beforeEach(() => {
  calls.length = 0;
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", centerTab: "blocks", projectDialog: null });
});
afterEach(cleanup);

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BlocksPanel />
    </QueryClientProvider>,
  );
}

test("Blocks panel: filters by language and search, shows details, and asks the coder to add one", async () => {
  mount();
  expect(await screen.findByText("Login and sessions (TypeScript)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Python" }));
  expect(screen.queryByText("Login and sessions (TypeScript)")).toBeNull();
  expect(screen.getByText("Login and sessions (Python)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.change(screen.getByLabelText("Search blocks"), { target: { value: "zzz" } });
  expect(screen.getByText("No block matches.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search blocks"), { target: { value: "" } });

  fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as HTMLElement);
  expect(screen.getByText("Create a users table.")).toBeTruthy();
  expect(screen.getByText("bun test src/auth")).toBeTruthy();

  fireEvent.click(screen.getAllByRole("button", { name: "Add to project" })[0] as HTMLElement);
  await waitFor(() => expect(calls.some((c) => c.method === "tasks.send")).toBe(true));
  const sent = calls.find((c) => c.method === "tasks.send")?.params as { projectId: string; text: string };
  expect(sent.projectId).toBe("prj_1");
  expect(sent.text).toContain("use_block");
  expect(sent.text).toContain("auth-ts");
  await waitFor(() => expect(useUi.getState().centerTab).toBe("chat"));
  expect(useUi.getState().taskId).toBe("tsk_1");
});

test("Blocks panel: blueprints above the blocks, with what you get, a file tree and a way to start a project", async () => {
  mount();
  const section = await screen.findByRole("region", { name: "Blueprints" });
  expect(await within(section).findByRole("heading", { name: "FastAPI service" })).toBeTruthy();
  expect(within(section).getByText("A tested starting point.", { exact: false })).toBeTruthy();
  expect(within(section).getByText("SQLite")).toBeTruthy();
  expect(within(section).getByText("What you get")).toBeTruthy();
  expect(within(section).getByText("One JSON error format")).toBeTruthy();
  // The section comes before the building blocks.
  const blocksTitle = screen.getByRole("heading", { name: "Building blocks" });
  expect(section.compareDocumentPosition(blocksTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const show = within(section).getByRole("button", { name: "Show files of FastAPI service" });
  expect(show.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(show);
  const tree = await screen.findByRole("region", { name: "Files in the FastAPI service blueprint" });
  expect(tree.getAttribute("tabindex")).toBe("0");
  expect(within(tree).getByText("app/")).toBeTruthy();
  expect(within(tree).getByText("core/")).toBeTruthy();
  expect(within(tree).getByText("main.py")).toBeTruthy();
  expect(within(tree).getByText("2.0 KB")).toBeTruthy();
  expect(within(tree).getByText("900 B")).toBeTruthy();
  expect(calls.some((c) => c.method === "blueprints.get")).toBe(true);
  expect(
    within(section)
      .getByRole("button", { name: "Hide files of FastAPI service" })
      .getAttribute("aria-expanded"),
  ).toBe("true");

  fireEvent.click(within(section).getByRole("button", { name: "Start a project from FastAPI service" }));
  expect(useUi.getState().projectDialog).toEqual({ kind: "new", blueprint: "fastapi-service" });
});

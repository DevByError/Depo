import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
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
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));

import { BlocksPanel } from "./BlocksPanel";

beforeEach(() => {
  calls.length = 0;
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", centerTab: "blocks" });
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

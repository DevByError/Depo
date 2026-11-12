import type { Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDrafts } from "@/store/composer";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

// The owner: Depo asks once, when a task starts, whether it may run everything; after a yes it
// never asks again.

const calls: { method: string; params: unknown }[] = [];
let fullAccess = false;
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "projects.settings.get") return Promise.resolve({ fullAccess });
    if (method === "projects.settings.set") return Promise.resolve({});
    if (method === "tasks.send") return Promise.resolve(task());
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));

import { Composer } from "./Composer";

const now = "2026-11-13T10:00:00.000Z";
const task = (): Task => ({
  id: "tsk_new",
  projectId: "prj_1",
  title: "Login",
  prompt: "Build a login",
  status: "queued",
  mode: "single",
  model: null,
  summary: null,
  error: null,
  createdAt: now,
  updatedAt: now,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Composer task={undefined} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Message the coding agent"), { target: { value: "build a login" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}
const sent = () => calls.find((c) => c.method === "tasks.send")?.params as { allowAll?: boolean } | undefined;

beforeEach(() => {
  calls.length = 0;
  fullAccess = false;
  localStorage.clear();
  useDrafts.setState({ drafts: {} });
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: null });
});
afterEach(cleanup);

describe("allow everything at the start of a task", () => {
  it("asks first, and a yes is sent with the task", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, allow everything in this task" }));
    await waitFor(() => expect(sent()).toBeTruthy());
    expect(sent()?.allowAll).toBe(true);
  });

  it("a no sends the task without it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "No, ask me each time" }));
    await waitFor(() => expect(sent()).toBeTruthy());
    expect(sent()?.allowAll).toBeUndefined();
  });

  it("a project with full access is not asked", async () => {
    fullAccess = true;
    mount();
    await waitFor(() => expect(sent()).toBeTruthy());
    expect(screen.queryByText("Let Depo work without asking?")).toBeNull();
  });
});

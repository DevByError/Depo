import type { Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngine } from "@/store/engine";

const calls: { method: string; params: unknown }[] = [];
let reply: () => Promise<unknown> = () => Promise.resolve({});
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    return reply();
  },
}));

import { RetryBar } from "@/components/panels/ChatPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = "2026-11-08T01:30:00.000Z";
const task = (status: Task["status"]): Task => ({
  id: "tsk_9",
  projectId: "prj_1",
  title: "Build Skill Finder part 1",
  prompt: "Build Skill Finder part 1",
  status,
  mode: "single",
  model: "qwen2.5-coder:3b",
  summary: null,
  error: status === "failed" ? "The model kept writing tool calls that could not be read." : null,
  createdAt: now,
  updatedAt: now,
});

beforeEach(() => {
  calls.length = 0;
  reply = () => Promise.resolve(task("queued"));
  useEngine.setState({ status: "open" });
});
afterEach(cleanup);

describe("Retry after a failed or stopped run", () => {
  it("runs the last message again with one click", async () => {
    wrap(<RetryBar task={task("failed")} />);
    expect(screen.getByText(/This run did not finish/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry your last message" }));
    await waitFor(() => expect(calls).toEqual([{ method: "tasks.retry", params: { id: "tsk_9" } }]));
  });

  it("says when the owner stopped the run, and shows why a retry was refused", async () => {
    reply = () => Promise.reject(new Error("This task is still working. Wait for it or stop it first."));
    wrap(<RetryBar task={task("cancelled")} />);
    expect(screen.getByText(/You stopped this run/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry your last message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("still working");
  });

  it("waits for the engine connection", () => {
    useEngine.setState({ status: "connecting" });
    wrap(<RetryBar task={task("failed")} />);
    expect(
      (screen.getByRole("button", { name: "Retry your last message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

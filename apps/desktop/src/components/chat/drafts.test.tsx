import type { Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftKey, useDrafts } from "@/store/composer";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

// The owner: text and pictures in the chat box were gone after visiting another tab, and text
// typed for a new task showed up in the old task when they went back to it.

const calls: { method: string; params: unknown }[] = [];
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "tasks.send") return Promise.resolve({ ...task("tsk_new"), status: "queued" });
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));

import { Composer } from "./Composer";

const now = "2026-11-10T10:00:00.000Z";
const task = (id: string): Task => ({
  id,
  projectId: "prj_1",
  title: "Login system",
  prompt: "Build a login system",
  status: "review",
  mode: "single",
  model: null,
  summary: null,
  error: null,
  createdAt: now,
  updatedAt: now,
});
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

function ui(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return {
    ...r,
    show: (n: ReactNode) => r.rerender(<QueryClientProvider client={qc}>{n}</QueryClientProvider>),
  };
}
const box = () => screen.getByLabelText("Message the coding agent") as HTMLTextAreaElement;

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  useDrafts.setState({ drafts: {} });
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: null });
});
afterEach(cleanup);

describe("chat drafts", () => {
  it("text and a picture stay when the chat screen closes and opens again", async () => {
    const first = ui(<Composer task={task("tsk_a")} />);
    fireEvent.change(box(), { target: { value: "make the header sticky" } });
    fireEvent.paste(box(), {
      clipboardData: { files: [new File([PNG], "header.png", { type: "image/png" })], types: ["Files"] },
    });
    expect(await screen.findByRole("button", { name: "Remove header.png" })).toBeTruthy();
    // Another tab: the chat screen goes away.
    first.unmount();
    ui(<Composer task={task("tsk_a")} />);
    expect(box().value).toBe("make the header sticky");
    expect(screen.getByRole("button", { name: "Remove header.png" })).toBeTruthy();
  });

  it("a new task's text stays with the new task, and the old task keeps its own", () => {
    const view = ui(<Composer task={task("tsk_a")} />);
    fireEvent.change(box(), { target: { value: "follow-up for A" } });
    // New task.
    view.show(<Composer task={undefined} />);
    expect(box().value).toBe("");
    fireEvent.change(box(), { target: { value: "build a register page" } });
    // Back to the old task.
    view.show(<Composer task={task("tsk_a")} />);
    expect(box().value).toBe("follow-up for A");
    // And to the new task again.
    view.show(<Composer task={undefined} />);
    expect(box().value).toBe("build a register page");
  });

  it("sending clears only the draft that was sent; typed text survives a restart", async () => {
    const view = ui(<Composer task={undefined} />);
    fireEvent.change(box(), { target: { value: "build a register page" } });
    expect(JSON.parse(localStorage.getItem("depo.composer.drafts") ?? "{}")).toEqual({
      [draftKey("prj_1", null)]: { text: "build a register page", mode: "single" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "tasks.send")).toBe(true));
    await waitFor(() => expect(useDrafts.getState().drafts[draftKey("prj_1", null)]).toBeUndefined());
    view.show(<Composer task={undefined} />);
    expect(box().value).toBe("");
    expect(localStorage.getItem("depo.composer.drafts")).toBe("{}");
  });
});

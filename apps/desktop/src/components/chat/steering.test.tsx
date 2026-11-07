import type { ChatItem, PendingApprovalDto, Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    return Promise.resolve(f(params));
  },
}));

import { groupTurns } from "@/components/panels/ChatPanel";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { noteStatus, readersText, SteerNote } from "./SteerNote";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = "2026-11-07T10:00:00.000Z";
const task = (status: Task["status"], mode: Task["mode"] = "single"): Task => ({
  id: "tsk_1",
  projectId: "prj_1",
  title: "Add a health endpoint",
  prompt: "Add a health endpoint",
  status,
  mode,
  model: null,
  summary: null,
  error: null,
  createdAt: now,
  updatedAt: now,
});
const item = (id: string, role: ChatItem["role"], text: string, steer?: ChatItem["steer"]): ChatItem => ({
  id,
  role,
  text,
  toolName: role === "tool" ? "read_file" : null,
  isError: false,
  agent: null,
  createdAt: now,
  ...(steer ? { steer } : {}),
});
const steer = (state: NonNullable<ChatItem["steer"]>["state"], readBy: string[] = []) => ({
  state,
  readBy,
  queuedAt: now,
  deliveredAt: state === "delivered" ? now : null,
});

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: "tsk_1" });
});
afterEach(cleanup);

describe("composer while the task works", () => {
  it("stays usable: Enter sends a note to the running task instead of a new turn", async () => {
    responses["tasks.steer"] = (p) => ({
      delivery: "queued",
      taskId: (p as { taskId: string }).taskId,
      noteId: "msg_9",
    });
    wrap(<Composer task={task("running")} />);
    const box = screen.getByLabelText("Message the coding agent") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toBe("Add a note for the agent…");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const sendNote = screen.getByRole("button", { name: "Send note" }) as HTMLButtonElement;
    expect(sendNote.disabled).toBe(true);
    expect(screen.getByText(/reads it at its next step/)).toBeTruthy();

    fireEvent.change(box, { target: { value: "  Use port 8080  " } });
    expect(sendNote.disabled).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(calls.find((c) => c.method === "tasks.steer")?.params).toEqual({
        taskId: "tsk_1",
        text: "Use port 8080",
      }),
    );
    expect(calls.some((c) => c.method === "tasks.send")).toBe(false);
    await waitFor(() => expect(box.value).toBe(""));
    expect(screen.getAllByText("Note sent. It will be read at the next step.").length).toBeGreaterThan(0);
  });

  it("a team task says the Manager and the agents read it; Shift+Enter is a new line", () => {
    wrap(<Composer task={task("waiting", "backend")} />);
    const box = screen.getByLabelText("Message the coding agent") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Add a note for the team…");
    expect(screen.getByText(/the Manager and the agents at work read it/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls).toHaveLength(0);
  });

  it("a very long note is held back with a plain reason", () => {
    wrap(<Composer task={task("running")} />);
    const box = screen.getByLabelText("Message the coding agent");
    fireEvent.change(box, { target: { value: "x".repeat(4001) } });
    expect((screen.getByRole("button", { name: "Send note" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Notes can be up to 4,000 characters/)).toBeTruthy();
  });

  it("when the task is not working, Send is a normal follow-up", async () => {
    responses["tasks.send"] = () => task("queued");
    wrap(<Composer task={task("review")} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const box = screen.getByLabelText("Message the coding agent") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Ask for a follow-up change…");
    fireEvent.change(box, { target: { value: "Now add tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "tasks.send")?.params).toEqual({
        projectId: "prj_1",
        text: "Now add tests",
        taskId: "tsk_1",
      }),
    );
  });
});

describe("notes in the transcript", () => {
  it("stay in the turn they were sent in; a note that became the next message starts a turn", () => {
    const turns = groupTurns([
      item("u1", "user", "Build it"),
      item("t1", "tool", "read"),
      item("n1", "user", "Use tabs", steer("delivered", ["coder@1.0.0"])),
      item("a1", "assistant", "Done with tabs."),
      item("n2", "user", "And a README", steer("followup")),
      item("a2", "assistant", "README added."),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.notes?.map((n) => n.id)).toEqual(["n1"]);
    expect(turns[0]?.answer?.id).toBe("a1");
    expect(turns[1]?.user?.id).toBe("n2");
  });

  it("show queued, read (and by whom) and not read", () => {
    expect(noteStatus(item("n", "user", "x", steer("queued")))).toBe("Will be read at the next step");
    expect(noteStatus(item("n", "user", "x", steer("delivered", ["coder@1.0.0"])))).toBe(
      "Read by the coding agent",
    );
    expect(readersText(["manager@1.0.0", "backend@1.0.0"])).toBe("Manager and Backend");
    expect(readersText(["manager@1.0.0", "backend@1.0.0", "testing@1.0.0", "security@1.0.0"])).toBe(
      "Manager, Backend and 2 more",
    );
    expect(noteStatus(item("n", "user", "x", steer("dropped")))).toBe("Not read: the task stopped first");
    render(<SteerNote item={item("n", "user", "Use port 8080", steer("queued"))} />);
    const note = screen.getByTestId("steer-note");
    expect(note.dataset.state).toBe("queued");
    expect(note.textContent).toContain("Use port 8080");
    expect(note.textContent).toContain("Will be read at the next step");
  });
});

describe("approval card", () => {
  const approval = (details: PendingApprovalDto["details"]): PendingApprovalDto => ({
    id: "req_1",
    createdAt: now,
    projectId: "prj_1",
    taskId: "tsk_1",
    agent: "coder@1.0.0",
    kind: "command",
    title: 'Run "pip install httpx"?',
    reason: "installs a package",
    details,
  });

  it("declines in one click without a reason", async () => {
    responses["approvals.respond"] = () => ({ ok: true });
    wrap(<ApprovalCard approval={approval({ command: "pip install httpx" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "approvals.respond")?.params).toEqual({
        id: "req_1",
        approve: false,
      }),
    );
  });

  it("Tell Depo why opens a reason inline: Escape closes it, Enter declines with it", async () => {
    responses["approvals.respond"] = () => ({ ok: true });
    wrap(<ApprovalCard approval={approval({ command: "pip install httpx" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tell Depo why" }));
    let input = screen.getByLabelText(/Why not\? The agent reads it at its next step/) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText(/Why not\?/)).toBeNull();
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Tell Depo why" }));
    input = screen.getByLabelText(/Why not\?/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Use the standard library  " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "approvals.respond")?.params).toEqual({
        id: "req_1",
        approve: false,
        reason: "Use the standard library",
      }),
    );
  });

  it("a plan asks what should change, and Allow still takes one click", async () => {
    responses["approvals.respond"] = () => ({ ok: true });
    wrap(
      <ApprovalCard
        approval={{
          ...approval({ plan: "Backend: Tasks API" }),
          kind: "other",
          title: "Start this plan (2 tasks)?",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell Depo why" }));
    expect(
      screen.getByLabelText(/What should change\? The Manager plans again with your note\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "approvals.respond")?.params).toEqual({
        id: "req_1",
        approve: true,
      }),
    );
  });
});

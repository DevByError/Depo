import type { DepoEvent } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TimelineResult } from "@/lib/team-view";
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

import { AgentBoard } from "./AgentBoard";
import { TeamPanel } from "./TeamPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const node = (id: string, owner: string, status: string, deps: string[] = [], extra = {}) => ({
  id,
  title: `${id[0]?.toUpperCase()}${id.slice(1)} work`,
  owner,
  deps,
  criteria: [],
  review: true,
  status,
  attempts: 1,
  ...extra,
});

const timeline = (): TimelineResult =>
  ({
    taskId: "tsk_1",
    mode: "backend",
    status: "running",
    plan: {
      mode: "backend",
      summary: "Data first, then the API.",
      version: 1,
      approved: true,
      questions: [],
      nodes: [
        node("database", "database", "done", [], { reviewer: "reasoning" }),
        node("backend", "backend", "doing", ["database"], { attempts: 2, reviewer: "security" }),
        node("testing", "testing", "todo", ["backend"]),
      ],
    },
    agents: [
      {
        id: "manager",
        name: "Manager",
        version: "1.0.0",
        state: "working",
        nodeId: null,
        action: "Manager → Backend: Backend work",
        actionAt: "2026-11-07T10:00:00.000Z",
        done: 0,
        total: 0,
        reviews: 0,
        workMs: 65_000,
        lastDecision: null,
      },
      {
        id: "backend",
        name: "Backend",
        version: "1.0.0",
        state: "working",
        nodeId: "backend",
        action: "Reading src/app.ts",
        actionAt: "2026-11-07T10:00:00.000Z",
        done: 0,
        total: 1,
        reviews: 0,
        workMs: 30_000,
        lastDecision: null,
      },
      {
        id: "security",
        name: "Security",
        version: "1.0.0",
        state: "idle",
        nodeId: null,
        action: null,
        actionAt: null,
        done: 0,
        total: 0,
        reviews: 1,
        workMs: 4_000,
        lastDecision: null,
      },
    ],
    decisions: [
      {
        id: "evt_0000000000000000000000000001",
        ts: "2026-11-07T10:00:00.000Z",
        agent: "manager",
        tag: "manager@1.0.0",
        kind: "plan",
        text: "Manager planned 3 tasks for Database, Backend and Testing",
        outcome: "custom",
        reason: "Data first, then the API.",
        nodeId: null,
        items: ["Database: Database work"],
      },
      {
        id: "evt_0000000000000000000000000002",
        ts: "2026-11-07T10:00:05.000Z",
        agent: "security",
        tag: "security@1.0.0",
        kind: "review",
        text: "Security asked for changes to Backend work (1 blocking, 0 should fix)",
        outcome: "changes",
        reason: "Blocking: src/app.ts:1 Passwords are stored in plain text",
        nodeId: "backend",
        items: ["Blocking: src/app.ts:1 Passwords are stored in plain text"],
      },
    ],
  }) as TimelineResult;

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open", events: [] });
  useUi.setState({ projectId: "prj_1", taskId: "tsk_1", centerTab: "team" });
  responses["tasks.list"] = () => ({ tasks: [{ id: "tsk_1", title: "Task lists with login" }] });
  responses["team.timeline"] = () => timeline();
});
afterEach(cleanup);

test("without a task the Team screen explains how to start a team run", async () => {
  useUi.setState({ taskId: null });
  wrap(<TeamPanel />);
  expect(screen.getByText("Watch the team work")).toBeTruthy();
  expect(screen.getByText(/pick a work mode other than Single agent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Open Chat/ }));
  expect(useUi.getState().centerTab).toBe("chat");
});

test("a single-agent task says the team view is for team runs", async () => {
  responses["team.timeline"] = () => ({
    ...timeline(),
    mode: "single",
    plan: null,
    agents: [],
    decisions: [],
  });
  wrap(<TeamPanel />);
  expect(await screen.findByText("This task uses a single agent")).toBeTruthy();
});

test("mission control shows the graph, live agents and decisions, and filters by agent", async () => {
  wrap(<TeamPanel />);
  expect(await screen.findByText("Task lists with login")).toBeTruthy();
  expect(screen.getByTestId("team-status").textContent).toContain("Working");

  // The graph: one card per task with its status and review state.
  const tasks = screen.getByRole("list", { name: "Tasks in plan order" });
  expect(within(tasks).getAllByRole("listitem")).toHaveLength(3);
  const be = tasks.querySelector('[data-node="backend"]') as HTMLElement;
  expect(be.dataset.status).toBe("doing");
  expect(within(be).getByText("In progress")).toBeTruthy();
  expect(within(be).getByText(/try 2/)).toBeTruthy();
  expect(within(be).getByText(/Changes asked by Security/)).toBeTruthy();

  // Agent cards with live state and current action.
  const card = document.querySelector('[data-agent="backend"]') as HTMLElement;
  expect(within(card).getByTestId("agent-action").textContent).toBe("Reading src/app.ts");
  expect(within(card).getByText("Working")).toBeTruthy();

  // A live event updates the card at once, and a live decision joins the timeline.
  const live = (over: Partial<DepoEvent>): DepoEvent => ({
    id: "evt_0000000000000000000000000009",
    ts: "2026-11-07T10:00:09.000Z",
    seq: 9,
    projectId: "prj_1",
    taskId: "tsk_1",
    agent: "backend@1.0.0",
    type: "running_command",
    text: "Running bun test",
    details: null,
    durationMs: null,
    status: "running",
    ephemeral: false,
    ...over,
  });
  act(() => {
    useEngine.getState().receive(live({}));
    useEngine.getState().receive(
      live({
        id: "evt_0000000000000000000000000010",
        ts: "2026-11-07T10:00:10.000Z",
        type: "decision",
        text: "Backend: Hashed the passwords.",
        details: { kind: "result", nodeId: "backend", outcome: "submitted" },
      }),
    );
  });
  expect(within(card).getByTestId("agent-action").textContent).toBe("Running bun test");
  expect(within(card).getByText("Backend: Hashed the passwords.")).toBeTruthy();
  const log = screen.getByRole("region", { name: /Decisions, oldest first/ });
  expect(log.querySelectorAll("[data-kind]")).toHaveLength(3);

  // Why: the reason opens on demand.
  const review = log.querySelector('[data-kind="review"]') as HTMLElement;
  fireEvent.click(within(review).getByRole("button", { name: "Why" }));
  expect(within(review).getByText(/Passwords are stored in plain text/)).toBeTruthy();

  // Selecting a card shows only that agent's decisions; selecting it again shows all.
  const sec = document.querySelector('[data-agent="security"]') as HTMLElement;
  fireEvent.click(sec);
  expect(sec.getAttribute("aria-pressed")).toBe("true");
  const filtered = screen.getByRole("region", { name: /Decisions by Security/ });
  expect(filtered.querySelectorAll("[data-kind]")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Only Security/ }));
  expect(screen.getByRole("region", { name: /Decisions, oldest first/ })).toBeTruthy();

  // A refetch follows decisions and handoffs.
  await waitFor(() => expect(calls.filter((c) => c.method === "team.timeline").length).toBeGreaterThan(1));
});

test("the Agent board shows each agent's action and last decision for a team task", async () => {
  wrap(<AgentBoard />);
  const list = await screen.findByRole("list", { name: "Agents in this task" });
  expect(within(list).getByText("Reading src/app.ts")).toBeTruthy();
  expect(within(list).getByText(/Security asked for changes/)).toBeTruthy();
  expect(screen.getByRole("list", { name: "Agents not in this task" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Open Team view/ }));
  expect(useUi.getState().centerTab).toBe("team");
});

import type { TeamEta, TeamEvent } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EtaHint } from "@/components/team/EtaHint";
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

import { PlanBoard } from "./PlanBoard";
import { TeamPanel } from "./TeamPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const MIN = 60_000;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
let seq = 0;
const ev = (
  at: number,
  agent: string,
  type: string,
  status: string,
  details: TeamEvent["details"],
  text: string,
) => {
  seq++;
  return {
    id: `evt_${seq.toString(16).padStart(28, "0")}`,
    ts: new Date(T0 + at).toISOString(),
    agent,
    type,
    text,
    status,
    details,
  } satisfies TeamEvent;
};

/** Database done, Backend sent back once and approved, Testing done: 12 minutes in all. */
function events(): TeamEvent[] {
  seq = 0;
  return [
    ev(0, "manager@1.0.0", "planning", "started", null, "Manager is planning the work"),
    ev(
      20_000,
      "manager@1.0.0",
      "decision",
      "succeeded",
      { kind: "plan", outcome: "custom" },
      "Manager planned 3 tasks",
    ),
    ev(
      21_000,
      "manager@1.0.0",
      "handoff",
      "started",
      { nodeId: "database", to: "database" },
      "Manager → Database",
    ),
    ev(60_000, "database@1.0.0", "writing_file", "succeeded", null, "Writing db/schema.sql"),
    ev(
      2 * MIN,
      "database@1.0.0",
      "handoff",
      "succeeded",
      { nodeId: "database", status: "done" },
      "Database finished",
    ),
    ev(
      2 * MIN + 1000,
      "manager@1.0.0",
      "handoff",
      "started",
      { nodeId: "backend", to: "backend" },
      "Manager → Backend",
    ),
    ev(4 * MIN, "backend@1.0.0", "editing_file", "succeeded", null, "Editing src/app.ts"),
    ev(5 * MIN, "security@1.0.0", "reviewing", "started", { nodeId: "backend" }, "Security is reviewing"),
    ev(
      6 * MIN,
      "security@1.0.0",
      "reviewing",
      "failed",
      { nodeId: "backend", verdict: "changes" },
      "changes needed",
    ),
    ev(
      6 * MIN + 100,
      "security@1.0.0",
      "decision",
      "failed",
      { kind: "review", outcome: "changes", nodeId: "backend" },
      "Security asked for changes to Tasks API",
    ),
    ev(
      6 * MIN + 200,
      "manager@1.0.0",
      "decision",
      "running",
      { kind: "send_back", nodeId: "backend", attempt: 2 },
      "Manager sent Tasks API back to Backend",
    ),
    ev(
      8 * MIN,
      "security@1.0.0",
      "reviewing",
      "started",
      { nodeId: "backend" },
      "Security is reviewing again",
    ),
    ev(
      9 * MIN,
      "security@1.0.0",
      "decision",
      "succeeded",
      { kind: "review", outcome: "approved", nodeId: "backend" },
      "Security approved Tasks API",
    ),
    ev(
      9 * MIN + 100,
      "backend@1.0.0",
      "handoff",
      "succeeded",
      { nodeId: "backend", status: "done" },
      "Backend finished",
    ),
    ev(
      9 * MIN + 200,
      "manager@1.0.0",
      "handoff",
      "started",
      { nodeId: "testing", to: "testing" },
      "Manager → Testing",
    ),
    ev(
      11 * MIN,
      "testing@1.0.0",
      "handoff",
      "succeeded",
      { nodeId: "testing", status: "done" },
      "Testing finished",
    ),
    ev(
      12 * MIN,
      "manager@1.0.0",
      "decision",
      "succeeded",
      { kind: "release", outcome: "ready" },
      "Manager: ready for your review",
    ),
  ];
}

const node = (id: string, owner: string, status: string, deps: string[], extra = {}) => ({
  id,
  title: { database: "Tasks table", backend: "Tasks API", testing: "Run the suite" }[id] ?? id,
  owner,
  deps,
  criteria: [],
  review: id === "backend",
  status,
  attempts: 1,
  ...extra,
});

const agent = (id: string, name: string) => ({
  id,
  name,
  version: "1.0.0",
  state: "idle",
  nodeId: null,
  action: null,
  actionAt: null,
  done: 0,
  total: 0,
  reviews: 0,
  workMs: 0,
  lastDecision: null,
});

const timeline = (over: Partial<TimelineResult> = {}): TimelineResult =>
  ({
    taskId: "tsk_1",
    mode: "backend",
    status: "review",
    plan: {
      mode: "backend",
      summary: "Data first, then the API.",
      version: 1,
      approved: true,
      questions: [],
      nodes: [
        node("database", "database", "done", []),
        node("backend", "backend", "done", ["database"], { attempts: 2, reviewer: "security" }),
        node("testing", "testing", "done", ["backend"]),
      ],
    },
    agents: [
      agent("manager", "Manager"),
      agent("database", "Database"),
      agent("backend", "Backend"),
      agent("testing", "Testing"),
      agent("security", "Security"),
    ],
    decisions: [],
    ...over,
  }) as TimelineResult;

const eta = (over: Partial<TeamEta> = {}): TeamEta => ({
  taskId: "tsk_1",
  mode: "backend",
  parallel: 2,
  basis: "learned",
  nodes: [
    { id: "database", low: 2 * MIN, mid: 3 * MIN, high: 4 * MIN, basis: "learned" },
    { id: "backend", low: 8 * MIN, mid: 10 * MIN, high: 14 * MIN, basis: "learned" },
    { id: "testing", low: 2 * MIN, mid: 3 * MIN, high: 4 * MIN, basis: "learned" },
  ],
  plan: { low: 12 * MIN, mid: 16 * MIN, high: 22 * MIN },
  single: null,
  samples: 9,
  speed: { model: "qwen", tokensPerSec: 9, ttftMs: 2000, measured: true },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open", events: [] });
  useUi.setState({ projectId: "prj_1", taskId: "tsk_1", centerTab: "team", teamMoment: null });
  try {
    localStorage.clear();
  } catch {
    // jsdom storage is always there; the guard mirrors the app.
  }
  responses["tasks.list"] = () => ({ tasks: [{ id: "tsk_1", title: "Tasks API with login" }] });
  responses["team.timeline"] = () => timeline();
  responses["team.events"] = () => ({ events: events(), next: null });
  responses["team.eta"] = () => eta();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slider = () => screen.findByRole("slider", { name: "Replay position" });
const statusOf = (id: string) =>
  (document.querySelector(`[aria-label="Tasks in plan order"] [data-node="${id}"]`) as HTMLElement | null)
    ?.dataset.status;
const decisionsShown = () => document.querySelectorAll('[aria-label^="Decisions"] [data-kind]').length;

describe("replay", () => {
  test("a finished run opens at the end; keys step, jump and rebuild the graph, the agents and the decisions", async () => {
    wrap(<TeamPanel />);
    const s = await slider();
    expect(s.getAttribute("aria-valuemax")).toBe("720");
    expect(s.getAttribute("aria-valuenow")).toBe("720");
    expect(s.getAttribute("aria-valuetext")).toMatch(/12 min 0 s into the run, at .+, the end/);
    expect(screen.getByRole("button", { name: "End" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("replay-badge")).toBeNull();
    expect(statusOf("backend")).toBe("done");
    expect(decisionsShown()).toBe(5);

    // Home: the start of the run. Nothing has happened yet.
    fireEvent.keyDown(s, { key: "Home" });
    expect(screen.getByTestId("replay-badge").textContent).toMatch(/Replay at/);
    expect(screen.getByRole("button", { name: "End" }).getAttribute("aria-pressed")).toBe("false");
    expect(["database", "backend", "testing"].map(statusOf)).toEqual(["todo", "todo", "todo"]);
    expect(screen.getByText("No decisions yet at this point of the run.")).toBeTruthy();
    expect(screen.getByText("5 more decisions later in the run")).toBeTruthy();

    // Page Down jumps to the next key moment (the plan); arrows go one event at a time.
    fireEvent.keyDown(s, { key: "PageDown" });
    expect(decisionsShown()).toBe(1);
    expect(s.getAttribute("aria-valuenow")).toBe("20");
    fireEvent.keyDown(s, { key: "ArrowRight" });
    expect(statusOf("database")).toBe("doing");
    const db = document.querySelector('[data-agent="database"]') as HTMLElement;
    expect(within(db).getByText("Working")).toBeTruthy();

    // Shift+Right: on to the change request; the Backend is in review, then sent back on try 2.
    fireEvent.keyDown(s, { key: "ArrowRight", shiftKey: true });
    expect(statusOf("backend")).toBe("review");
    expect(decisionsShown()).toBe(2);
    const sec = document.querySelector('[data-agent="security"]') as HTMLElement;
    expect(within(sec).getByText("Security asked for changes to Tasks API")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next key moment" }));
    expect(statusOf("backend")).toBe("doing");
    expect(
      within(document.querySelector('[data-node="backend"]') as HTMLElement).getByText(/try 2/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Step back" }));
    expect(statusOf("backend")).toBe("review");

    // End: back to how the run ended.
    fireEvent.keyDown(s, { key: "End" });
    expect(screen.queryByTestId("replay-badge")).toBeNull();
    expect(decisionsShown()).toBe(5);
  });

  test("Space plays and pauses at the chosen speed; playing to the end stops there", async () => {
    wrap(<TeamPanel />);
    const s = await slider();
    fireEvent.click(screen.getByRole("button", { name: "16 times speed" }));
    expect(screen.getByRole("button", { name: "16 times speed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "4 times speed" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(s, { key: "Home" });
    fireEvent.keyDown(s, { key: " " });
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    await waitFor(() => expect(Number(s.getAttribute("aria-valuenow"))).toBeGreaterThan(2));
    fireEvent.keyDown(s, { key: " " });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    const paused = s.getAttribute("aria-valuenow");
    await new Promise((r) => setTimeout(r, 250));
    expect(s.getAttribute("aria-valuenow")).toBe(paused);

    // Playing near the end runs into it and stops at the end.
    fireEvent.keyDown(s, { key: "PageUp" }); // the last key moment before here
    fireEvent.keyDown(s, { key: "End" });
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeTruthy(), { timeout: 3000 });
    expect(s.getAttribute("aria-valuenow")).toBe("720");
  });

  test("a moment can be copied as a link, and a pasted link opens the replay there", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    wrap(<TeamPanel />);
    const s = await slider();
    fireEvent.keyDown(s, { key: "Home" });
    fireEvent.keyDown(s, { key: "PageDown" }); // 20 s in
    fireEvent.click(screen.getByRole("button", { name: "Share moment" }));
    const link = screen.getByLabelText(/Link to this moment/) as HTMLInputElement;
    expect(link.value).toBe("depo://team/tsk_1?project=prj_1&at=20000");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("depo://team/tsk_1?project=prj_1&at=20000"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();

    const paste = screen.getByLabelText("Open a moment someone shared");
    fireEvent.change(paste, { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText(/That is not a Depo moment link/)).toBeTruthy();
    fireEvent.change(paste, { target: { value: "depo://team/tsk_1?project=prj_1&at=360000" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(s.getAttribute("aria-valuenow")).toBe("360"));
    expect(useUi.getState().teamMoment).toBeNull();
    expect(statusOf("backend")).toBe("review");
  });

  test("without stored events (an older engine) the view stays live and has no replay strip", async () => {
    responses["team.events"] = () => {
      throw new Error("Method not found");
    };
    wrap(<TeamPanel />);
    expect(await screen.findByText("Tasks API with login")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === "team.events")).toBe(true));
    expect(screen.queryByRole("slider", { name: "Replay position" })).toBeNull();
    expect(statusOf("backend")).toBe("done");
  });
});

describe("time left on this PC", () => {
  const running = () => {
    const nodes = timeline().plan?.nodes ?? [];
    const now = Date.now();
    responses["team.timeline"] = () =>
      timeline({
        status: "running",
        plan: {
          ...(timeline().plan as NonNullable<TimelineResult["plan"]>),
          nodes: [
            { ...(nodes[0] as (typeof nodes)[number]), status: "done" },
            {
              ...(nodes[1] as (typeof nodes)[number]),
              status: "doing",
              attempts: 1,
              startedAt: new Date(now - 90_000).toISOString(),
            },
            { ...(nodes[2] as (typeof nodes)[number]), status: "todo" },
          ],
        },
      });
    seq = 0;
    responses["team.events"] = () => ({
      events: [
        {
          ...ev(0, "manager@1.0.0", "planning", "started", null, "Manager is planning the work"),
          ts: new Date(now - 5 * MIN).toISOString(),
        },
        {
          ...ev(
            0,
            "manager@1.0.0",
            "handoff",
            "started",
            { nodeId: "database", to: "database" },
            "Manager → Database",
          ),
          ts: new Date(now - 4 * MIN).toISOString(),
        },
        {
          ...ev(
            0,
            "database@1.0.0",
            "handoff",
            "succeeded",
            { nodeId: "database", status: "done" },
            "Database finished",
          ),
          ts: new Date(now - 90_000 - 1000).toISOString(),
        },
        {
          ...ev(
            0,
            "manager@1.0.0",
            "handoff",
            "started",
            { nodeId: "backend", to: "backend" },
            "Manager → Backend",
          ),
          ts: new Date(now - 90_000).toISOString(),
        },
      ],
      next: null,
    });
  };

  test("a running task shows time left in the header and on each task, live", async () => {
    running();
    wrap(<TeamPanel />);
    const stat = await screen.findByTestId("team-eta");
    // Backend has 6.5 to 12.5 min left of 8 to 14, then Testing takes 2 to 4: 8.5 to 16.5 min.
    expect(stat.textContent).toBe("Time left8 to 20 min on this PC");
    expect(stat.getAttribute("title")).toBe("Learned from 9 finished steps on this PC.");
    expect(screen.getByRole("button", { name: "Live" }).getAttribute("aria-pressed")).toBe("true");
    const cards = screen.getAllByTestId("node-eta").map((x) => x.textContent);
    expect(cards).toEqual(["6 to 13 min left", "2 to 4 min"]);
  });

  test("with no history the estimate says it is a first guess", async () => {
    running();
    responses["team.eta"] = () =>
      eta({ basis: "guess", nodes: eta().nodes.map((x) => ({ ...x, basis: "guess" as const })), samples: 0 });
    wrap(<TeamPanel />);
    const stat = await screen.findByTestId("team-eta");
    expect(stat.textContent).toContain("first guess");
    expect(stat.getAttribute("title")).toMatch(/^A first guess from the model's speed/);
  });

  test("Board mode shows the same tasks by status, with time left", async () => {
    running();
    wrap(<TeamPanel />);
    await screen.findByTestId("team-eta");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    const doing = screen.getByRole("region", { name: "In progress" });
    expect(within(doing).getByText("Tasks API")).toBeTruthy();
    expect(within(doing).getByText("6 to 13 min left")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done" })).getByText("Tasks table")).toBeTruthy();
    expect(localStorage.getItem("depo.team.planMode")).toBe("board");
  });

  test("the Plan tab is the live board, with time left and a way to the Team view", async () => {
    running();
    wrap(<PlanBoard />);
    expect(await screen.findByTestId("plan-progress")).toBeTruthy();
    expect(screen.getByTestId("plan-progress").textContent).toBe("1 of 3 tasks done");
    expect((await screen.findByTestId("plan-eta")).textContent).toContain("8 to 20 min left on this PC");
    expect(within(screen.getByRole("region", { name: "To do" })).getByText("Run the suite")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open Team view/ }));
    expect(useUi.getState().centerTab).toBe("team");
  });

  test("the Plan tab without a task says there is no plan yet", () => {
    useUi.setState({ taskId: null });
    wrap(<PlanBoard />);
    expect(screen.getByText("No plan yet")).toBeTruthy();
  });

  test("the chat's hint shows time so far and time left for a single-agent task", async () => {
    responses["team.eta"] = () =>
      eta({
        mode: "single",
        nodes: [],
        plan: null,
        single: { low: 4 * MIN, mid: 6 * MIN, high: 9 * MIN, basis: "learned" },
      });
    wrap(<EtaHint taskId="tsk_1" startedAt={new Date(Date.now() - 90_000).toISOString()} />);
    await waitFor(() =>
      expect(screen.getByTestId("eta-hint").textContent).toMatch(/^1m 3\ds so far, about 2 to 8 min left$/),
    );
  });
});

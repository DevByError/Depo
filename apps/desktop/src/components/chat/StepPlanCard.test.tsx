import type { ChatItem, StepPlan } from "@depo/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { groupTurns, planForTurn } from "@/components/panels/ChatPanel";
import { StepPlanCard, stepNote } from "./StepPlanCard";

// The owner's ask: Depo shows every step before it starts, like Claude's checklist, and adds
// steps when it finds more work (ADR-0086).

const step = (
  id: string,
  title: string,
  status: StepPlan["steps"][number]["status"],
  over: Partial<StepPlan["steps"][number]> = {},
): StepPlan["steps"][number] => ({
  id,
  title,
  kind: "build",
  status,
  note: null,
  tries: status === "pending" ? 0 : 1,
  model: status === "pending" ? null : "qwen2.5-coder:3b",
  added: false,
  ...over,
});

const PLAN: StepPlan = {
  messageId: "msg_1",
  createdAt: "2026-11-08T10:00:00Z",
  updatedAt: "2026-11-08T10:05:00Z",
  steps: [
    step("s1", "Add the skills table", "done"),
    step("s2", "Add the scans table", "blocked", { note: "There is no CREATE TABLE for scans yet." }),
    step("s3", "Build GET /api/skill", "running", {
      tries: 2,
      model: "qwen2.5-coder:7b",
      note: "Try 2: a clean restart",
    }),
    step("f4", "Fix: migrate failed", "pending", { added: true, kind: "fix" }),
    step("s5", "Run the app and check it", "pending", { kind: "check" }),
  ],
};

describe("StepPlanCard", () => {
  afterEach(cleanup);

  it("lists every step with its state, the progress, and the steps Depo added", () => {
    render(<StepPlanCard plan={PLAN} active />);
    const card = screen.getByRole("region", { name: "Depo's plan" });
    expect(within(card).getByText("1 of 5 done")).toBeTruthy();
    expect(within(card).getByRole("progressbar", { name: "Steps done" }).getAttribute("aria-valuenow")).toBe(
      "1",
    );
    const rows = within(card).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual([
      "done",
      "blocked",
      "running",
      "pending",
      "pending",
    ]);
    // Screen readers hear the state before each step.
    expect(rows[0]?.textContent).toContain("Done: Add the skills table");
    expect(rows[1]?.textContent).toContain("Not done yet: Add the scans table");
    expect(rows[1]?.textContent).toContain("There is no CREATE TABLE for scans yet.");
    expect(rows[2]?.textContent).toContain("Working on: Build GET /api/skill");
    expect(rows[2]?.textContent).toContain("try 2 · qwen2.5-coder:7b · Try 2: a clean restart");
    expect(within(rows[3] as HTMLElement).getByText("added")).toBeTruthy();
  });

  it("once the run is over, a step left running shows only its note", () => {
    const s = PLAN.steps[2];
    if (!s) throw new Error("no step");
    expect(stepNote(s, false)).toBe("Try 2: a clean restart");
    expect(stepNote({ ...s, note: null }, true)).toBe("try 2 · qwen2.5-coder:7b");
  });
});

describe("the plan belongs to its turn", () => {
  const item = (id: string, role: ChatItem["role"], text: string, agent: string | null = null): ChatItem => ({
    id,
    role,
    text,
    toolName: null,
    isError: false,
    agent,
    createdAt: "2026-11-08T10:00:00Z",
  });

  it("each turn shows the plan made for its message; Depo's checks stay inside the turn", () => {
    const items = [
      item("msg_1", "user", "Build Skill Finder"),
      item("a1", "assistant", "Adding the scans table."),
      item(
        "d1",
        "assistant",
        'Depo checked "Add the scans table" and it is not done yet:\n- …',
        "tester@depo",
      ),
      item("a2", "assistant", "Done: all 5 steps of the plan passed Depo's checks."),
      item("msg_2", "user", "go on"),
      item("a3", "assistant", "Done."),
    ];
    const turns = groupTurns(items);
    expect(turns).toHaveLength(2);
    const second: StepPlan = { ...PLAN, messageId: "msg_2", createdAt: "2026-11-08T11:00:00Z" };
    expect(planForTurn([PLAN, second], turns[0] as never, 0)?.messageId).toBe("msg_1");
    expect(planForTurn([PLAN, second], turns[1] as never, 1)?.messageId).toBe("msg_2");
    expect(planForTurn([PLAN], turns[1] as never, 1)).toBeNull();
  });
});

import type { DepoEvent } from "@depo/shared";
import { describe, expect, it } from "vitest";
import { agentLabel, eventCategories, filterByCategories, groupByTask, isProblem } from "./ActivityFeed";

let n = 0;
const ev = (type: DepoEvent["type"], extra: Partial<DepoEvent> = {}): DepoEvent =>
  ({
    id: `e${++n}`,
    seq: n,
    ts: "2026-11-07T10:00:00.000Z",
    projectId: "prj_a",
    taskId: null,
    agent: "engine",
    type,
    text: type,
    details: null,
    status: "info",
    durationMs: null,
    ephemeral: false,
    ...extra,
  }) as DepoEvent;

describe("activity categories", () => {
  const read = ev("reading_file");
  const cmd = ev("running_command", { status: "failed" });
  const test = ev("test_result", { status: "succeeded" });
  const plan = ev("planning");
  const err = ev("error", { status: "failed" });
  const warn = ev("warning");
  const engine = ev("engine_started");
  const all = [read, cmd, test, plan, err, warn, engine];

  it("puts each event type in its category", () => {
    expect(eventCategories(read)).toEqual(["files"]);
    expect(eventCategories(cmd)).toEqual(["commands"]);
    expect(eventCategories(test)).toEqual(["tests"]);
    expect(eventCategories(plan)).toEqual(["agents"]);
    expect(eventCategories(err)).toEqual(["errors"]);
    expect(eventCategories(engine)).toEqual([]);
  });

  it("no chip shows everything; chips combine with or", () => {
    expect(filterByCategories(all, [], false)).toHaveLength(all.length);
    expect(filterByCategories(all, ["files", "tests"], false)).toEqual([read, test]);
    expect(filterByCategories(all, ["errors"], false)).toEqual([err, warn]);
  });

  it("errors only keeps failures of any kind, and narrows the chips", () => {
    expect(isProblem(cmd)).toBe(true);
    expect(isProblem(test)).toBe(false);
    expect(filterByCategories(all, [], true)).toEqual([cmd, err, warn]);
    expect(filterByCategories(all, ["commands"], true)).toEqual([cmd]);
    expect(filterByCategories(all, ["files"], true)).toEqual([]);
  });
});

describe("task groups", () => {
  it("adds a header before each run of events from the same task", () => {
    const a1 = ev("planning", { taskId: "tsk_a" });
    const a2 = ev("reading_file", { taskId: "tsk_a" });
    const sys = ev("client_connected", { projectId: null });
    const a3 = ev("handoff", { taskId: "tsk_a" });
    const b1 = ev("planning", { taskId: "tsk_b", projectId: "prj_b" });
    const items = groupByTask([a1, a2, sys, a3, b1]);
    expect(items.map((i) => (i.kind === "group" ? `[${i.taskId}:${i.count}]` : i.event.id))).toEqual([
      "[tsk_a:2]",
      a1.id,
      a2.id,
      sys.id,
      "[tsk_a:1]",
      a3.id,
      "[tsk_b:1]",
      b1.id,
    ]);
    const header = items.find((i) => i.kind === "group" && i.taskId === "tsk_b");
    expect(header && header.kind === "group" && header.projectId).toBe("prj_b");
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    const plain = items.find((i) => i.kind === "event" && i.event.id === sys.id);
    expect(plain && plain.kind === "event" && plain.grouped).toBe(false);
  });

  it("labels agents", () => {
    expect(agentLabel("engine")).toBe("Engine");
    expect(agentLabel("user")).toBe("You");
    expect(agentLabel("backend@1.0.0")).toBe("Backend Agent (1.0.0)");
  });
});

import type { DepoEvent } from "@depo/shared";
import { describe, expect, it } from "vitest";
import { filterByScope } from "./ActivityFeed";

const ev = (id: string, projectId: string | null): DepoEvent =>
  ({
    id,
    seq: 1,
    ts: "2026-10-31T00:00:00.000Z",
    projectId,
    taskId: null,
    agent: "engine",
    type: "info",
    text: id,
    details: null,
    status: "info",
    durationMs: null,
    ephemeral: false,
  }) as DepoEvent;

describe("filterByScope", () => {
  const events = [ev("a1", "A"), ev("b1", "B"), ev("sys", null)];
  it("this project keeps its own and engine-wide events", () => {
    expect(filterByScope(events, "project", "A").map((e) => e.id)).toEqual(["a1", "sys"]);
    expect(filterByScope(events, "project", "B").map((e) => e.id)).toEqual(["b1", "sys"]);
  });
  it("all projects keeps everything", () => {
    expect(filterByScope(events, "all", "A")).toHaveLength(3);
    expect(filterByScope(events, "project", null)).toHaveLength(3);
  });
});

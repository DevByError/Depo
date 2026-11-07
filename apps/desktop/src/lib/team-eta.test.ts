import type { Plan, TeamEta } from "@depo/shared";
import { describe, expect, test } from "vitest";
import { etaAt, etaBasisText, etaHint, nodeEtaText, totalEtaText } from "./team-eta";
import { momentRef, parseMoment } from "./team-moment";

const MIN = 60_000;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

const plan = (over: Partial<Plan["nodes"][number]>[] = []): Plan => ({
  mode: "backend",
  summary: "",
  version: 1,
  approved: true,
  questions: [],
  nodes: [
    {
      id: "db",
      title: "Schema",
      owner: "database",
      deps: [],
      criteria: [],
      review: false,
      status: "done",
      attempts: 1,
    },
    {
      id: "api",
      title: "API",
      owner: "backend",
      deps: ["db"],
      criteria: [],
      review: true,
      status: "doing",
      attempts: 1,
      startedAt: new Date(T0).toISOString(),
    },
    {
      id: "ui",
      title: "UI",
      owner: "frontend",
      deps: ["db"],
      criteria: [],
      review: false,
      status: "todo",
      attempts: 0,
    },
    {
      id: "test",
      title: "Tests",
      owner: "testing",
      deps: ["api", "ui"],
      criteria: [],
      review: false,
      status: "todo",
      attempts: 0,
    },
  ].map((n, i) => ({ ...n, ...(over[i] ?? {}) })) as Plan["nodes"],
});

const eta = (basis: TeamEta["basis"] = "learned"): TeamEta => ({
  taskId: "tsk_1",
  mode: "backend",
  parallel: 2,
  basis,
  nodes: [
    { id: "db", low: 3 * MIN, mid: 4 * MIN, high: 6 * MIN, basis: "learned" },
    { id: "api", low: 8 * MIN, mid: 10 * MIN, high: 14 * MIN, basis: "learned" },
    { id: "ui", low: 6 * MIN, mid: 8 * MIN, high: 12 * MIN, basis: "learned" },
    {
      id: "test",
      low: 2 * MIN,
      mid: 3 * MIN,
      high: 5 * MIN,
      basis: basis === "learned" ? "learned" : "guess",
    },
  ],
  plan: { low: 13 * MIN, mid: 17 * MIN, high: 25 * MIN },
  single: null,
  samples: 12,
  speed: { model: "qwen", tokensPerSec: 9, ttftMs: 2000, measured: true },
});

describe("time left on this PC", () => {
  test("counts down while a task runs and covers what still waits, honouring team.parallel", () => {
    const at4 = etaAt({ plan: plan() }, eta(), T0 + 4 * MIN);
    // api has 6 min left, ui (8) runs beside it, then tests (3): 8 + 3 = 11 min in the likely case.
    expect(at4?.total.mid).toBe(11 * MIN);
    expect(at4?.nodes.get("api")).toMatchObject({ running: true, over: false });
    expect(at4?.nodes.get("api")?.left.mid).toBe(6 * MIN);
    expect(
      nodeEtaText(
        at4?.nodes.get("api") ?? {
          left: { low: 0, mid: 0, high: 0 },
          running: false,
          over: false,
          basis: "guess",
        },
      ),
    ).toBe("4 to 10 min left");
    expect(
      nodeEtaText(
        at4?.nodes.get("ui") ?? {
          left: { low: 0, mid: 0, high: 0 },
          running: false,
          over: false,
          basis: "guess",
        },
      ),
    ).toBe("6 to 12 min");
    expect(at4?.nodes.get("db")?.left.mid).toBe(0);
    expect(totalEtaText(at4?.total ?? { low: 0, mid: 0, high: 0 })).toBe("8 to 20 min");

    // Past its slow case, a task says it takes a little longer.
    const late = etaAt({ plan: plan() }, eta(), T0 + 20 * MIN);
    expect(late?.nodes.get("api")?.over).toBe(true);
    expect(
      nodeEtaText(
        late?.nodes.get("api") ?? {
          left: { low: 0, mid: 0, high: 0 },
          running: true,
          over: true,
          basis: "learned",
        },
      ),
    ).toBe("a little longer");

    expect(etaAt({ plan: null }, eta(), T0)).toBeNull();
    expect(etaAt({ plan: plan() }, null, T0)).toBeNull();
  });

  test("the tooltip says where the estimate comes from", () => {
    expect(etaBasisText("learned", 12)).toBe("Learned from 12 finished steps on this PC.");
    expect(etaBasisText("mixed", 1)).toMatch(
      /^Learned from 1 finished step on this PC\. Steps Depo has not seen/,
    );
    expect(etaBasisText("guess", 0)).toMatch(/^A first guess from the model's speed/);
  });

  test("the chat hint: elapsed, then time left, soon, or longer than usual", () => {
    const r = { low: 4 * MIN, mid: 6 * MIN, high: 9 * MIN };
    expect(etaHint(65_000, null)).toBe("1m 5s so far");
    expect(etaHint(2 * MIN, r)).toBe("2m 0s so far, about 2 to 7 min left");
    expect(etaHint(2 * MIN, { ...r, basis: "guess" })).toBe(
      "2m 0s so far, about 2 to 7 min left (first guess)",
    );
    expect(etaHint(5 * MIN, r)).toBe("5m 0s so far, should finish soon");
    expect(etaHint(10 * MIN, r)).toBe("10m 0s so far, taking longer than usual");
  });
});

describe("shared moments", () => {
  test("a moment link names the task, the project and the time, and reads back the same", () => {
    const ref = momentRef({ taskId: "tsk_9f", projectId: "prj_2", atMs: 754_321.4 });
    expect(ref).toBe("depo://team/tsk_9f?project=prj_2&at=754321");
    expect(parseMoment(`  ${ref}  `)).toEqual({ taskId: "tsk_9f", projectId: "prj_2", atMs: 754_321 });
    expect(parseMoment("depo://team/tsk_1?at=0")).toEqual({ taskId: "tsk_1", projectId: null, atMs: 0 });
  });

  test("anything else is not a moment", () => {
    expect(parseMoment("https://example.com/team/tsk_1?at=3")).toBeNull();
    expect(parseMoment("depo://team/../etc?at=3")).toBeNull();
    expect(parseMoment("depo://team/tsk_1?at=-5")).toBeNull();
    expect(parseMoment("depo://team/tsk_1?at=abc")).toBeNull();
    expect(parseMoment("depo://team/tsk_1?project=<script>&at=5")).toEqual({
      taskId: "tsk_1",
      projectId: null,
      atMs: 5,
    });
  });
});

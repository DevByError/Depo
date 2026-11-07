import type { LogLevel, LogLine } from "@depo/shared";
import { describe, expect, it } from "vitest";
import {
  EMPTY_VIEW,
  filterParams,
  formatLogLine,
  formatMs,
  type LogView,
  levelSelected,
  levelsParam,
  lineDetails,
  mergeTail,
  prependOlder,
  taskChip,
  toggleLevel,
} from "./logs";

const line = (id: string, level: LogLevel, extra: Partial<LogLine> = {}): LogLine => ({
  id,
  ts: "2026-11-07T10:00:00.000Z",
  level,
  component: "tools",
  msg: `msg ${id}`,
  projectId: null,
  taskId: null,
  agent: null,
  durationMs: null,
  err: null,
  data: {},
  ...extra,
});

describe("level filters", () => {
  it("sends levels only when some, not all, are selected", () => {
    expect(levelsParam(["error", "warn", "info", "debug"])).toBeUndefined();
    expect(levelsParam([])).toBeUndefined();
    expect(levelsParam(["error", "warn", "error"])).toEqual(["error", "warn"]);
  });

  it("toggles chips on and off", () => {
    expect(toggleLevel(["error", "warn"], "warn")).toEqual(["error"]);
    expect(toggleLevel(["error"], "debug")).toEqual(["error", "debug"]);
    expect(levelSelected("debug", [])).toBe(true);
    expect(levelSelected("debug", ["error"])).toBe(false);
  });

  it("builds query params without empty values", () => {
    expect(
      filterParams({ levels: ["error", "warn", "info", "debug"], component: null, text: "  ", taskId: null }),
    ).toEqual({});
    expect(filterParams({ levels: ["error"], component: "models", text: " slow ", taskId: "tsk_1" })).toEqual(
      {
        levels: ["error"],
        component: "models",
        text: "slow",
        taskId: "tsk_1",
      },
    );
    // The tail asks for every level so the chip counts stay right.
    expect(filterParams({ levels: ["error"], component: null, text: "", taskId: null }, false)).toEqual({});
  });
});

describe("live tail", () => {
  const start: LogView = {
    ...EMPTY_VIEW,
    lines: [line("a", "info"), line("b", "error")],
    counts: { debug: 0, info: 1, warn: 0, error: 1 },
    next: "2026-11-07T10:00:00.000Z|1",
    cursor: 10,
  };

  it("adds selected levels, counts every level and moves the cursor", () => {
    const v = mergeTail(start, [line("c", "debug"), line("d", "warn")], 12, ["error", "warn"]);
    expect(v.lines.map((l) => l.id)).toEqual(["a", "b", "d"]);
    expect(v.counts).toEqual({ debug: 1, info: 1, warn: 1, error: 1 });
    expect(v.cursor).toBe(12);
    expect(v.next).toBe(start.next);
  });

  it("returns the same view when nothing changed", () => {
    expect(mergeTail(start, [], 10, [])).toBe(start);
    expect(mergeTail(start, [], 11, []).cursor).toBe(11);
  });

  it("skips lines already shown", () => {
    const v = mergeTail(start, [line("b", "error")], 11, []);
    expect(v.lines).toHaveLength(2);
    expect(v.counts.error).toBe(1);
  });

  it("drops the oldest lines past the cap and stops offering older pages", () => {
    const many = Array.from({ length: 6 }, (_, i) => line(`n${i}`, "info"));
    const v = mergeTail(start, many, 20, [], 5);
    expect(v.lines.map((l) => l.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(v.trimmed).toBe(true);
    expect(v.next).toBeNull();
  });

  it("puts older pages in front and adds their counts", () => {
    const v = prependOlder(start, [line("z", "warn"), line("a", "info")], null, {
      debug: 0,
      info: 1,
      warn: 1,
      error: 0,
    });
    expect(v.lines.map((l) => l.id)).toEqual(["z", "a", "b"]);
    expect(v.next).toBeNull();
    expect(v.counts.warn).toBe(1);
  });
});

describe("formatting", () => {
  it("copies a line as one line of text with its fields", () => {
    const text = formatLogLine(
      line("x", "warn", {
        taskId: "tsk_1",
        durationMs: 12,
        err: { name: "Error", message: "boom", stack: "Error: boom\n  at x" },
        data: { tool: "read_file" },
      }),
    );
    expect(text).toBe(
      '2026-11-07T10:00:00.000Z WARN [tools] msg x {"tool":"read_file","taskId":"tsk_1","durationMs":12,"err":"boom"}',
    );
    expect(text).not.toContain("\n");
  });

  it("shows details without the stack", () => {
    const d = lineDetails(line("x", "error", { err: { name: "Error", message: "boom", stack: "trace" } }));
    expect(d).toMatchObject({ level: "error", component: "tools", err: { name: "Error", message: "boom" } });
    expect(JSON.stringify(d)).not.toContain("trace");
  });

  it("labels tasks by title, or by the end of the id", () => {
    const titles = new Map([["tsk_abc", "add a /health endpoint to the API and test it well"]]);
    expect(taskChip("tsk_abc", titles)).toBe("add a /health endpoint to t…");
    expect(taskChip("tsk_0123456789", titles)).toBe("task 456789");
  });

  it("formats durations", () => {
    expect(formatMs(null)).toBe("–");
    expect(formatMs(340)).toBe("340 ms");
    expect(formatMs(1234)).toBe("1.2 s");
    expect(formatMs(42_000)).toBe("42 s");
    expect(formatMs(125_000)).toBe("2m 5s");
  });
});

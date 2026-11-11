import { describe, expect, test } from "vitest";
import { pauseLabel } from "@/components/panels/EngineHealth";
import { LATE_HEARTBEAT_MS, pulseLabel } from "@/components/panels/HeartbeatPulse";
import { buildReport, countPageLoad, FreezeMeter, worthReporting } from "./link-report";

// The owner saw "Heartbeat 12s ago" and thought the engine had stopped. The line now tells a busy
// engine from a dropped link, and after a drop the window tells the engine what happened.

describe("the heartbeat line", () => {
  test("says busy on an open link, reconnecting on a dropped one", () => {
    expect(pulseLabel("open", 1500)).toBe("Heartbeat 1s ago");
    expect(pulseLabel("open", 400)).toBe("Heartbeat just now");
    expect(pulseLabel("open", 12_000)).toBe("Engine busy · no heartbeat for 12s");
    expect(pulseLabel("open", LATE_HEARTBEAT_MS)).toBe("Heartbeat 6s ago");
    expect(pulseLabel("open", null)).toBe("No heartbeat yet");
    expect(pulseLabel("reconnecting", 12_000)).toBe("Reconnecting to the engine");
    expect(pulseLabel("stopped", null)).toBe("Not connected to the engine");
  });

  test("the Engine panel shows the longest pause the engine had", () => {
    expect(pauseLabel([])).toBe("–");
    expect(pauseLabel([undefined, 3, 40])).toBe("none");
    expect(pauseLabel([12, 640])).toBe("640 ms");
    expect(pauseLabel([5, 12_900])).toBe("12.9 s");
  });
});

describe("the window's report after a reconnect", () => {
  test("counts reloads in this session", () => {
    const store = new Map<string, string>();
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(countPageLoad(s)).toBe(1);
    expect(countPageLoad(s)).toBe(2);
    expect(countPageLoad(undefined)).toBe(1);
  });

  test("keeps freezes of a second or more and resets when read", () => {
    const m = new FreezeMeter();
    m.add(300);
    m.add(1200);
    m.add(4200);
    expect(m.take()).toEqual({ freezes: 2, longestFreezeMs: 4200 });
    expect(m.take()).toEqual({ freezes: 0, longestFreezeMs: 0 });
  });

  test("reports a dropped link, a reload or a freeze, and stays quiet otherwise", () => {
    const quiet = buildReport({
      close: null,
      connects: 1,
      pageLoads: 1,
      freezes: { freezes: 0, longestFreezeMs: 0 },
      visible: true,
    });
    expect(worthReporting(quiet)).toBe(false);
    const dropped = buildReport({
      close: { code: 1006, reason: "", clean: false, at: 1000, attempts: 6, downMs: 12_900 },
      connects: 2,
      pageLoads: 1,
      freezes: { freezes: 1, longestFreezeMs: 4200 },
      visible: false,
      now: 14_000,
    });
    expect(dropped.lastClose).toEqual({
      code: 1006,
      reason: "",
      clean: false,
      agoMs: 13_000,
      downMs: 12_900,
      attempts: 6,
    });
    expect(worthReporting(dropped)).toBe(true);
    expect(worthReporting({ ...quiet, pageLoads: 2 })).toBe(true);
  });
});

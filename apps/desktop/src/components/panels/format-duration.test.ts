import { describe, expect, it } from "vitest";
import { formatDuration } from "./ChatPanel";

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

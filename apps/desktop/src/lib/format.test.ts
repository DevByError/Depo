import { expect, test } from "vitest";
import { filterEvents } from "@/components/panels/ActivityFeed";
import { formatAgo, formatBytes, formatDuration } from "./format";

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(48 * 1024 * 1024)).toBe("48.0 MB");
});

test("formatDuration", () => {
  expect(formatDuration(5_000)).toBe("5s");
  expect(formatDuration(65_000)).toBe("1m 5s");
  expect(formatDuration(3_660_000)).toBe("1h 1m");
  expect(formatAgo(200)).toBe("just now");
});

test("filterEvents matches text, agent and type", () => {
  const base = {
    id: "evt_x",
    ts: "",
    seq: 1,
    projectId: null,
    taskId: null,
    details: null,
    durationMs: null,
    status: "info",
    ephemeral: false,
  } as const;
  const events = [
    {
      ...base,
      id: "evt_1",
      agent: "backend@1.0.0",
      type: "reading_file",
      text: "Reading C:\\Projects\\api\\main.py",
    },
    { ...base, id: "evt_2", agent: "engine", type: "info", text: "Engine started" },
  ] as const;
  expect(filterEvents([...events], "main.py")).toHaveLength(1);
  expect(filterEvents([...events], "BACKEND")).toHaveLength(1);
  expect(filterEvents([...events], "reading")).toHaveLength(1);
  expect(filterEvents([...events], "")).toHaveLength(2);
});

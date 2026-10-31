import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { tempDir } from "./helpers";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function setup() {
  const t = tempDir();
  const db = openDatabase({ file: path.join(t.dir, "depo.db"), backupsDir: path.join(t.dir, "b") });
  const bus = new EventBus(db.db, createLogger({ dir: t.dir }));
  cleanup = () => {
    db.close();
    t.cleanup();
  };
  return { bus };
}

test("persists events, skips ephemeral ones, and notifies listeners in order", () => {
  const { bus } = setup();
  const seen: DepoEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.emit({
    agent: "backend@1.0.0",
    type: "reading_file",
    text: "Reading C:\\Projects\\a b\\main.py",
    projectId: "prj_1",
  });
  bus.emit({ agent: "engine", type: "heartbeat", text: "alive", ephemeral: true });
  bus.emit({ agent: "engine", type: "info", text: "done" });

  expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(bus.persistedCount).toBe(2);
  const recent = bus.recent({ limit: 10 });
  expect(recent.map((e) => e.type)).toEqual(["reading_file", "info"]);
  expect(bus.recent({ limit: 10, projectId: "prj_1" })).toHaveLength(1);
  expect(bus.recent({ limit: 10, projectId: null })).toHaveLength(1);
  expect(bus.recent({ limit: 10, types: ["info"] })).toHaveLength(1);
  expect(bus.recent({ limit: 10, query: "a b\\main" })).toHaveLength(1);
});

test("search treats % and _ literally", () => {
  const { bus } = setup();
  bus.emit({ agent: "engine", type: "info", text: "100% done" });
  bus.emit({ agent: "engine", type: "info", text: "1000 done" });
  expect(bus.recent({ limit: 10, query: "0%" })).toHaveLength(1);
});

test("redacts secrets in text and details", () => {
  const { bus } = setup();
  const e = bus.emit({
    agent: "engine",
    type: "running_command",
    text: "set API_KEY=abc",
    details: { password: "x" },
  });
  expect(e.text).toBe("set API_KEY=«redacted»");
  expect(e.details).toEqual({ password: "«redacted»" });
});

test("a throwing listener does not break the bus", () => {
  const { bus } = setup();
  let reached = false;
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe(() => {
    reached = true;
  });
  bus.emit({ agent: "engine", type: "info", text: "x" });
  expect(reached).toBe(true);
});

test("returns the newest N events in chronological order", () => {
  const { bus } = setup();
  for (let i = 0; i < 5; i++) bus.emit({ agent: "engine", type: "info", text: `e${i}` });
  expect(bus.recent({ limit: 3 }).map((e) => e.text)).toEqual(["e2", "e3", "e4"]);
});

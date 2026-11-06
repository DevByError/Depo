import type { DepoEvent } from "@depo/shared";
import { expect, test } from "vitest";
import { type Command, filterCommands, fuzzyScore, TAB_COMMANDS } from "./commands";
import { eventToNotice } from "./notify";

const cmd = (id: string, title: string, keywords = ""): Command => ({
  id,
  title,
  keywords,
  group: "Do",
  run: () => {},
});

test("fuzzy search prefers exact and early matches and ignores non-matches", () => {
  expect(fuzzyScore("diff", "Go to Diff Review")).toBeGreaterThan(0);
  expect(fuzzyScore("zzz", "Go to Diff Review")).toBe(0);
  expect(fuzzyScore("", "anything")).toBeGreaterThan(0);
  expect(fuzzyScore("go", "Go to Chat")).toBeGreaterThan(fuzzyScore("go", "Show the tour, then go"));
  expect(fuzzyScore("dr", "Diff Review")).toBeGreaterThan(0);
});

test("commands are filtered, ranked, and found through their keywords", () => {
  const all = [
    cmd("a", "Go to Chat", "task prompt"),
    cmd("b", "Go to Diff Review", "changes approve"),
    cmd("c", "Open settings", "preferences"),
  ];
  expect(filterCommands(all, "").length).toBe(3);
  expect(filterCommands(all, "diff")[0]?.id).toBe("b");
  expect(filterCommands(all, "approve")[0]?.id).toBe("b");
  expect(filterCommands(all, "pref")[0]?.id).toBe("c");
  expect(filterCommands(all, "qqq")).toEqual([]);
});

test("every centre tab has a command", () => {
  expect(TAB_COMMANDS.map((t) => t.id)).toEqual(
    expect.arrayContaining(["chat", "plan", "diff", "agent-lab", "blocks", "security", "knowledge"]),
  );
  expect(new Set(TAB_COMMANDS.map((t) => t.id)).size).toBe(TAB_COMMANDS.length);
});

const ev = (p: Partial<DepoEvent>): DepoEvent =>
  ({
    id: "evt_1",
    ts: new Date().toISOString(),
    seq: 1,
    projectId: "p",
    taskId: "t",
    agent: "x",
    type: "info",
    text: "t",
    details: null,
    durationMs: null,
    status: "info",
    ...p,
  }) as DepoEvent;

test("only approvals, finished work and errors become notifications", () => {
  expect(
    eventToNotice(ev({ type: "waiting_for_user", status: "started", text: "Run npm install?" })),
  ).toMatchObject({ title: "Needs your approval", level: "attention" });
  expect(eventToNotice(ev({ type: "waiting_for_user", status: "succeeded" }))).toBeNull();
  expect(
    eventToNotice(
      ev({ type: "handoff", text: "Changes ready for review: 3 files", details: { changeSetId: "cs_1" } }),
    )?.title,
  ).toBe("Changes are ready to review");
  expect(eventToNotice(ev({ type: "handoff", text: "Finished with no file changes" }))?.title).toBe(
    "Task finished",
  );
  expect(eventToNotice(ev({ type: "handoff", text: "Backend handed to Testing" }))).toBeNull();
  expect(eventToNotice(ev({ type: "error", text: "boom" }))?.level).toBe("problem");
  expect(eventToNotice(ev({ type: "heartbeat" }))).toBeNull();
  expect(eventToNotice(ev({ type: "error", taskId: null }))).toBeNull();
});

import type { SearchGroup, SearchResult } from "@depo/shared";
import { describe, expect, test } from "vitest";
import type { Command } from "./commands";
import { buildSections, domId, flatItems, moveActive, parseQuery, scopesFor, sliceMarks } from "./search";

const cmd = (id: string, title: string, group: Command["group"] = "Do"): Command => ({
  id,
  title,
  group,
  run: () => {},
});
const commands = [
  cmd("go-files", "Go to Files", "Go to"),
  cmd("settings", "Open settings"),
  cmd("tour", "Show the welcome tour", "Help"),
];

const result = (scope: SearchResult["scope"], title: string): SearchResult => ({
  id: `${scope}:${title}`,
  scope,
  title,
  titleMarks: [],
  detail: "",
  snippet: null,
  score: 1,
  target: { kind: "file", path: title, line: null },
});
const group = (
  scope: SearchGroup["scope"],
  titles: string[],
  extra: Partial<SearchGroup> = {},
): SearchGroup => ({
  scope,
  results: titles.map((t) => result(scope, t)),
  more: false,
  timedOut: false,
  error: null,
  tookMs: 3,
  ...extra,
});

describe("parseQuery and scopesFor", () => {
  test("prefixes pick the mode and are cut from the text", () => {
    expect(parseQuery("  user service ")).toEqual({ mode: "all", text: "user service", prefix: null });
    expect(parseQuery(">theme")).toMatchObject({ mode: "commands", text: "theme" });
    expect(parseQuery("@ UserService")).toMatchObject({ mode: "symbols", text: "UserService" });
    expect(parseQuery("#login bug")).toMatchObject({ mode: "tasks", text: "login bug" });
    expect(parseQuery("/main.py")).toMatchObject({ mode: "files", text: "main.py" });
    expect(parseQuery("? how does auth work")).toMatchObject({ mode: "ask", text: "how does auth work" });
  });

  test("each mode asks the engine for the right scopes", () => {
    expect(scopesFor("all")).toHaveLength(7);
    expect(scopesFor("symbols")).toEqual(["symbols"]);
    expect(scopesFor("tasks")).toEqual(["tasks", "decisions"]);
    expect(scopesFor("files")).toEqual(["files"]);
    expect(scopesFor("commands")).toBeNull();
    expect(scopesFor("ask")).toBeNull();
  });
});

describe("buildSections", () => {
  const base = {
    commands,
    scopes: scopesFor("all"),
    groups: null,
    searching: false,
    remote: false,
    hasProject: true,
  } as const;

  test("an empty box lists every command in its group", () => {
    const s = buildSections({ ...base, mode: "all", text: "" });
    expect(s.map((x) => x.label)).toEqual(["Go to", "Do", "Help"]);
  });

  test("commands first, then the engine's groups in its order, then Ask", () => {
    const s = buildSections({
      ...base,
      mode: "all",
      text: "set",
      remote: true,
      groups: [group("content", ["a.py"]), group("files", ["settings.py"]), group("logs", [])],
    });
    expect(s.map((x) => x.label)).toEqual(["Commands", "In files", "Files", "Ask"]);
    const ask = s.at(-1)?.items[0];
    expect(ask).toMatchObject({ kind: "ask", text: "set", disabled: false });
  });

  test("scopes still on their way say so; quiet scopes are left out once answered", () => {
    const waiting = buildSections({
      ...base,
      mode: "files",
      text: "app",
      scopes: ["files"],
      remote: true,
      searching: true,
    });
    expect(waiting[0]).toMatchObject({ label: "Files", note: "Searching…", items: [] });
    const done = buildSections({
      ...base,
      mode: "all",
      text: "zzz",
      remote: true,
      groups: [group("files", []), group("tasks", [], { timedOut: true })],
    });
    expect(done.map((x) => x.label)).toEqual(["Ask"]);
  });

  test("a scope's error shows only when the search was narrowed to it", () => {
    const err = group("symbols", [], { error: "The code index is off for this project." });
    const narrowed = buildSections({
      ...base,
      mode: "symbols",
      text: "User",
      scopes: ["symbols"],
      remote: true,
      groups: [err],
    });
    expect(narrowed[0]?.note).toBe("The code index is off for this project.");
    const all = buildSections({ ...base, mode: "all", text: "User", remote: true, groups: [err] });
    expect(all.map((x) => x.label)).toEqual(["Ask"]);
  });

  test("ask mode shows only the Ask row, disabled without a project", () => {
    const s = buildSections({ ...base, mode: "ask", text: "why", hasProject: false });
    expect(s).toHaveLength(1);
    expect(s[0]?.items[0]).toMatchObject({ kind: "ask", disabled: true });
  });
});

describe("keyboard movement and ids", () => {
  test("moves across sections, skips a disabled Ask row and stays put at the ends", () => {
    const s = buildSections({
      mode: "all",
      text: "go",
      commands,
      scopes: scopesFor("all"),
      groups: [group("files", ["go.mod", "cmd/go.go"])],
      searching: false,
      remote: true,
      hasProject: false,
    });
    const items = flatItems(s);
    expect(items.map((i) => i.kind)).toEqual(["command", "result", "result", "ask"]);
    expect(moveActive(items, 0, 1)).toBe(1);
    expect(moveActive(items, 2, 1)).toBe(2);
    expect(moveActive(items, 0, -1)).toBe(0);
    expect(moveActive(items, 0, "last")).toBe(2);
    expect(moveActive(items, 2, "first")).toBe(0);
  });

  test("dom ids are safe and still tell similar ids apart", () => {
    const a = domId("file:app/billing service.py");
    const b = domId("file:app/billing_service.py");
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });

  test("sliceMarks moves highlight ranges into a part of a title", () => {
    expect(
      sliceMarks(
        [
          [0, 3],
          [8, 12],
        ],
        6,
        14,
      ),
    ).toEqual([[2, 6]]);
    expect(sliceMarks([[4, 9]], 6, 14)).toEqual([[0, 3]]);
  });
});

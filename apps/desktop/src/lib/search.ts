import {
  fuzzyMatch,
  type Marks,
  positionsToMarks,
  SEARCH_SCOPES,
  type SearchGroup,
  type SearchResult,
  type SearchScope,
} from "@depo/shared";
import { type Command, filterCommands } from "./commands";

/** What the palette looks through, chosen by the first character of the query. */
export type PaletteMode = "all" | "commands" | "symbols" | "tasks" | "files" | "ask";

export const PREFIXES: { prefix: string; mode: PaletteMode; label: string }[] = [
  { prefix: ">", mode: "commands", label: "commands" },
  { prefix: "@", mode: "symbols", label: "symbols" },
  { prefix: "#", mode: "tasks", label: "tasks" },
  { prefix: "/", mode: "files", label: "files" },
  { prefix: "?", mode: "ask", label: "ask Depo" },
];

export function parseQuery(raw: string): { mode: PaletteMode; text: string; prefix: string | null } {
  const lead = raw.trimStart();
  const p = PREFIXES.find((x) => lead.startsWith(x.prefix));
  if (!p) return { mode: "all", text: raw.trim(), prefix: null };
  return { mode: p.mode, text: lead.slice(1).trim(), prefix: p.prefix };
}

/** Engine scopes for a mode; null = nothing to ask the engine. */
export function scopesFor(mode: PaletteMode): SearchScope[] | null {
  switch (mode) {
    case "all":
      return [...SEARCH_SCOPES];
    case "symbols":
      return ["symbols"];
    case "tasks":
      return ["tasks", "decisions"];
    case "files":
      return ["files"];
    default:
      return null;
  }
}

/** Shorter queries only search commands; one letter would match half the project. */
export const MIN_REMOTE = 2;

export const SCOPE_LABEL: Record<SearchScope, string> = {
  files: "Files",
  symbols: "Symbols",
  content: "In files",
  tasks: "Tasks",
  decisions: "Decisions",
  memory: "Memory",
  logs: "Logs",
};

export type PaletteItem =
  | { kind: "command"; id: string; command: Command; marks: Marks }
  | { kind: "result"; id: string; result: SearchResult }
  | { kind: "ask"; id: string; text: string; disabled: boolean };

export interface PaletteSection {
  id: string;
  label: string;
  items: PaletteItem[];
  /** Shown next to the label: "Searching…", "Took too long", or an error. */
  note: string | null;
  more: boolean;
  /** The engine scope behind the section; null for commands and Ask. */
  scope: SearchScope | null;
}

/** Highlight positions of a command title (none when it matched through its keywords). */
export function commandMarks(command: Command, text: string): Marks {
  if (!text) return [];
  const m = fuzzyMatch(text, command.title);
  return m ? positionsToMarks(m.positions) : [];
}

/**
 * Turn commands, engine groups and the Ask row into the sections the palette shows, in order.
 * `groups` is null while the first answer for this query is on its way.
 */
export function buildSections(o: {
  mode: PaletteMode;
  text: string;
  commands: Command[];
  scopes: SearchScope[] | null;
  groups: SearchGroup[] | null;
  searching: boolean;
  remote: boolean;
  hasProject: boolean;
}): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const cmdItems = (list: Command[]): PaletteItem[] =>
    list.map((c) => ({ kind: "command", id: `cmd-${c.id}`, command: c, marks: commandMarks(c, o.text) }));

  if (o.mode === "ask") {
    sections.push(askSection(o.text, o.hasProject));
    return sections;
  }

  if (o.mode === "all" || o.mode === "commands") {
    if (!o.text) {
      // No query yet: every command, in its group.
      for (const group of ["Go to", "Do", "Help"] as const) {
        const items = o.commands.filter((c) => c.group === group);
        if (items.length)
          sections.push({
            id: `g-${group}`,
            label: group,
            items: cmdItems(items),
            note: null,
            more: false,
            scope: null,
          });
      }
      return sections;
    }
    const matched = filterCommands(o.commands, o.text);
    const shown = o.mode === "all" ? matched.slice(0, 5) : matched;
    if (shown.length)
      sections.push({
        id: "commands",
        label: "Commands",
        items: cmdItems(shown),
        note: null,
        more: matched.length > shown.length,
        scope: null,
      });
  }

  if (o.remote && o.scopes) {
    const byScope = new Map((o.groups ?? []).map((g) => [g.scope, g]));
    // The engine ranks the groups; keep its order, then any scope that has not answered.
    const order = [...(o.groups ?? []).map((g) => g.scope), ...o.scopes.filter((s) => !byScope.has(s))];
    for (const scope of order) {
      if (!o.scopes.includes(scope)) continue;
      const g = byScope.get(scope);
      const items: PaletteItem[] = (g?.results ?? []).map((r) => ({
        kind: "result",
        id: `res-${domId(r.id)}`,
        result: r,
      }));
      let note: string | null = null;
      if (o.searching) note = "Searching…";
      else if (g?.timedOut) note = "Stopped early to stay quick";
      if (items.length === 0) {
        // Quiet when a scope simply has nothing; say so only when the person narrowed to it.
        if (o.searching && !g)
          sections.push({ id: `s-${scope}`, label: SCOPE_LABEL[scope], items, note, more: false, scope });
        else if (o.scopes.length === 1 && g?.error)
          sections.push({
            id: `s-${scope}`,
            label: SCOPE_LABEL[scope],
            items,
            note: g.error,
            more: false,
            scope,
          });
        continue;
      }
      sections.push({
        id: `s-${scope}`,
        label: SCOPE_LABEL[scope],
        items,
        note,
        more: g?.more ?? false,
        scope,
      });
    }
  }

  if (o.mode === "all" && o.text) sections.push(askSection(o.text, o.hasProject));
  return sections;
}

function askSection(text: string, hasProject: boolean): PaletteSection {
  return {
    id: "ask",
    label: "Ask",
    items: [{ kind: "ask", id: "ask-depo", text, disabled: !hasProject || !text }],
    note: null,
    more: false,
    scope: null,
  };
}

/** A string as a valid, stable HTML id part (no spaces or odd characters; a hash keeps it unique). */
export function domId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}-${h.toString(36)}`;
}

/** "Type / to see more" under a capped group in the everything view. */
export const MORE_HINT: Partial<Record<SearchScope, string>> = {
  files: "Type / to see more",
  symbols: "Type @ to see more",
  tasks: "Type # to see more",
  decisions: "Type # to see more",
};

export function flatItems(sections: PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}

/** The next selectable index from `from` in `dir`, skipping disabled rows; stays put at the ends. */
export function moveActive(items: PaletteItem[], from: number, dir: 1 | -1 | "first" | "last"): number {
  const ok = (i: number) => {
    const it = items[i];
    return !!it && !(it.kind === "ask" && it.disabled);
  };
  if (dir === "first" || dir === "last") {
    const range = dir === "first" ? items.keys() : [...items.keys()].reverse();
    for (const i of range) if (ok(i)) return i;
    return 0;
  }
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (ok(i)) return i;
  return from;
}

/** Marks inside [from, to) of a string, moved to start at 0 (for showing part of a title). */
export function sliceMarks(marks: Marks, from: number, to: number): Marks {
  return marks
    .filter(([a, b]) => b > from && a < to)
    .map(([a, b]) => [Math.max(a, from) - from, Math.min(b, to) - from] as [number, number]);
}

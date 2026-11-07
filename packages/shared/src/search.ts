import { z } from "zod";

/**
 * Universal search (Ctrl+K): one query looks through files, symbols, file contents, memory,
 * decisions, tasks and engine logs. Commands and tabs are matched in the UI itself.
 */

export const SearchScopeSchema = z.enum([
  "files",
  "symbols",
  "content",
  "tasks",
  "decisions",
  "memory",
  "logs",
]);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SEARCH_SCOPES: readonly SearchScope[] = SearchScopeSchema.options;

/** Character ranges [start, end) to highlight in a string. */
export const MarksSchema = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]));
export type Marks = z.infer<typeof MarksSchema>;

/** Where a result opens in the UI. */
export const SearchTargetSchema = z.discriminatedUnion("kind", [
  /** Files tab, at a line when known. */
  z.object({ kind: z.literal("file"), path: z.string(), line: z.number().int().positive().nullable() }),
  /** Chat, with that task open. */
  z.object({ kind: z.literal("task"), taskId: z.string() }),
  /** Team, scrolled to that decision. */
  z.object({ kind: z.literal("decision"), taskId: z.string(), eventId: z.string() }),
  /** Memory, with that item in view. */
  z.object({ kind: z.literal("memory"), factId: z.string(), global: z.boolean() }),
  /** The Logs tab, filtered to the text (and the task, when the line has one). */
  z.object({ kind: z.literal("log"), text: z.string(), taskId: z.string().nullable() }),
]);
export type SearchTarget = z.infer<typeof SearchTargetSchema>;

export const SearchResultSchema = z.object({
  /** Unique within one answer. */
  id: z.string(),
  scope: SearchScopeSchema,
  title: z.string(),
  titleMarks: MarksSchema,
  /** Where it is, in a few words: "src/app.py:12", "Backend · 2 days ago". */
  detail: z.string(),
  /** A short piece of the matching text, with the match highlighted. */
  snippet: z.object({ text: z.string(), marks: MarksSchema }).nullable(),
  /** 0 to 1, higher is better. Comparable within a scope. */
  score: z.number(),
  target: SearchTargetSchema,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchGroupSchema = z.object({
  scope: SearchScopeSchema,
  results: z.array(SearchResultSchema),
  /** More matches exist than were returned. */
  more: z.boolean(),
  /** The scope ran out of its time budget; the results are what was found until then. */
  timedOut: z.boolean(),
  /** Why the scope could not search (no project open, no index yet, …), in plain words. */
  error: z.string().nullable(),
  tookMs: z.number().int().nonnegative(),
});
export type SearchGroup = z.infer<typeof SearchGroupSchema>;

export const SearchMethods = {
  "search.everything": {
    params: z
      .object({
        /** Project to search; scopes that need one report it when it is missing. */
        projectId: z.string().max(100).optional(),
        query: z.string().max(200),
        /** Scopes to search (default: all). */
        scopes: z.array(SearchScopeSchema).min(1).max(7).optional(),
        /** Results per scope. */
        limit: z.number().int().min(1).max(50).default(6),
      })
      .strict(),
    result: z.object({
      query: z.string(),
      /** Best group first; groups without results come last. */
      groups: z.array(SearchGroupSchema),
      tookMs: z.number().int().nonnegative(),
    }),
  },
} as const;

// ---- matching helpers shared by the engine and the UI ---------------------------------------

export interface FuzzyMatch {
  /** Higher is better; 0 never happens (no match returns null). */
  score: number;
  /** Indexes of the matched characters in the text. */
  positions: number[];
}

const BOUNDARY = /[\s/\\_\-.:()[\]{}<>,"'`@#]/;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] as string;
  const cur = text[i] as string;
  if (BOUNDARY.test(prev)) return true;
  // camelCase: a capital after a lower-case letter starts a word.
  return prev.toLowerCase() === prev && prev.toUpperCase() !== prev && cur.toUpperCase() === cur;
}

/**
 * Fuzzy match for names and paths: every query character must appear in order. Contiguous
 * matches, word starts and matches in the last path segment score higher; long texts lower.
 * Whitespace in the query is ignored ("app main" finds "src/app/main.py").
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 1, positions: [] };
  if (q.length > text.length) return null;
  const t = text.toLowerCase();
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const base = slash + 1;

  // Contiguous substring: best case. Prefer one in the last segment, then at a word start.
  let best: FuzzyMatch | null = null;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    let score = 100 + q.length * 4;
    if (at >= base) score += 30;
    if (at === base) score += 20;
    if (isBoundary(text, at)) score += 15;
    if (at === 0) score += 10;
    if (at >= base && at + q.length === text.length) score += 5;
    score -= Math.min(at, 60) * 0.2 + text.length * 0.05;
    if (!best || score > best.score) best = { score, positions: range(at, q.length) };
  }
  if (best) return best;

  // Subsequence: try the last segment first, then the whole text.
  const attempt = (from: number): FuzzyMatch | null => {
    const positions: number[] = [];
    let ti = from;
    let score = 0;
    let run = 0;
    for (const ch of q) {
      // Prefer the next word start that has the character, if it is close.
      let found = t.indexOf(ch, ti);
      if (found < 0) return null;
      const near = found;
      for (let j = found; j < Math.min(t.length, near + 24); j++) {
        if (t[j] === ch && isBoundary(text, j)) {
          if (j !== near && positions.length > 0 && positions[positions.length - 1] === near - 1) break;
          found = j;
          break;
        }
      }
      const consecutive = positions.length > 0 && positions[positions.length - 1] === found - 1;
      run = consecutive ? run + 1 : 0;
      score += 2 + run * 3 + (isBoundary(text, found) ? 5 : 0) + (found >= base ? 2 : 0);
      if (!consecutive && positions.length > 0) score -= Math.min(found - (positions.at(-1) ?? 0), 20) * 0.15;
      positions.push(found);
      ti = found + 1;
    }
    return { score: score - text.length * 0.05, positions };
  };
  const inBase = base > 0 ? attempt(base) : null;
  const whole = attempt(0);
  const pick =
    inBase && (!whole || inBase.score + 8 >= whole.score) ? { ...inBase, score: inBase.score + 8 } : whole;
  if (!pick) return null;
  return { score: Math.max(pick.score, 0.5), positions: pick.positions };
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/** Matched character indexes → ranges [start, end). */
export function positionsToMarks(positions: number[]): Marks {
  const marks: Marks = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const last = marks[marks.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else marks.push([p, p + 1]);
  }
  return marks;
}

/** Words of a query worth looking for (lower case, no duplicates, longest first). */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 8);
}

/** Ranges of every case-insensitive occurrence of the whole query, else of each of its words. */
export function textMarks(text: string, query: string): Marks {
  const lower = text.toLowerCase();
  const whole = query.trim().toLowerCase();
  const find = (needle: string): Marks => {
    const out: Marks = [];
    if (!needle) return out;
    for (
      let at = lower.indexOf(needle);
      at >= 0 && out.length < 20;
      at = lower.indexOf(needle, at + needle.length)
    )
      out.push([at, at + needle.length]);
    return out;
  };
  const exact = find(whole);
  if (exact.length) return exact;
  const marks = queryTerms(query).flatMap(find);
  marks.sort((a, b) => a[0] - b[0]);
  // Merge overlaps.
  const merged: Marks = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  return merged;
}

/**
 * A short window of `text` around the first match, single line, with the marks moved to match.
 * Returns null when nothing matches.
 */
export function snippetAround(
  text: string,
  query: string,
  width = 140,
): { text: string; marks: Marks } | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const marks = textMarks(flat, query);
  const first = marks[0];
  if (!first) return null;
  let start = 0;
  if (flat.length > width) {
    start = Math.max(0, Math.min(first[0] - Math.floor(width / 3), flat.length - width));
    // Start at a word boundary when one is close.
    if (start > 0) {
      const space = flat.indexOf(" ", start);
      if (space >= 0 && space < first[0] && space - start < 15) start = space + 1;
    }
  }
  const end = Math.min(flat.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const shift = prefix.length - start;
  const inside: Marks = marks
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]) => [a + shift, b + shift] as [number, number]);
  return { text: `${prefix}${flat.slice(start, end)}${suffix}`, marks: inside };
}

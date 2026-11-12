import fs from "node:fs";
import path from "node:path";
import { words } from "./retrieve";
import { codeFiles } from "./step-prompt";

/**
 * A small retrieval index over the files of the private copy, built in memory in milliseconds, no
 * model. It answers "which parts of this project are about these words?" for the step prompt (related
 * code to copy the style from) and for the `find_code` tool.
 *
 * What makes it better than plain keyword search:
 *  - Chunks follow the code: a function, a class, a route, a table or a component is one chunk
 *    (cut at declarations), not 40 arbitrary lines. A chunk is named after its symbol.
 *  - The symbol name and the file path count three times and once as words, so "login route"
 *    finds `app.post("/api/login")` and `loginHandler` before a comment that mentions login.
 *  - Words of the query are the step's own identifiers, route words and table names, so BM25 over
 *    the whole project (inverse document frequency from all chunks) picks the rare, telling words.
 *  - Files changed in this task rank higher (the work in progress), test files lower unless the
 *    query is about tests, and a file already shown in the prompt is left out.
 *  - Cached per file by size and modified time: a second question costs a few stats, not a re-read.
 */

const MAX_FILES = 700;
const MAX_FILE_BYTES = 200_000;
const MAX_CHUNK_LINES = 70;
const MIN_CHUNK_LINES = 5;

export interface Snippet {
  rel: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  symbol: string | null;
  text: string;
  score: number;
}

interface Doc {
  rel: string;
  start: number;
  end: number;
  symbol: string | null;
  text: string;
  /** Word counts of the chunk (the symbol and the path included, weighted). */
  tf: Map<string, number>;
  length: number;
  isTest: boolean;
}

const DECL = [
  // JS / TS: functions, classes, types, exported consts
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|abstract class)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|<|[A-Za-z_$][\w$]*\s*=>|\{|\[)/,
  // routes: app.get("/x"), router.post('/x'), @app.get("/x")
  /^(?:@)?(?:app|router|api|server|r)\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/,
  // Python
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  // Go / Rust / Java-ish
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
  // SQL
  /^CREATE\s+(?:TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_]\w*)/i,
];

/** The name a line declares at the start of a chunk, or null. */
export function declares(line: string): string | null {
  if (!line || /^\s/.test(line)) return null;
  for (const re of DECL) {
    const m = re.exec(line);
    if (m) return m[2] ? `${m[1]} ${m[2]}` : (m[1] ?? null);
  }
  return null;
}

/** Chunks that follow the code. Files with no declarations fall back to blocks cut at blank lines. */
export function codeChunks(lines: string[]): { start: number; end: number; symbol: string | null }[] {
  const starts: { at: number; symbol: string | null }[] = [];
  lines.forEach((l, i) => {
    const s = declares(l);
    if (s) starts.push({ at: i, symbol: s });
  });
  const out: { start: number; end: number; symbol: string | null }[] = [];
  if (starts.length < 2) {
    for (let from = 0; from < lines.length; ) {
      let to = Math.min(lines.length, from + 40);
      while (to < lines.length && to - from < MAX_CHUNK_LINES && (lines[to - 1] ?? "").trim() !== "") to++;
      out.push({ start: from + 1, end: to, symbol: starts[0]?.symbol ?? null });
      from = to;
    }
    return out;
  }
  // The lines before the first declaration (imports) are a chunk of their own.
  const bounds = [
    ...(starts[0] && starts[0].at > 0 ? [{ at: 0, symbol: null as string | null }] : []),
    ...starts,
  ];
  bounds.forEach((b, i) => {
    const next = bounds[i + 1]?.at ?? lines.length;
    // Long declarations are cut into pieces of at most MAX_CHUNK_LINES, all named after the symbol.
    for (let from = b.at; from < next; from += MAX_CHUNK_LINES)
      out.push({ start: from + 1, end: Math.min(next, from + MAX_CHUNK_LINES), symbol: b.symbol });
  });
  // A chunk does not end on blank lines (they belong to nothing).
  for (const c of out) while (c.end > c.start && (lines[c.end - 1] ?? "").trim() === "") c.end--;
  // Tiny chunks (a one-line type) join the one before them.
  const merged: typeof out = [];
  for (const c of out) {
    const prev = merged.at(-1);
    if (
      prev &&
      c.end - c.start + 1 < MIN_CHUNK_LINES &&
      prev.end === c.start - 1 &&
      prev.end - prev.start < MAX_CHUNK_LINES
    )
      prev.end = c.end;
    else merged.push({ ...c });
  }
  return merged;
}

const TESTISH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;

export class ProjectIndex {
  private readonly files = new Map<string, { sig: string; docs: Doc[] }>();
  private df = new Map<string, number>();
  private total = 0;
  private avg = 1;
  private dirty = true;

  constructor(private readonly root: string) {}

  /** Re-reads only the files whose size or modified time changed; forgets deleted files. */
  refresh(): void {
    const list = codeFiles(this.root, MAX_FILES);
    const seen = new Set<string>();
    for (const rel of list) {
      seen.add(rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(this.root, rel));
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
      if (this.files.get(rel)?.sig === sig) continue;
      this.files.set(rel, { sig, docs: this.build(rel) });
      this.dirty = true;
    }
    for (const rel of [...this.files.keys()])
      if (!seen.has(rel)) {
        this.files.delete(rel);
        this.dirty = true;
      }
    if (this.dirty) this.recount();
  }

  private build(rel: string): Doc[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      return [];
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const pathWords = words(rel);
    return codeChunks(lines).map((c) => {
      const body = lines.slice(c.start - 1, c.end).join("\n");
      const tf = new Map<string, number>();
      const add = (w: string, n: number) => tf.set(w, (tf.get(w) ?? 0) + n);
      const bodyWords = words(body);
      for (const w of bodyWords) add(w, 1);
      // The name and the path say what a chunk is about: they count three times.
      for (const w of words(c.symbol ?? "")) add(w, 3);
      for (const w of pathWords) add(w, 3);
      return {
        rel,
        start: c.start,
        end: c.end,
        symbol: c.symbol,
        text: body,
        tf,
        length: bodyWords.length + 1,
        isTest: TESTISH.test(rel),
      };
    });
  }

  private recount(): void {
    this.df = new Map();
    let n = 0;
    let len = 0;
    for (const f of this.files.values())
      for (const d of f.docs) {
        n++;
        len += d.length;
        for (const w of d.tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      }
    this.total = n;
    this.avg = n ? len / n : 1;
    this.dirty = false;
  }

  /** How many files and chunks are indexed (for the logs and tests). */
  size(): { files: number; chunks: number } {
    return { files: this.files.size, chunks: this.total };
  }

  /**
   * The chunks most about `query`, best first, within `budget` characters. `exclude` are files the
   * prompt already shows whole; `recent` are files changed in this task (ranked higher).
   */
  search(
    query: string,
    opts: { k?: number; budget?: number; exclude?: ReadonlySet<string>; recent?: ReadonlySet<string> } = {},
  ): Snippet[] {
    this.refresh();
    const q = [...new Set(words(query))];
    if (!q.length || !this.total) return [];
    const wantsTests = /\b(tests?|spec|pytest|jest|vitest|assert)\b/i.test(query);
    const k1 = 1.2;
    const b = 0.75;
    const scored: Snippet[] = [];
    for (const f of this.files.values())
      for (const d of f.docs) {
        if (opts.exclude?.has(d.rel)) continue;
        let score = 0;
        for (const w of q) {
          const tf = d.tf.get(w);
          if (!tf) continue;
          const n = this.df.get(w) ?? 0;
          const idf = Math.log(1 + (this.total - n + 0.5) / (n + 0.5));
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / this.avg));
        }
        if (score <= 0) continue;
        if (opts.recent?.has(d.rel)) score *= 1.3;
        if (d.isTest && !wantsTests) score *= 0.7;
        scored.push({ rel: d.rel, start: d.start, end: d.end, symbol: d.symbol, text: d.text, score });
      }
    scored.sort((a, b2) => b2.score - a.score);
    const out: Snippet[] = [];
    let used = 0;
    const budget = opts.budget ?? 2400;
    const perFile = new Map<string, number>();
    for (const s of scored) {
      if (out.length >= (opts.k ?? 4)) break;
      // At most two chunks of one file: the answer should span the project, not one big file.
      if ((perFile.get(s.rel) ?? 0) >= 2) continue;
      const text = s.text.length > 1400 ? `${s.text.slice(0, 1400)}\n…` : s.text;
      if (used + text.length > budget) continue;
      used += text.length;
      perFile.set(s.rel, (perFile.get(s.rel) ?? 0) + 1);
      out.push({ ...s, text });
    }
    return out;
  }
}

const indexes = new Map<string, ProjectIndex>();

/** The index of a folder (made once, kept while the engine runs; it refreshes itself on every search). */
export function indexFor(root: string): ProjectIndex {
  let ix = indexes.get(root);
  if (!ix) {
    if (indexes.size > 12) indexes.delete(indexes.keys().next().value as string);
    ix = new ProjectIndex(root);
    indexes.set(root, ix);
  }
  return ix;
}

/** Snippets as prompt text: where each one is, then its exact text. */
export function snippetsText(list: Snippet[]): string {
  return list
    .map(
      (s) =>
        `${s.rel} (lines ${s.start}-${s.end}${s.symbol ? `, ${s.symbol}` : ""})\n\`\`\`\n${s.text.replace(/\s+$/, "")}\n\`\`\``,
    )
    .join("\n\n");
}

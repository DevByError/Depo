import fs from "node:fs";
import path from "node:path";
import { resolveInside, ToolError, toRel } from "./paths";

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_READ_LINES = 800;
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/** Directory names skipped when listing or searching without git. */
export const DEFAULT_IGNORES = new Set([
  ".git",
  ".depo",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".idea",
  ".vs",
  "coverage",
]);

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ReadResult {
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  /** Lines prefixed with their number, e.g. `  12│ def health():`. */
  text: string;
  truncated: boolean;
}

export function readFileTool(root: string, rel: string, startLine?: number, endLine?: number): ReadResult {
  const { abs, rel: clean } = resolveInside(root, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new ToolError(`File not found: ${clean}`);
  }
  if (st.isDirectory()) throw new ToolError(`${clean} is a folder. Use list_dir.`);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf))
    throw new ToolError(`${clean} is a binary file (${st.size} bytes) and cannot be shown as text.`);
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.min(startLine ?? 1, Math.max(1, total)));
  let end = Math.min(total, endLine ?? total);
  let truncated = false;
  if (end - start + 1 > MAX_READ_LINES) {
    end = start + MAX_READ_LINES - 1;
    truncated = true;
  }
  const width = String(end).length;
  let bytes = 0;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const line = `${String(i).padStart(width)}│ ${lines[i - 1] ?? ""}`;
    bytes += line.length + 1;
    if (bytes > MAX_READ_BYTES) {
      end = i - 1;
      truncated = true;
      break;
    }
    out.push(line);
  }
  return { path: clean, totalLines: total, startLine: start, endLine: end, text: out.join("\n"), truncated };
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export function listDirTool(
  root: string,
  rel: string,
  depth = 2,
  limit = 400,
): { entries: DirEntry[]; truncated: boolean } {
  const { abs } = resolveInside(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new ToolError(`Folder not found: ${rel}`);
  const entries: DirEntry[] = [];
  let truncated = false;
  const walk = (dir: string, d: number) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const it of items) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (DEFAULT_IGNORES.has(it.name)) continue;
        entries.push({ path: `${toRel(root, full)}/`, type: "dir" });
        if (d < depth) walk(full, d + 1);
      } else if (it.isFile()) {
        entries.push({ path: toRel(root, full), type: "file", size: fs.statSync(full).size });
      }
    }
  };
  walk(abs, 1);
  return { entries, truncated };
}

/** Detect the dominant line ending so edits keep the file's style. */
export function detectEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function writeFileTool(
  root: string,
  rel: string,
  content: string,
): { path: string; created: boolean; bytes: number } {
  const { abs, rel: clean } = resolveInside(root, rel);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES)
    throw new ToolError(`Refusing to write ${bytes} bytes to ${clean}; the limit is 2 MB.`);
  const created = !fs.existsSync(abs);
  if (!created && fs.statSync(abs).isDirectory()) throw new ToolError(`${clean} is a folder`);
  let text = content;
  if (!created) {
    const eol = detectEol(fs.readFileSync(abs, "utf8"));
    if (eol === "\r\n") text = text.replace(/\r?\n/g, "\r\n");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return { path: clean, created, bytes };
}

/** Add text at the end of a file, after a blank line (creates the file when it is missing). */
export function appendFileTool(
  root: string,
  rel: string,
  content: string,
): { path: string; created: boolean; added: number; total: number } {
  const { abs, rel: clean } = resolveInside(root, rel);
  const created = !fs.existsSync(abs);
  if (!created && fs.statSync(abs).isDirectory()) throw new ToolError(`${clean} is a folder`);
  const before = created ? "" : fs.readFileSync(abs, "utf8");
  const eol = created ? "\n" : detectEol(before);
  const body = content.replace(/\r?\n/g, "\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  const join = !before
    ? ""
    : before.endsWith("\n\n") || before.endsWith("\r\n\r\n")
      ? ""
      : /\r?\n$/.test(before)
        ? "\n"
        : "\n\n";
  const text = `${before}${(join + body).replace(/\n/g, eol)}`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WRITE_BYTES) throw new ToolError(`Refusing to grow ${clean} past the 2 MB limit.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  const lines = (t: string) => (t ? t.replace(/\r?\n$/, "").split(/\r?\n/).length : 0);
  return { path: clean, created, added: lines(body), total: lines(text) };
}

export interface Edit {
  /** Exact text to find. Must match exactly once unless `replaceAll`. */
  search: string;
  replace: string;
  replaceAll?: boolean;
}

/**
 * Search/replace edits with exact-match verification. Line endings are normalised for matching
 * only; if a block does not match exactly, a match ignoring trailing whitespace is tried, and
 * otherwise the error shows the closest lines so the model can retry with the right text.
 */
export function editFileTool(
  root: string,
  rel: string,
  edits: Edit[],
): { path: string; applied: number; added: number; removed: number; notes: string[] } {
  const { abs, rel: clean } = resolveInside(root, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${clean}. Use write_file to create it.`);
  const notes: string[] = [];
  const original = fs.readFileSync(abs, "utf8");
  const eol = detectEol(original);
  let text = original.replace(/\r\n/g, "\n");
  let added = 0;
  let removed = 0;
  edits.forEach((e, i) => {
    const search = e.search.replace(/\r\n/g, "\n");
    const replace = e.replace.replace(/\r\n/g, "\n");
    if (search.length === 0) throw new ToolError(`Edit ${i + 1}: search text is empty`);
    const count = countOccurrences(text, search);
    if (count === 1 || (count > 1 && e.replaceAll)) {
      text = e.replaceAll ? text.split(search).join(replace) : text.replace(search, () => replace);
    } else if (count > 1) {
      throw new ToolError(
        `Edit ${i + 1}: the search text appears ${count} times in ${clean}. Include more surrounding lines so it is unique, or set replaceAll.`,
      );
    } else {
      const loose = looseReplace(text, search, replace);
      if (loose === null) {
        throw new ToolError(
          `Edit ${i + 1}: the search text was not found in ${clean}.${closestHint(text, search)}`,
        );
      }
      text = loose.text;
      notes.push(`Edit ${i + 1} matched ${loose.how}`);
    }
    added += replace.split("\n").length;
    removed += search.split("\n").length;
  });
  const out = eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(abs, out, "utf8");
  return { path: clean, applied: edits.length, added, removed, notes };
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

const squash = (l: string) => l.replace(/\s+/g, " ").trim();

/**
 * Forgiving match for a search block that is not in the file character for character. Tiers, each
 * needing exactly one hit: (1) lines equal ignoring trailing spaces; (2) ignoring indentation (the
 * replacement is re-indented to match); (3) ignoring all spacing differences; (4) a block of the
 * same length where at least 80% of the lines match that way and the first and last do. The
 * compiler check after every edit catches a wrong guess. Returns the new text and which tier hit.
 */
function looseReplace(text: string, search: string, replace: string): { text: string; how: string } | null {
  const lines = text.split("\n");
  const rawWant = search.split("\n");
  while (rawWant.length > 1 && rawWant.at(-1)?.trim() === "") rawWant.pop();
  while (rawWant.length > 1 && rawWant[0]?.trim() === "") rawWant.shift();
  const rep = (replace.endsWith("\n") ? replace.slice(0, -1) : replace).split("\n");
  const tiers: { how: string; same: (a: string, b: string) => boolean; all: boolean }[] = [
    { how: "ignoring trailing spaces", same: (a, b) => a.trimEnd() === b.trimEnd(), all: true },
    { how: "ignoring indentation", same: (a, b) => a.trim() === b.trim(), all: true },
    { how: "ignoring spacing", same: (a, b) => squash(a) === squash(b), all: true },
  ];
  for (const t of tiers) {
    const hits: number[] = [];
    for (let i = 0; i + rawWant.length <= lines.length; i++)
      if (rawWant.every((w, j) => t.same(lines[i + j] ?? "", w))) hits.push(i);
    if (hits.length !== 1) continue;
    const at = hits[0] ?? 0;
    lines.splice(at, rawWant.length, ...reindent(rep, rawWant[0] ?? "", lines[at] ?? ""));
    return { text: lines.join("\n"), how: `${t.how}, lines ${at + 1}-${at + rawWant.length}` };
  }
  // Tier 4: the closest block of the same length.
  if (rawWant.length < 3) return null;
  const want = rawWant.map(squash);
  let best = -1;
  let bestScore = 0;
  let second = 0;
  for (let i = 0; i + rawWant.length <= lines.length; i++) {
    if (squash(lines[i] ?? "") !== want[0] || squash(lines[i + rawWant.length - 1] ?? "") !== want.at(-1))
      continue;
    let ok = 0;
    for (let j = 0; j < want.length; j++) if (squash(lines[i + j] ?? "") === want[j]) ok++;
    const score = ok / want.length;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = i;
    } else if (score > second) second = score;
  }
  if (best < 0 || bestScore < 0.8 || bestScore === second) return null;
  lines.splice(best, rawWant.length, ...reindent(rep, rawWant[0] ?? "", lines[best] ?? ""));
  return {
    text: lines.join("\n"),
    how: `closest block, ${Math.round(bestScore * 100)}% of lines equal, lines ${best + 1}-${best + rawWant.length}`,
  };
}

/** Give the replacement the file's indentation when the search block was indented differently. */
function reindent(rep: string[], searchFirst: string, fileFirst: string): string[] {
  const want = /^\s*/.exec(searchFirst)?.[0] ?? "";
  const have = /^\s*/.exec(fileFirst)?.[0] ?? "";
  if (want === have) return rep;
  return rep.map((l) => {
    if (l.trim() === "") return l;
    if (l.startsWith(want)) return have + l.slice(want.length);
    return l;
  });
}

/** Replace whole lines `start`..`end` (1-based, inclusive) with `content`. The fallback when search text keeps failing. */
export function replaceLinesTool(
  root: string,
  rel: string,
  start: number,
  end: number,
  content: string,
): { path: string; removed: number; added: number } {
  const { abs, rel: clean } = resolveInside(root, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${clean}. Use write_file to create it.`);
  const original = fs.readFileSync(abs, "utf8");
  const eol = detectEol(original);
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  const total = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  if (start < 1 || end < start || end > total)
    throw new ToolError(
      `Lines ${start}-${end} do not exist: ${clean} has ${total} lines. Read the file again for the numbers.`,
    );
  const body = content.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const next = content === "" ? [] : body.split("\n");
  lines.splice(start - 1, end - start + 1, ...next);
  const out = lines.join("\n");
  fs.writeFileSync(abs, eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out, "utf8");
  return { path: clean, removed: end - start + 1, added: next.length };
}

function closestHint(text: string, search: string): string {
  const wanted = search.split("\n").filter((l) => l.trim().length > 2);
  if (!wanted.length) return "";
  const lines = text.split("\n");
  // The first line of the search that exists in the file anchors the hint (the first lines are
  // often the ones the model got wrong).
  let idx = -1;
  let at = 0;
  for (; at < wanted.length && idx < 0; at++) {
    const probe = squash(wanted[at] ?? "");
    idx = lines.findIndex((l) => squash(l) === probe || squash(l).includes(probe));
  }
  if (idx < 0) return " Read the file again to get its current text.";
  const from = Math.max(0, idx - 2 - (at - 1));
  const to = Math.min(lines.length, from + Math.max(search.split("\n").length, 6) + 6);
  const snippet = lines
    .slice(from, to)
    .map((l, k) => `${from + k + 1}│ ${l}`)
    .join("\n");
  return ` A line of your search is near line ${idx + 1}, but the block differs. The current text there (copy from it, or use replace_lines with these line numbers):\n${snippet}`;
}

export function deleteFileTool(root: string, rel: string): { path: string } {
  const { abs, rel: clean } = resolveInside(root, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${clean}`);
  if (fs.statSync(abs).isDirectory()) throw new ToolError(`${clean} is a folder; delete files one by one.`);
  fs.rmSync(abs);
  return { path: clean };
}

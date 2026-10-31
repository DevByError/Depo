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
): { path: string; applied: number; added: number; removed: number } {
  const { abs, rel: clean } = resolveInside(root, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${clean}. Use write_file to create it.`);
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
      text = loose;
    }
    added += replace.split("\n").length;
    removed += search.split("\n").length;
  });
  const out = eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(abs, out, "utf8");
  return { path: clean, applied: edits.length, added, removed };
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

/** Match line by line ignoring trailing whitespace; replace only when exactly one match. */
function looseReplace(text: string, search: string, replace: string): string | null {
  const lines = text.split("\n");
  const want = search.split("\n").map((l) => l.trimEnd());
  while (want.length > 1 && want.at(-1) === "") want.pop();
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if ((lines[i + j] ?? "").trimEnd() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const at = hits[0] ?? 0;
  const rep = replace.endsWith("\n") ? replace.slice(0, -1) : replace;
  lines.splice(at, want.length, ...rep.split("\n"));
  return lines.join("\n");
}

function closestHint(text: string, search: string): string {
  const first = search
    .split("\n")
    .find((l) => l.trim().length > 0)
    ?.trim();
  if (!first) return "";
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(first));
  if (idx < 0) return " Read the file again to get its current text.";
  const from = Math.max(0, idx - 2);
  const snippet = lines
    .slice(from, idx + 5)
    .map((l, k) => `${from + k + 1}│ ${l}`)
    .join("\n");
  return ` The first line matches near line ${idx + 1}, but the rest differs. Current text there:\n${snippet}`;
}

export function deleteFileTool(root: string, rel: string): { path: string } {
  const { abs, rel: clean } = resolveInside(root, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${clean}`);
  if (fs.statSync(abs).isDirectory()) throw new ToolError(`${clean} is a folder; delete files one by one.`);
  fs.rmSync(abs);
  return { path: clean };
}

import fs from "node:fs";
import path from "node:path";
import type { ToolCall } from "@depo/model-gateway";
import { blockLabel, codeBlocks, isCode, isWholeFile, pathIn, safe } from "./codedump";

/**
 * File blocks: a way to write and change files with no JSON at all. Small models (3B) break JSON
 * when it has to carry code (a missing "]", a quote not written as \"), but they write code in
 * fences well, and Qwen coders know the SEARCH/REPLACE format:
 *
 *     be/src/app.ts
 *     ```ts
 *     <<<<<<< SEARCH
 *     exact lines from the file
 *     =======
 *     the new lines
 *     >>>>>>> REPLACE
 *     ```
 *
 * An empty SEARCH adds the lines to the end of a file (or creates it). A fenced block labelled
 * with the path of a file that does not exist yet creates that file. Depo turns each block into
 * the matching tool call (edit_file, append_file, write_file), so the usual checks apply.
 */

export interface SearchReplace {
  path: string;
  search: string;
  replace: string;
  /** Where the block starts and ends in the text (from its path line to its closing fence). */
  start: number;
  end: number;
}

const OPEN = /^[ \t]*<{5,9}[ \t]*SEARCH\b.*$/i;
const MID = /^[ \t]*={5,9}[ \t]*$/;
const CLOSE = /^[ \t]*>{5,9}[ \t]*REPLACE\b.*$/i;
const FENCE = /^[ \t]*(```+|~~~+)[ \t]*([^\n`]*)$/;

/** The SEARCH/REPLACE blocks of a reply, and how many were left unfinished. */
export function searchReplaceBlocks(text: string): { blocks: SearchReplace[]; unfinished: number } {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const blocks: SearchReplace[] = [];
  let unfinished = 0;
  let lastPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN.test(lines[i] ?? "")) continue;
    // The path: the nearest line above that names one (skipping blank lines and the fence; a
    // fence may carry it too, as in ```ts be/src/app.ts).
    let rel: string | null = null;
    let start = offsets[i] ?? 0;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const l = lines[j] ?? "";
      if (!l.trim()) continue;
      const fence = FENCE.exec(l);
      if (fence) {
        start = offsets[j] ?? start;
        const meta = (fence[2] ?? "").replace(/^[\w+#-]*[\s:]*/, "");
        rel = meta ? pathIn(` ${meta} `) : null;
        if (rel) break;
        continue;
      }
      if (CLOSE.test(l)) break;
      rel = pathIn(` ${l.replace(/^[#>*\s-]+|[*:`\s]+$/g, "")} `) ?? pathIn(l);
      if (rel) start = offsets[j] ?? start;
      break;
    }
    rel = rel ? safe(rel) : null;
    rel ??= lastPath;
    let mid = -1;
    let close = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k] ?? "";
      if (mid < 0 && MID.test(l)) mid = k;
      else if (mid >= 0 && CLOSE.test(l)) {
        close = k;
        break;
      } else if (OPEN.test(l)) break;
    }
    if (mid < 0 || close < 0 || !rel) {
      unfinished++;
      continue;
    }
    let endLine = close;
    // The fence that closes the block belongs to it.
    for (let k = close + 1; k < lines.length && k <= close + 2; k++) {
      const l = lines[k] ?? "";
      if (!l.trim()) continue;
      if (FENCE.test(l) && !(FENCE.exec(l)?.[2] ?? "").trim()) endLine = k;
      break;
    }
    blocks.push({
      path: rel,
      search: lines.slice(i + 1, mid).join("\n"),
      replace: lines.slice(mid + 1, close).join("\n"),
      start,
      end: (offsets[endLine] ?? 0) + (lines[endLine]?.length ?? 0),
    });
    lastPath = rel;
    i = close;
  }
  return { blocks, unfinished };
}

export interface BlockCalls {
  calls: ToolCall[];
  /** The reply without the blocks that became calls. */
  rest: string;
  /** Labelled whole-file blocks for files that exist: not saved (they would lose the rest). */
  existing: string[];
  /** SEARCH/REPLACE blocks left unfinished (no ======= or >>>>>>> REPLACE line, or no path). */
  unfinished: number;
}

/**
 * The tool calls a reply's file blocks stand for, in order: SEARCH/REPLACE blocks become
 * edit_file (several for the same file in a row are one call), append_file or write_file;
 * with `newFiles`, labelled blocks for new files become write_file. Only tools in `toolNames`
 * are used.
 */
export function blockCalls(
  text: string,
  root: string,
  toolNames: string[],
  opts: { newFiles?: boolean } = {},
): BlockCalls {
  const can = new Set(toolNames);
  const none: BlockCalls = { calls: [], rest: text, existing: [], unfinished: 0 };
  if (!can.has("write_file") && !can.has("edit_file")) return none;
  const { blocks, unfinished } = searchReplaceBlocks(text);
  const made = new Set<string>();
  const exists = (rel: string) => made.has(rel) || fs.existsSync(path.join(root, rel));
  type Item = { at: number; name: string; args: Record<string, unknown> };
  const items: Item[] = [];
  const cut: { start: number; end: number }[] = [];
  for (const b of blocks) {
    const empty = !b.search.trim();
    if (empty) {
      const there = exists(b.path);
      const tool = there ? "append_file" : "write_file";
      if (!can.has(tool) || !b.replace.trim()) continue;
      items.push({
        at: b.start,
        name: tool,
        args: { path: b.path, content: b.replace.endsWith("\n") ? b.replace : `${b.replace}\n` },
      });
      made.add(b.path);
    } else {
      if (!can.has("edit_file")) continue;
      const prev = items.at(-1);
      const edit = { search: b.search, replace: b.replace };
      if (prev?.name === "edit_file" && prev.args.path === b.path)
        (prev.args.edits as { search: string; replace: string }[]).push(edit);
      else items.push({ at: b.start, name: "edit_file", args: { path: b.path, edits: [edit] } });
    }
    cut.push({ start: b.start, end: b.end });
  }
  // Whole new files in labelled fences (outside the SEARCH/REPLACE blocks).
  const existing = new Set<string>();
  if (can.has("write_file") && opts.newFiles !== false) {
    for (const cb of codeBlocks(text)) {
      if (!cb.closed || !isCode(cb) || cut.some((c) => cb.start >= c.start && cb.start < c.end)) continue;
      if (cb.body.split("\n").filter((l) => l.trim()).length < 2) continue;
      const label = blockLabel(text, cb);
      if (!label || !isWholeFile(label.body)) continue;
      if (fs.existsSync(path.join(root, label.path)) && !made.has(label.path)) {
        existing.add(label.path);
        continue;
      }
      if (made.has(label.path)) continue;
      const content = label.body.endsWith("\n") ? label.body : `${label.body}\n`;
      items.push({ at: cb.start, name: "write_file", args: { path: label.path, content } });
      made.add(label.path);
      // The line above that only names the file goes with it.
      const above = text.slice(0, cb.start).replace(/\s+$/, "");
      const lineStart = above.lastIndexOf("\n") + 1;
      const only = above
        .slice(lineStart)
        .replace(/^[#>*\s-]+|[*:`\s]+$/g, "")
        .replace(/^`/, "");
      cut.push({ start: only === label.path ? lineStart : cb.start, end: cb.end });
    }
  }
  if (!items.length) return { ...none, existing: [...existing], unfinished };
  items.sort((a, b) => a.at - b.at);
  const calls: ToolCall[] = items.map((it, i) => ({
    id: `block_${i + 1}`,
    name: it.name,
    arguments: it.args,
    rawArguments: JSON.stringify(it.args),
  }));
  let rest = "";
  let from = 0;
  for (const c of cut.sort((a, b) => a.start - b.start)) {
    if (c.start < from) continue;
    rest += text.slice(from, c.start);
    from = Math.max(from, c.end);
  }
  rest += text.slice(from);
  return { calls, rest: rest.replace(/\n{3,}/g, "\n\n").trim(), existing: [...existing], unfinished };
}

/** One line per call for the model, after Depo ran its file blocks. */
export function blockResults(results: { call: ToolCall; content: string; isError: boolean }[]): string {
  const lines = results.map(({ call, content, isError }) => {
    const p = (call.arguments as { path?: string } | null)?.path ?? "";
    return `- ${call.name} ${p}: ${isError ? "FAILED. " : ""}${content}`;
  });
  const failed = results.some((r) => r.isError);
  return [
    "Depo ran your file blocks:",
    ...lines,
    failed
      ? "Fix what failed: for a SEARCH that was not found, read the file again with read_file and copy the exact lines."
      : "Go on with the next step.",
  ].join("\n");
}

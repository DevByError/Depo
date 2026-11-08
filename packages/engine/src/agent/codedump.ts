import fs from "node:fs";
import path from "node:path";
import { looksLikeToolCall } from "./textcalls";

/**
 * Code written as chat text. Small models often paste whole files into their reply ("Here is the
 * updated app.ts: ```ts …```") instead of saving them with write_file, so nothing changes in the
 * project; on a slow card such a reply can run for an hour. Depo stops a reply like that early,
 * saves the complete files it labelled with a path (through write_file, so the usual checks and
 * the activity feed apply), and tells the model to save files with its tools.
 */

/** A reply this long with a big code block and no tool call is stopped while it streams. */
export const DUMP_CHARS = 3000;
/** Lines inside one code block that make it a dump (while streaming / in a final answer). */
const STREAM_LINES = 15;
const FINAL_LINES = 8;

const SHELL =
  /^(bash|sh|shell|zsh|console|terminal|powershell|ps1?|pwsh|cmd|bat|batch|text|txt|plaintext|output|log)$/i;

export interface Block {
  /** The fence's info string (language and anything after it). */
  info: string;
  body: string;
  closed: boolean;
  /** Where the opening fence starts. */
  start: number;
  /** Where the closing fence ends (the end of the text while the block is open). */
  end: number;
}

/** The fenced code blocks of a text, the last one possibly still open. */
export function codeBlocks(text: string): Block[] {
  const out: Block[] = [];
  const fence = /^[ \t]*(```+|~~~+)[ \t]*([^\n`]*)$/gm;
  let open: { mark: string; info: string; start: number; bodyStart: number } | null = null;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const mark = m[1] ?? "```";
    if (!open) {
      open = { mark, info: (m[2] ?? "").trim(), start: m.index, bodyStart: m.index + m[0].length + 1 };
    } else if (mark[0] === open.mark[0] && mark.length >= open.mark.length && !(m[2] ?? "").trim()) {
      out.push({
        info: open.info,
        body: text.slice(open.bodyStart, m.index),
        closed: true,
        start: open.start,
        end: m.index + m[0].length,
      });
      open = null;
    }
  }
  if (open)
    out.push({
      info: open.info,
      body: text.slice(open.bodyStart),
      closed: false,
      start: open.start,
      end: text.length,
    });
  return out;
}

function lines(body: string): number {
  return body.split("\n").filter((l) => l.trim()).length;
}

export function isCode(b: Block): boolean {
  const lang = b.info.split(/[\s:{]/)[0] ?? "";
  return !SHELL.test(lang);
}

/**
 * While streaming: a long reply with a big code block and no tool call in it. File blocks Depo
 * saves (SEARCH/REPLACE edits, a new file under its path) are not a dump; with `root`, a block
 * labelled with the path of a file that does not exist yet counts as such a new file.
 */
export function dumpInProgress(streamed: string, toolNames: string[], root?: string): boolean {
  if (streamed.length < DUMP_CHARS) return false;
  if (looksLikeToolCall(streamed, toolNames) || /<tool_call>|<function_call>/i.test(streamed)) return false;
  if (/^[ \t]*<{5,9}[ \t]*SEARCH\b/im.test(streamed)) return false;
  return codeBlocks(streamed).some((b) => {
    if (!isCode(b) || lines(b.body) < STREAM_LINES) return false;
    if (!root) return true;
    const label = blockLabel(streamed, b);
    return !label || fs.existsSync(path.join(root, label.path));
  });
}

/** A finished reply (no tool call) that carries code meant for a file. */
export function isCodeDump(text: string): boolean {
  return codeBlocks(text).some((b) => b.closed && isCode(b) && lines(b.body) >= FINAL_LINES);
}

/** Code that leaves parts out ("// ... rest of the code"), so it cannot replace a whole file. */
const PLACEHOLDER = [
  // A comment that starts with "..." or a line that is only "...".
  /^\s*(\/\/|#|\/\*|<!--|--|\{\/\*)\s*\.\.\./m,
  /^\s*\.\.\.\s*$/m,
  // A comment that says something was left out.
  /^\s*(\/\/|#|\/\*|<!--|--|\{\/\*|\*)[^\n]*\b(rest of (the |your )?\w+|existing (code|routes|imports|logic|\w+ code)|same as (before|above)|unchanged|omitted|(goes|go) here|your (code|logic) here|add (your|more|other) |keep (the )?(rest|existing)|previous code)/im,
];

// Folders may be Next.js dynamic segments ([id], [...slug]) or route groups ((shop)).
const DIR = String.raw`(?:(?:[\w@.[\]-]+|\([\w-]+\))\/)*`;
const PATH = new RegExp(
  String.raw`(?:^|[\s\`*'"(:])(${DIR}[\w@.-]*[\w-]\.[A-Za-z0-9]{1,10}|${DIR}(?:Dockerfile|Makefile|Procfile))(?=$|[\s\`*'"):,])`,
  "g",
);

export function pathIn(line: string): string | null {
  let last: string | null = null;
  for (const m of line.matchAll(PATH)) {
    const p = m[1] ?? "";
    // A version number or a sentence end ("v1.2", "e.g.") is not a file.
    if (/^\d+(\.\d+)+$/.test(p) || /^(e\.g|i\.e|etc)\./i.test(p)) continue;
    last = p;
  }
  return last;
}

export function safe(rel: string): string | null {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) return null;
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(p)) return null;
  return p;
}

/**
 * The path a code block is labelled with, and its body without a path comment: in the fence
 * (```ts be/src/app.ts), on the first line as a comment (// be/src/app.ts) or on the line just
 * before the block (**be/app.ts**, `be/app.ts`:, ### be/app.ts). Null when it names none.
 */
export function blockLabel(text: string, b: Block): { path: string; body: string } | null {
  let body = b.body;
  let rel: string | null = null;
  const meta = b.info.replace(/^[\w+#-]*[\s:]*/, "").replace(/^(title|file|filename|path)=/i, "");
  if (meta) rel = pathIn(` ${meta.replace(/["']/g, "")} `);
  if (!rel) {
    const first = body.split("\n", 1)[0] ?? "";
    const m =
      /^\s*(?:\/\/|#|--|\/\*|<!--|\{\/\*)\s*(?:file(?:name)?:\s*)?(\S+?)\s*(?:\*\/|-->|\*\/\})?\s*$/i.exec(
        first,
      );
    if (m?.[1] && pathIn(` ${m[1]} `)) {
      rel = pathIn(` ${m[1]} `);
      body = body.slice(first.length + 1);
    }
  }
  if (!rel) {
    const before = text.slice(0, b.start).split("\n").slice(-3).reverse();
    for (const l of before) {
      if (!l.trim()) continue;
      rel = pathIn(l);
      break;
    }
  }
  const p = rel ? safe(rel) : null;
  return p ? { path: p, body } : null;
}

/** Code that is complete enough to be a whole file (no "// ... rest of the code"). */
export function isWholeFile(body: string): boolean {
  return !PLACEHOLDER.some((re) => re.test(body));
}

/**
 * The complete files a code dump labels with a path (see blockLabel). Blocks that leave parts
 * out, shell commands and blocks still open are skipped. Only new files are saved: a block for a
 * file that exists is usually just the part the model meant to add or change (new tables without
 * the old ones, a route file for another framework), so saving it would lose the rest; those
 * paths come back in `existing`.
 */
export function filesFromDump(
  text: string,
  root: string,
): { files: { path: string; content: string }[]; existing: string[] } {
  const found = new Map<string, string>();
  const existing = new Set<string>();
  for (const b of codeBlocks(text)) {
    if (!b.closed || !isCode(b) || lines(b.body) < 3) continue;
    const label = blockLabel(text, b);
    if (!label || !isWholeFile(label.body)) continue;
    const content = label.body.endsWith("\n") ? label.body : `${label.body}\n`;
    if (fs.existsSync(path.join(root, label.path))) {
      existing.add(label.path);
      continue;
    }
    found.set(label.path, content);
  }
  return { files: [...found].map(([p, content]) => ({ path: p, content })), existing: [...existing] };
}

/**
 * What the model reads after a reply that pasted code instead of saving it. With `blocks`, the
 * model was taught file blocks, so it is told to use those.
 */
export function dumpNudge(saved: string[], existing: string[], stopped: boolean, blocks = false): string {
  const parts = [
    stopped
      ? "Depo stopped your reply because you were pasting code into it. The owner cannot use code in a chat reply."
      : "You pasted code into your answer instead of saving it. The owner cannot use code in a chat reply.",
  ];
  if (saved.length)
    parts.push(`Depo saved the new files you named (${saved.join(", ")}) for you; see the results above.`);
  if (existing.length)
    parts.push(
      `Not saved: ${existing.join(", ")} already ${existing.length === 1 ? "exists" : "exist"}. Read ${existing.length === 1 ? "it" : "each one"} with read_file and change only what is needed with ${blocks ? "a SEARCH/REPLACE block under its path" : "edit_file"}, keeping the rest of the file.`,
    );
  if (!saved.length && !existing.length) parts.push("Nothing was saved.");
  parts.push(
    blocks
      ? "From now on, write each new file as its path on one line followed by a code block with the whole file, and change an existing file with a SEARCH/REPLACE block under its path (exact lines from read_file in SEARCH). Keep your text short."
      : "From now on, create each new file with write_file (path and the whole content) and change existing files with edit_file, one call per file, and keep your text short.",
    saved.length
      ? "Continue with the rest of the work, and give a short final answer only when it is all done."
      : "Start now.",
  );
  return parts.join(" ");
}

import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@depo/model-gateway";
import { inventsToolResult } from "./textcalls";

/**
 * What the agent works on is its private copy, not the project folder the code index describes.
 * After a starting project was written into the copy, or a few turns of work, the index still
 * shows the old folder ("README.md (2 lines)"), and a small model then starts over. These helpers
 * describe the copy as it is now, and turn earlier turns into a short summary on a follow-up so the
 * model works on the new request instead of redoing the first one.
 */

const SKIP_DIRS =
  /^(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|dist|build|out|coverage|\.depo|\.venv|venv|__pycache__|\.turbo|\.cache|\.pytest_cache|\.mypy_cache|target)$/;
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|bmp|svg|woff2?|ttf|otf|eot|mp[34]|wav|zip|gz|tgz|7z|pdf|exe|dll|so|dylib|db|sqlite|lockb|wasm|class|jar|pyc)$/i;
const MAX_FILES = 3000;

export interface CopyFile {
  path: string;
  lines: number | null;
}

/** The copy's files (relative, forward slashes), skipping dependency and build folders. */
export function copyFiles(root: string, prefix = ""): CopyFile[] {
  const out: CopyFile[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.test(e.name)) walk(path.join(dir, e.name), r);
      } else if (e.isFile() && r.startsWith(prefix)) {
        out.push({ path: r, lines: countLines(path.join(dir, e.name), e.name) });
      }
    }
  };
  walk(root, "");
  return out;
}

function countLines(abs: string, name: string): number | null {
  if (BINARY.test(name) || /(^|\.)lock$|lock\.json$/.test(name)) return null;
  try {
    const st = fs.statSync(abs);
    if (st.size > 400_000) return null;
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes("\u0000")) return null;
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

const fileLine = (f: CopyFile, base = "") =>
  `${f.path.slice(base.length)}${f.lines === null ? "" : ` (${f.lines} lines)`}`;

/**
 * The copy's files grouped by top folder, trimmed to a budget: every file when it fits, else
 * sub-folders with their file counts, else top folders only.
 */
export function copyTree(root: string, budget = 3000): string {
  const files = copyFiles(root);
  if (!files.length) return "";
  const groups = new Map<string, CopyFile[]>();
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/") + 1) : "";
    groups.set(top, [...(groups.get(top) ?? []), f]);
  }
  const tops = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const render = (depth: 0 | 1 | 2) => {
    const out: string[] = [];
    for (const top of tops) {
      const list = groups.get(top) ?? [];
      if (top === "") {
        out.push(...list.map((f) => fileLine(f)));
        continue;
      }
      out.push(`${top} (${list.length} file${list.length === 1 ? "" : "s"})`);
      if (depth === 0) continue;
      if (depth === 2) {
        out.push(...list.map((f) => `  ${fileLine(f, top)}`));
        continue;
      }
      // Files directly in the folder, then each sub-folder with a count.
      const subs = new Map<string, number>();
      for (const f of list) {
        const rest = f.path.slice(top.length);
        if (rest.includes("/")) {
          const sub = rest.slice(0, rest.indexOf("/") + 1);
          subs.set(sub, (subs.get(sub) ?? 0) + 1);
        } else out.push(`  ${fileLine(f, top)}`);
      }
      for (const [sub, n] of subs) out.push(`  ${sub} (${n} file${n === 1 ? "" : "s"})`);
    }
    return out.join("\n");
  };
  for (const depth of [2, 1, 0] as const) {
    const text = render(depth);
    if (text.length <= budget || depth === 0) return text.slice(0, Math.max(budget, 200));
  }
  return "";
}

/** Top-level declarations of a file the index has not seen (a quick look, not a parser). */
function declarations(abs: string): string[] {
  let text = "";
  try {
    if (fs.statSync(abs).size > 400_000) return [];
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 12; i++) {
    const l = lines[i] ?? "";
    if (
      /^(export\s+(default\s+)?)?(async\s+)?(function\*?|class|interface|type|enum)\s+[A-Za-z_$]/.test(l) ||
      /^export\s+(const|let)\s+[A-Za-z_$]/.test(l) ||
      /^(async\s+)?def\s+\w+|^class\s+\w+/.test(l)
    )
      out.push(
        `  ${i + 1}: ${l
          .trim()
          .replace(/\s*\{\s*$/, "")
          .slice(0, 100)}`,
      );
  }
  return out;
}

/**
 * The index's repo map corrected for the copy: files the copy no longer has are left out, files
 * only the copy has are added with their top-level declarations. `indexed` is the index's map with
 * a large budget (blocks of "path (N lines)" followed by indented symbol lines).
 */
export function copyRepoMap(root: string, indexed: string, budget = 4000, prefix = ""): string {
  const lines = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of indexed.split("\n")) {
    const head = /^(\S.*?) \(\d+ lines\)$/.exec(line);
    if (head?.[1]) {
      current = [line];
      lines.set(head[1], current);
    } else if (current && /^\s/.test(line)) current.push(line);
    else current = null;
  }
  const blocks = new Map([...lines].map(([k, v]) => [k, v.join("\n")]));
  const out: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const f of copyFiles(root, prefix)) {
    const block =
      blocks.get(f.path) ??
      (f.lines === null ? "" : [fileLine(f), ...declarations(path.join(root, f.path))].join("\n"));
    if (!block) continue;
    if (used + block.length > budget) {
      skipped++;
      continue;
    }
    out.push(block);
    used += block.length + 1;
  }
  if (skipped) out.push(`(${skipped} more files not shown; use list_dir, find_files or search)`);
  return out.join("\n");
}

/** Is the last message a new request after earlier work in the same task? */
export function isFollowUp(history: ChatMessage[]): boolean {
  const last = history.at(-1);
  if (last?.role !== "user") return false;
  return history.slice(0, -1).some((m) => m.role === "assistant");
}

const DEPO_PROMPT =
  /^(Depo tried to run your work|Note from the owner while you work|Notes from the owner while you work)/;

/**
 * On a follow-up, the earlier turns (requests, tool calls, results, answers) become one short
 * summary, followed by the files in the copy now and the new request, so a small model builds on
 * what exists instead of starting the first request again. The stored transcript is unchanged.
 */
export function compactEarlierTurns(
  history: ChatMessage[],
  o: { tree: string; brief?: string },
): ChatMessage[] {
  if (!isFollowUp(history)) return history;
  const system = history[0]?.role === "system" ? [history[0]] : [];
  const earlier = history.slice(system.length, -1);
  const latest = history.at(-1) as ChatMessage;
  const brief = o.brief?.trim() ?? "";
  const items: string[] = [];
  let hadBrief = false;
  let pending: string | null = null;
  let answer = "";
  const flush = () => {
    if (pending === null) return;
    items.push(`- Request: ${pending}${answer ? `\n  Result: ${answer}` : ""}`);
    pending = null;
    answer = "";
  };
  for (const m of earlier) {
    if (m.role === "user") {
      if (DEPO_PROMPT.test(m.content)) continue;
      flush();
      let text = m.content;
      if (brief && text.includes(brief)) {
        hadBrief = true;
        text = text.replace(brief, "");
      }
      pending = oneLine(text, 400);
    } else if (m.role === "assistant" && !m.toolCalls?.length && m.content.trim()) {
      if (inventsToolResult(m.content)) continue;
      answer = oneLine(m.content, 500);
    }
  }
  flush();
  let request = latest.content;
  if (brief && request.includes(brief)) {
    hadBrief = true;
    request = request.replace(brief, "").trim();
  }
  const parts = [
    "Earlier in this task (already done; the results are in your copy):",
    items.join("\n") || "- (earlier work)",
    o.tree ? `\nFiles in your copy now:\n${o.tree}` : "",
    hadBrief ? `\nDesign reference (still applies):\n${brief}` : "",
    `\nNew request, do this now: ${request}`,
    "\nBuild on the files that are already there: read the files involved, then change them with edit_file (or write_file for new files). Do not start over and do not recreate folders or files that exist.",
  ];
  return [...system, { role: "user", content: parts.filter(Boolean).join("\n") }];
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

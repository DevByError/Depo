import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORES, isBinary } from "../tools/fs-tools";
import { findRg } from "../tools/search";

/** One line that contains the query. */
export interface ContentHit {
  path: string;
  line: number;
  text: string;
}

export interface ContentSearchOptions {
  /** Stop after this many hits (the caller ranks them and keeps the best few). */
  max: number;
  signal: AbortSignal;
  /** Every hit as it is found, so a caller that runs out of time keeps what was found. */
  onHit: (hit: ContentHit) => void;
  /** Files to scan when ripgrep is not available. */
  files: () => Promise<string[]>;
  /** Test hook: do not use ripgrep even when it is installed. */
  noRipgrep?: boolean;
}

const MAX_LINE = 300;
const MAX_FILE = 1024 * 1024;

/** Upper case in the query makes the search case-sensitive (like ripgrep's --smart-case). */
export function smartCase(query: string): boolean {
  return query !== query.toLowerCase();
}

/**
 * Fast full-text search for a literal string: ripgrep when it is there (honours .gitignore,
 * skips binary and big files), otherwise a built-in scanner over the project's file list.
 * Stops when `max` hits are found or the signal aborts; returns whether it stopped early.
 */
export async function contentSearch(
  root: string,
  query: string,
  o: ContentSearchOptions,
): Promise<{ stoppedEarly: boolean; engine: "ripgrep" | "builtin" }> {
  const rg = o.noRipgrep ? null : findRg();
  if (rg) {
    const stopped = await ripgrep(rg, root, query, o);
    if (stopped !== null) return { stoppedEarly: stopped, engine: "ripgrep" };
  }
  return { stoppedEarly: await builtin(root, query, o), engine: "builtin" };
}

/** null = ripgrep could not run; the caller falls back to the built-in scanner. */
async function ripgrep(
  rg: string,
  root: string,
  query: string,
  o: ContentSearchOptions,
): Promise<boolean | null> {
  const args = [
    rg,
    "--json",
    "--fixed-strings",
    "--smart-case",
    "--max-count",
    "3",
    "--max-columns",
    "400",
    "--max-filesize",
    "1M",
    "--sort",
    "path",
  ];
  for (const d of DEFAULT_IGNORES) args.push("-g", `!${d}`);
  args.push("-e", query, "--", ".");
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    proc = Bun.spawn(args, {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    return null;
  }
  let found = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  if (o.signal.aborted) stop();
  o.signal.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
        if (!line.startsWith('{"type":"match"')) continue;
        try {
          const j = JSON.parse(line) as {
            data: { path: { text?: string }; line_number: number; lines: { text?: string } };
          };
          const p = (j.data.path.text ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
          if (!p) continue;
          o.onHit({
            path: p,
            line: j.data.line_number,
            text: (j.data.lines.text ?? "").trim().slice(0, MAX_LINE),
          });
          found++;
        } catch {
          // a line cut by the column limit; skip it
        }
        if (found >= o.max && !stopped) stop();
      }
      if (stopped) break;
    }
  } catch {
    // the pipe closed when the process was killed
  }
  const code = await proc.exited;
  o.signal.removeEventListener("abort", stop);
  // 0 = matches, 1 = none; 2 = an error (unreadable files are reported as 2 too, with output).
  if (!stopped && code === 2 && found === 0) return null;
  return stopped;
}

async function builtin(root: string, query: string, o: ContentSearchOptions): Promise<boolean> {
  const sensitive = smartCase(query);
  const needle = sensitive ? query : query.toLowerCase();
  const files = await o.files();
  let found = 0;
  for (let i = 0; i < files.length; i++) {
    if (o.signal.aborted) return true;
    // Let timers run (the caller's time budget) while scanning a big project.
    if (i % 40 === 39) await new Promise((r) => setImmediate(r));
    const rel = files[i] as string;
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    if (!(sensitive ? text : text.toLowerCase()).includes(needle)) continue;
    const lines = text.split(/\r?\n/);
    let inFile = 0;
    for (let n = 0; n < lines.length && inFile < 3; n++) {
      const l = lines[n] as string;
      if (!(sensitive ? l : l.toLowerCase()).includes(needle)) continue;
      o.onHit({ path: rel, line: n + 1, text: l.trim().slice(0, MAX_LINE) });
      inFile++;
      found++;
      if (found >= o.max) return true;
    }
  }
  return false;
}

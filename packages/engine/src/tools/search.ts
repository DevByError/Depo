import fs from "node:fs";
import path from "node:path";
import { runCommand } from "../hardware/run";
import { DEFAULT_IGNORES, isBinary } from "./fs-tools";
import { resolveInside, ToolError, toRel } from "./paths";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  /** Regular expression (Rust/JS compatible subset), or a literal when `literal` is set. */
  pattern: string;
  literal?: boolean;
  /** Folder or file to search, relative to the root. */
  path?: string;
  /** Glob on the file path, e.g. `*.py` or `src/**\/*.ts`. */
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

const MAX_LINE = 300;
const MAX_FILE_BYTES = 1024 * 1024;

/** Files in the project, honouring .gitignore when it is a git repository. */
export async function listProjectFiles(root: string): Promise<string[]> {
  if (fs.existsSync(path.join(root, ".git"))) {
    const out = await runCommand(["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"], 20_000);
    if (out !== null) return out.split("\0").filter((f) => f.length > 0 && fs.existsSync(path.join(root, f)));
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!DEFAULT_IGNORES.has(it.name)) walk(full);
      } else if (it.isFile()) files.push(toRel(root, full));
      if (files.length > 50_000) return;
    }
  };
  walk(root);
  return files;
}

/** Minimal glob → RegExp: `**` any folders, `*` within a segment, `?` one char, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob.replace(/\\/g, "/");
  while (i < g.length) {
    const c = g[i] as string;
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 3 : 2;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      const alts = g
        .slice(i + 1, end)
        .split(",")
        .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&"));
      re += `(?:${alts.join("|")})`;
      i = end + 1;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  // A pattern without a slash matches the file name in any folder.
  return new RegExp(g.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

/** Search file contents. Uses ripgrep when available, otherwise a built-in scanner. */
export async function searchTool(
  root: string,
  opts: SearchOptions,
): Promise<{ matches: SearchMatch[]; truncated: boolean; engine: string }> {
  const max = Math.min(opts.maxResults ?? 100, 500);
  const scope = resolveInside(root, opts.path ?? ".");
  let re: RegExp;
  try {
    const src = opts.literal ? opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : opts.pattern;
    re = new RegExp(src, opts.caseSensitive === false ? "i" : "");
  } catch (err) {
    throw new ToolError(`Invalid search pattern: ${(err as Error).message}`);
  }
  const rg = await ripgrep(root, scope.rel, opts, max);
  if (rg) return { ...rg, engine: "ripgrep" };

  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  const prefix = scope.rel === "." ? "" : scope.rel;
  const files = (await listProjectFiles(root)).filter(
    (f) => (!prefix || f === prefix || f.startsWith(`${prefix}/`)) && (!globRe || globRe.test(f)),
  );
  const matches: SearchMatch[] = [];
  for (const f of files.sort()) {
    const abs = path.join(root, f);
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (re.test(line)) {
        matches.push({ path: f, line: i + 1, text: line.trim().slice(0, MAX_LINE) });
        if (matches.length >= max) return { matches, truncated: true, engine: "builtin" };
      }
    }
  }
  return { matches, truncated: false, engine: "builtin" };
}

let rgPath: string | null | undefined;
/** ripgrep's path (next to the engine, DEPO_RG_PATH, or on PATH), or null. Cached. */
export function findRg(): string | null {
  if (rgPath !== undefined) return rgPath;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [
    process.env.DEPO_RG_PATH,
    path.join(path.dirname(process.execPath), exe),
    Bun.which("rg") ?? undefined,
  ].filter((c): c is string => !!c);
  rgPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  return rgPath;
}

async function ripgrep(
  root: string,
  scopeRel: string,
  opts: SearchOptions,
  max: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean } | null> {
  const rg = findRg();
  if (!rg) return null;
  const args = [rg, "--json", "--max-columns", "400", "--max-filesize", "1M", "-g", "!.git", "-g", "!.depo"];
  if (opts.literal) args.push("-F");
  if (opts.caseSensitive === false) args.push("-i");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("-e", opts.pattern, "--", scopeRel === "." ? "." : scopeRel);
  const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code === 2) {
    const err = await new Response(proc.stderr).text();
    if (/regex parse error|error parsing/i.test(err))
      throw new ToolError(`Invalid search pattern: ${err.trim().slice(0, 300)}`);
    return null;
  }
  const matches: SearchMatch[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith('{"type":"match"')) continue;
    const j = JSON.parse(line) as {
      data: { path: { text?: string }; line_number: number; lines: { text?: string } };
    };
    const p = (j.data.path.text ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    matches.push({
      path: p,
      line: j.data.line_number,
      text: (j.data.lines.text ?? "").trim().slice(0, MAX_LINE),
    });
    if (matches.length >= max) return { matches, truncated: true };
  }
  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { matches, truncated: false };
}

/** Find files by glob. */
export async function findFilesTool(
  root: string,
  glob: string,
  limit = 200,
): Promise<{ files: string[]; truncated: boolean }> {
  const re = globToRegExp(glob);
  const all = (await listProjectFiles(root)).filter((f) => re.test(f)).sort();
  return { files: all.slice(0, limit), truncated: all.length > limit };
}

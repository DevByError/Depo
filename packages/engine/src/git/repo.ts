import type { GitCommitSummary, GitFileDiff, GitIdentity, GitStatus } from "@depo/shared";
import { type GitResult, git } from "../tools/git";

/**
 * Read-only git plumbing for the Git service: status, identity, log and one commit's diff.
 * These run git directly (no shell) with prompts off and a C locale, so their output parses
 * the same everywhere. Anything that changes the repository goes through the command policy
 * in `service.ts` instead.
 */

let available: Promise<boolean> | null = null;

/** Git is installed and runs (checked once per engine run). */
export function gitAvailable(): Promise<boolean> {
  available ??= git(process.cwd(), ["--version"], 10_000)
    .then((r) => r.ok)
    .catch(() => false);
  return available;
}

/** Git with text sent to its standard input (paths for `check-ignore --stdin`). */
export async function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
  timeoutMs = 30_000,
): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
    cwd,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, stdout, stderr, code };
}

export interface RepoInfo {
  /** The repository's top folder. */
  top: string;
  /** Where the project folder sits inside it, with a trailing slash ("" at the top). */
  prefix: string;
  /** The git folder (absolute). */
  gitDir: string;
}

/** Repository facts for a folder, or null when it is not inside a git work tree. */
export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  const r = await git(cwd, [
    "rev-parse",
    "--is-inside-work-tree",
    "--show-toplevel",
    "--show-prefix",
    "--absolute-git-dir",
  ]).catch(() => null);
  if (!r?.ok) return null;
  const [inside, top = "", prefix = "", gitDir = ""] = r.stdout.split("\n");
  if (inside?.trim() !== "true") return null;
  return { top: top.trim(), prefix: prefix.trim(), gitDir: gitDir.trim() };
}

export interface PorcelainEntry {
  /** Path relative to the folder git ran in (with `--porcelain` paths are relative to the top). */
  path: string;
  /** Two letters: index then work tree (` M`, `M `, `A `, `??`, `D `, `R `…). */
  code: string;
  origPath: string | null;
}

export interface PorcelainStatus {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  entries: PorcelainEntry[];
}

/** Parse `git status --porcelain=v1 -b -z`. Paths are relative to the repository top. */
export function parsePorcelain(out: string): PorcelainStatus {
  const parts = out.split("\0");
  let branch: string | null = null;
  let detached = false;
  let unborn = false;
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (!p) continue;
    if (p.startsWith("## ")) {
      const head = p.slice(3);
      if (head.startsWith("No commits yet on ")) {
        unborn = true;
        branch = head.slice("No commits yet on ".length).trim();
      } else if (head.startsWith("Initial commit on ")) {
        unborn = true;
        branch = head.slice("Initial commit on ".length).trim();
      } else if (head.startsWith("HEAD (no branch)")) {
        detached = true;
      } else {
        branch = head.split("...")[0]?.split(" [")[0]?.trim() || null;
      }
      continue;
    }
    const code = p.slice(0, 2);
    let origPath: string | null = null;
    if (code[0] === "R" || code[0] === "C") {
      origPath = parts[i + 1] ?? null;
      i++;
    }
    entries.push({ code, path: p.slice(3), origPath });
  }
  return { branch, detached, unborn, entries };
}

export async function porcelain(cwd: string, opts: { allUntracked?: boolean; paths?: string[] } = {}) {
  const args = ["status", "--porcelain=v1", "-b", "-z", opts.allUntracked ? "-uall" : "-unormal"];
  if (opts.paths?.length) args.push("--", ...opts.paths.map((p) => `:(literal)${p}`));
  const r = await git(cwd, args, 20_000);
  if (!r.ok) throw new Error(r.stderr.trim() || "git status failed");
  return parsePorcelain(r.stdout);
}

/** user.name and user.email as git resolves them in this folder (local, then global, then system). */
export async function readIdentity(cwd: string): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    git(cwd, ["config", "--get", "user.name"]).catch(() => null),
    git(cwd, ["config", "--get", "user.email"]).catch(() => null),
  ]);
  const n = name?.ok ? name.stdout.trim() : "";
  const e = email?.ok ? email.stdout.trim() : "";
  return n && e ? { name: n, email: e } : null;
}

/** Status for the UI: branch, how many files are not committed, and who commits. */
export async function repoStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = {
    gitAvailable: await gitAvailable(),
    isRepo: false,
    branch: null,
    detached: false,
    unborn: false,
    changes: 0,
    staged: 0,
    untracked: 0,
    entries: [],
    identity: null,
  };
  if (!empty.gitAvailable) return empty;
  const info = await repoInfo(cwd);
  if (!info) return empty;
  const [st, identity] = await Promise.all([porcelain(cwd), readIdentity(cwd)]);
  return {
    gitAvailable: true,
    isRepo: true,
    branch: st.branch,
    detached: st.detached,
    unborn: st.unborn,
    changes: st.entries.length,
    staged: st.entries.filter((e) => e.code[0] !== " " && e.code[0] !== "?").length,
    untracked: st.entries.filter((e) => e.code === "??").length,
    entries: st.entries.slice(0, 200).map((e) => ({ path: e.path, code: e.code })),
    identity,
  };
}

const RS = "\x1e";
const US = "\x1f";
const GS = "\x1d";
const LOG_FORMAT = `${RS}%H${US}%h${US}%an${US}%ae${US}%aI${US}%s${US}%b${GS}`;

function parseHeader(head: string): Omit<GitCommitSummary, "files" | "additions" | "deletions"> | null {
  const [hash = "", shortHash = "", author = "", email = "", date = "", subject = "", body = ""] =
    head.split(US);
  if (!/^[0-9a-f]{7,64}$/.test(hash)) return null;
  return { hash, shortHash, author, email, date, subject, body: body.trim() };
}

function countNumstat(lines: string[]): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (!m) continue;
    files++;
    if (m[1] !== "-") additions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  return { files, additions, deletions };
}

/** Parse `git log --format=LOG_FORMAT --numstat`. */
export function parseLog(out: string): GitCommitSummary[] {
  const commits: GitCommitSummary[] = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const end = rec.indexOf(GS);
    const head = parseHeader(end >= 0 ? rec.slice(0, end) : rec);
    if (!head) continue;
    const stats = countNumstat((end >= 0 ? rec.slice(end + 1) : "").split("\n"));
    commits.push({ ...head, ...stats });
  }
  return commits;
}

/** The newest commits on the current branch (empty for a repository without commits). */
export async function commitLog(cwd: string, limit: number): Promise<GitCommitSummary[]> {
  const r = await git(
    cwd,
    ["log", `-n${limit}`, `--format=${LOG_FORMAT}`, "--numstat", "-M", "--no-ext-diff"],
    20_000,
  );
  if (!r.ok) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(r.stderr)) return [];
    throw new Error(r.stderr.trim() || "git log failed");
  }
  return parseLog(r.stdout);
}

/** Undo git's C-style quoting of unusual file names (`"tab\there.txt"`). */
export function cUnquote(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = inner[i + 1] ?? "";
    const simple: Record<string, number> = {
      n: 10,
      t: 9,
      r: 13,
      '"': 34,
      "\\": 92,
      a: 7,
      b: 8,
      f: 12,
      v: 11,
    };
    if (n in simple) {
      bytes.push(simple[n] as number);
      i++;
    } else if (/[0-7]/.test(n)) {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(Number.parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function diffPath(raw: string): string | null {
  const s = cUnquote(raw.replace(/\t$/, ""));
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
}

/** The new path from a `diff --git a/<old> b/<new>` header (names may have spaces or be quoted). */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === "\\" ? 2 : 1;
    const second = rest.slice(i + 2);
    return diffPath(second) ?? second;
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && rest.slice(2, 2 + len) === rest.slice(5 + len)) return rest.slice(2, 2 + len);
  const at = rest.lastIndexOf(" b/");
  if (at >= 0) return diffPath(rest.slice(at + 1)) ?? rest;
  // Combined diff (merge): just the path.
  return cUnquote(rest);
}

export interface DiffCaps {
  /** Lines of diff kept per file. */
  perFile: number;
  /** Lines of diff kept in total. */
  total: number;
  /** Files listed at most. */
  files: number;
}

const DEFAULT_CAPS: DiffCaps = { perFile: 1500, total: 6000, files: 300 };

/** Parse unified diff output (`git show`, `git diff`) into files and hunks, with caps. */
export function parseUnifiedDiff(text: string, caps: DiffCaps = DEFAULT_CAPS): GitFileDiff[] {
  const files: GitFileDiff[] = [];
  let cur: GitFileDiff | null = null;
  let hunk: GitFileDiff["hunks"][number] | null = null;
  let kept = 0;
  let fileLines = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      if (files.length >= caps.files) break;
      cur = {
        path: headerPath(line.replace(/^diff --(git|cc) /, "")),
        oldPath: null,
        kind: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        truncated: false,
      };
      hunk = null;
      fileLines = 0;
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) cur.kind = "added";
      else if (line.startsWith("deleted file mode")) cur.kind = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.kind = "renamed";
        cur.oldPath = cUnquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) cur.path = cUnquote(line.slice("rename to ".length));
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) cur.binary = true;
      else if (line.startsWith("--- ")) {
        const p = diffPath(line.slice(4));
        if (p && cur.kind !== "renamed") cur.oldPath = p === cur.path ? null : p;
      } else if (line.startsWith("+++ ")) {
        const p = diffPath(line.slice(4));
        if (p) cur.path = p;
      }
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      };
      if (fileLines < caps.perFile && kept < caps.total) cur.hunks.push(hunk);
      else cur.truncated = true;
      continue;
    }
    if (!hunk) continue;
    const t = line[0];
    if (t !== " " && t !== "+" && t !== "-" && t !== "\\") continue;
    if (t === "+") cur.additions++;
    if (t === "-") cur.deletions++;
    if (fileLines < caps.perFile && kept < caps.total) {
      hunk.lines.push(line);
      fileLines++;
      kept++;
    } else cur.truncated = true;
  }
  // A cut hunk keeps the lines it has; drop hunks that got none.
  for (const f of files) f.hunks = f.hunks.filter((h) => h.lines.length > 0);
  return files;
}

/** One commit with its diff against its first parent (or against nothing for the first commit). */
export async function commitShow(
  cwd: string,
  hash: string,
): Promise<{ commit: GitCommitSummary; files: GitFileDiff[] }> {
  const head = await git(cwd, ["show", "-s", `--format=${LOG_FORMAT}`, hash], 15_000);
  if (!head.ok) throw new Error(head.stderr.trim() || `Unknown commit ${hash}`);
  const parsed = parseHeader(head.stdout.replace(RS, "").split(GS)[0] ?? "");
  if (!parsed) throw new Error(`Unknown commit ${hash}`);
  const base = ["show", "--format=", "-M", "--patch", "--no-ext-diff", "--no-color"];
  let diff = await git(cwd, [...base, "--diff-merges=first-parent", parsed.hash], 30_000);
  // Git older than 2.31 does not know --diff-merges.
  if (!diff.ok && /diff-merges/.test(diff.stderr))
    diff = await git(cwd, [...base, "-m", "--first-parent", parsed.hash], 30_000);
  if (!diff.ok) throw new Error(diff.stderr.trim() || "git show failed");
  const files = parseUnifiedDiff(diff.stdout);
  return {
    commit: {
      ...parsed,
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    files,
  };
}

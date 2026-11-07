/** Read-only git helpers for agents and the UI. Changes to history go through the shell policy. */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
    cwd,
    stdin: "ignore",
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return r?.ok === true && r.stdout.trim() === "true";
}

export interface GitStatusEntry {
  path: string;
  /** Two-letter porcelain code, e.g. ` M`, `??`, `A `. */
  code: string;
}

export async function gitStatus(cwd: string): Promise<{ branch: string | null; entries: GitStatusEntry[] }> {
  const r = await git(cwd, ["status", "--porcelain=v1", "-b", "-z"]);
  if (!r.ok) throw new Error(r.stderr.trim() || "git status failed");
  const parts = r.stdout.split("\0").filter(Boolean);
  let branch: string | null = null;
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p.startsWith("## ")) {
      branch =
        p
          .slice(3)
          .split("...")[0]
          ?.replace(/^No commits yet on /, "") ?? null;
      continue;
    }
    const code = p.slice(0, 2);
    entries.push({ code, path: p.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++; // skip the original name
  }
  return { branch, entries };
}

export async function gitLog(
  cwd: string,
  limit = 20,
): Promise<{ hash: string; date: string; subject: string }[]> {
  const r = await git(cwd, ["log", `-n${limit}`, "--format=%h%x1f%cI%x1f%s"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash = "", date = "", subject = ""] = l.split("\x1f");
      return { hash, date, subject };
    });
}

export async function gitDiff(cwd: string, paths: string[] = [], staged = false): Promise<string> {
  const r = await git(cwd, ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--", ...paths]);
  return r.ok ? r.stdout : "";
}

/**
 * How many of the last `maxCommits` commits touched each file, with paths relative to `cwd` (a
 * project inside a bigger repository only counts its own files). Read-only and bounded: merges and
 * bulk commits (over 100 files, such as formatting or renames) are skipped, and a slow repository
 * gives up after `timeoutMs` with an empty result.
 */
export async function gitFileChurn(
  cwd: string,
  maxCommits = 400,
  timeoutMs = 8000,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const r = await git(
    cwd,
    ["log", `-n${maxCommits}`, "--no-merges", "--name-only", "--relative", "--format=%x1e", "--", "."],
    timeoutMs,
  ).catch(() => null);
  if (!r?.ok) return counts;
  for (const record of r.stdout.split("\x1e")) {
    const files = record
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length === 0 || files.length > 100) continue;
    for (const f of files) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

/** Branch, uncommitted files and ahead/behind counts, from one `git status`. */
export async function gitSummary(
  cwd: string,
): Promise<{ branch: string | null; changed: number; ahead: number; behind: number } | null> {
  const r = await git(cwd, ["status", "--porcelain=v1", "-b"], 10_000).catch(() => null);
  if (!r?.ok) return null;
  const lines = r.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? (lines.shift() ?? "").slice(3) : "";
  const branch = head
    ? (head
        .split("...")[0]
        ?.replace(/^No commits yet on /, "")
        .trim() ?? null)
    : null;
  return {
    branch: branch && !branch.startsWith("HEAD (no branch)") ? branch : null,
    changed: lines.length,
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
  };
}

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

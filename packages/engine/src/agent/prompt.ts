import fs from "node:fs";
import path from "node:path";

/** What kind of project this is, so the agent knows how to run its tests. */
export function detectProject(root: string): { kind: string; testCommand: string | null; notes: string[] } {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const notes: string[] = [];
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    const venv = [".venv", "venv"].find((d) => has(d));
    if (venv) notes.push(`A Python virtual environment is active (${venv}); "python" and "pytest" use it.`);
    return { kind: "Python", testCommand: "python -m pytest -q", notes };
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const pm =
        has("bun.lock") || has("bun.lockb")
          ? "bun"
          : has("pnpm-lock.yaml")
            ? "pnpm"
            : has("yarn.lock")
              ? "yarn"
              : "npm";
      return { kind: "JavaScript/TypeScript", testCommand: pkg.scripts?.test ? `${pm} test` : null, notes };
    } catch {
      return { kind: "JavaScript/TypeScript", testCommand: null, notes };
    }
  }
  if (has("Cargo.toml")) return { kind: "Rust", testCommand: "cargo test", notes };
  if (has("go.mod")) return { kind: "Go", testCommand: "go test ./...", notes };
  return { kind: "unknown", testCommand: null, notes };
}

/** Environment so commands use the project's virtual environment when it has one. */
export function venvEnv(root: string): Record<string, string> {
  const dir = [".venv", "venv"].map((d) => path.join(root, d)).find((d) => fs.existsSync(d));
  if (!dir) return {};
  const bin = path.join(dir, process.platform === "win32" ? "Scripts" : "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { VIRTUAL_ENV: dir, [pathKey]: `${bin}${sep}${process.env[pathKey] ?? ""}` };
}

export function topLevelListing(root: string): string {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".git") && d.name !== "node_modules" && d.name !== "__pycache__")
      .slice(0, 60)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .join("  ");
  } catch {
    return "";
  }
}

export function codingSystemPrompt(opts: { projectName: string; root: string }): string {
  const info = detectProject(opts.root);
  const win = process.platform === "win32";
  const lines = [
    "You are Depo's coding agent. You work inside a private copy of the user's project (the workspace).",
    "Nothing you do touches the user's real files. When you finish, the user reviews a diff of your changes and decides what to apply.",
    "",
    `Project: ${opts.projectName} (${info.kind}).`,
    `Top level: ${topLevelListing(opts.root) || "(empty)"}`,
    `Shell: commands run with ${win ? "cmd.exe on Windows (use Windows syntax; `&&` works)" : "/bin/sh"} in the project root. There is no interactive input.`,
    ...(info.testCommand ? [`Run the tests with: ${info.testCommand}`] : []),
    ...info.notes,
    "",
    "How to work:",
    "1. Understand first: list the project, read the relevant files (only the line ranges you need), and search for related code.",
    "2. Make small, precise edits with edit_file. Copy the exact current text into `search` (without line numbers). Use write_file for new files.",
    "3. Follow the project's existing structure, style and libraries. Add a dependency only when there is no reasonable alternative.",
    "4. Add or update tests for what you change. Run the tests. If they fail, read the error, fix the cause, and run them again.",
    "5. When the work is done and the tests pass, stop calling tools and reply with a short summary: what changed, which files, and the test result.",
    "",
    "Rules: read a file before editing it; never guess its contents. Do not ask the user to copy or apply anything; the review step does that. Keep replies short and plain.",
  ];
  return lines.join("\n");
}

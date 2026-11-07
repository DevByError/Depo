import fs from "node:fs";
import path from "node:path";
import { blueprintHint } from "../blueprints/plan";
import { autoTopicsPrompt, corePrompt } from "../playbooks";
import { detectStack, stackSummary } from "./stack";

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

/** Case-insensitive name order (like Explorer), then exact, so ties never depend on the disk. */
function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function topLevelListing(root: string): string {
  try {
    return (
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => !d.name.startsWith(".git") && d.name !== "node_modules" && d.name !== "__pycache__")
        // A stable order on every file system, so the same folder gives the same prompt text.
        .sort((a, b) => byName(a.name, b.name))
        .slice(0, 60)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .join("  ")
    );
  } catch {
    return "";
  }
}

export function codingSystemPrompt(opts: {
  projectName: string;
  root: string;
  /** The model's context length in tokens: decides how much playbook text fits. */
  contextLength?: number;
  /** The user's request, to pick the relevant playbook topics. */
  request?: string;
  /** Project memory is on: tell the agent to save what it learns with the remember tool. */
  remember?: boolean;
  /** Project memory and the repo map, placed after the project facts and before the task's topics. */
  context?: string[];
}): string {
  const info = detectProject(opts.root);
  const stack = detectStack(opts.root);
  const win = process.platform === "win32";
  // Ordered for prompt caching (Ollama and llama.cpp reuse an identical prefix): what never changes
  // first (role, how to work, rules, playbook), then the project, then what depends on the task.
  const lines = [
    "You are Depo's coding agent. You work inside a private copy of the user's project (the workspace).",
    "Nothing you do touches the user's real files. When you finish, the user reviews a diff of your changes and decides what to apply.",
    "",
    "How to work:",
    "1. Understand first: code_map shows the modules and which files import which; then read the relevant files (only the line ranges you need) and search for related code.",
    "2. Make small, precise edits with edit_file. Copy the exact current text into `search` (without line numbers). Use write_file for new files.",
    "3. Follow the project's existing structure, style and libraries. Add a dependency only when there is no reasonable alternative.",
    "4. Add or update tests for what you change. Run the tests. If they fail, read the error, fix the cause, and run them again.",
    "   For an app with a server or web pages, also start it with start_preview, check the endpoints with http_check and the pages with check_page before you finish, then stop it with stop_preview.",
    "5. When the work is done and the tests pass, stop calling tools and reply with a short summary: what changed, which files, and the test result.",
    "",
    "Rules: read a file before editing it; never guess its contents. Do not ask the user to copy or apply anything; the review step does that. Keep replies short and plain.",
    "",
    corePrompt("coder"),
    ...(opts.remember
      ? [
          "",
          "When you learn something lasting about this project (a convention, a decision, a user preference), save it with the remember tool.",
        ]
      : []),
    "",
    `Shell: commands run with ${win ? "cmd.exe on Windows (use Windows syntax; `&&` works)" : "/bin/sh"} in the project root. There is no interactive input.`,
    `Project: ${opts.projectName} (${stackSummary(stack) || info.kind}).`,
    ...(info.testCommand ? [`Run the tests with: ${info.testCommand}`] : []),
    ...info.notes,
    `Top level: ${topLevelListing(opts.root) || "(empty)"}`,
    ...[blueprintHint(opts.request ?? "", opts.root)].filter(Boolean),
  ];
  for (const block of opts.context ?? []) if (block) lines.push("", block);
  const topics = autoTopicsPrompt({
    agent: "coder",
    text: opts.request ?? "",
    hints: stack.hints,
    contextLength: opts.contextLength ?? 16_384,
  });
  if (topics) lines.push("", topics);
  return lines.join("\n");
}

import fs from "node:fs";
import path from "node:path";
import { blueprintHint } from "../blueprints/plan";
import { autoTopicsPrompt, corePrompt } from "../playbooks";
import { detectStack, packageManagerFor, stackSummary } from "./stack";
import { codeFiles } from "./step-prompt";

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
      const pm = packageManagerFor(root, root, pkg as Record<string, unknown>);
      return {
        kind: "JavaScript/TypeScript",
        testCommand: pkg.scripts?.test ? (pm === "bun" ? "bun run test" : `${pm} test`) : null,
        notes,
      };
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

/**
 * Steps 1 and 2 for a small model: look with the tools, write code as file blocks (no JSON to
 * break). The loop turns the blocks into write_file, edit_file and append_file calls.
 */
export function smallModelSteps(root: string): string[] {
  const { code, fresh, lang } = exampleFiles(root);
  return [
    "1. Look first: list_dir and read_file show what is there. Read a file before you change it. Use only the tools you were given; there are no others.",
    "2. Write code as file blocks in your reply, not inside JSON. Depo saves them and tells you the result. The paths below are from this project; the code in the examples is made up, so copy real lines from the real file.",
    "   New file: its path on one line, then the whole file in a code block:",
    `   ${fresh}`,
    `   \`\`\`${lang}`,
    '   export const hello = "hi";',
    "   ```",
    "   Change a file: its path, then a SEARCH/REPLACE block. SEARCH holds a few exact lines copied from the file, REPLACE what they become:",
    `   ${code}`,
    `   \`\`\`${lang}`,
    "   <<<<<<< SEARCH",
    "   const port = 3000;",
    "   =======",
    "   const port = Number(process.env.PORT ?? 3000);",
    "   >>>>>>> REPLACE",
    "   ```",
    "   Add to the end of a file (a new table at the end of schema.sql): the same block with nothing between SEARCH and =======.",
    "   Put files where the request says, or next to the files that are already there. Never invent a folder.",
    "   For everything else call a tool (read_file, run_command, start_preview, ...), one call at a time, and wait for its result.",
  ];
}

/**
 * Paths for the examples in the prompt, taken from this project. A small model copies an example
 * literally: with `be/src/hello.ts` in the prompt it wrote its files into a `be/` folder that the
 * project did not have.
 */
export function exampleFiles(root: string): { code: string; fresh: string; lang: string } {
  const code =
    codeFiles(root, 300).find(
      (f) => /\.(ts|tsx|js|jsx|mjs|py|go|rs)$/.test(f) && !/\.(test|spec)\.|(^|\/)test_/.test(f),
    ) ?? "src/app.ts";
  const ext = /\.(\w+)$/.exec(code)?.[1] ?? "ts";
  const dir = path.posix.dirname(code);
  return { code, fresh: `${dir === "." ? "" : `${dir}/`}hello.${ext}`, lang: ext === "py" ? "python" : ext };
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
  /** A small model (4B or less): fewer tools, so a shorter "how to work", and file blocks instead of JSON for code. */
  small?: boolean;
  /** Depo runs a step plan (ADR-0086): the agent does one step at a time and Depo checks and runs the app. */
  steps?: boolean;
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
    ...(opts.small
      ? smallModelSteps(opts.root)
      : [
          "1. Understand first: code_map shows the modules and which files import which; then read the relevant files (only the line ranges you need) and search for related code.",
          "2. Make small, precise edits with edit_file. Copy the exact current text into `search` (without line numbers). Use write_file for new files; append_file adds to the end of a file.",
        ]),
    "3. Follow the project's existing structure, style and libraries. Add a dependency only when there is no reasonable alternative.",
    ...(opts.steps
      ? [
          "4. Depo gives you one step of a plan at a time. Do only that step, in the files it names; later steps come after it. Depo checks each step when you say it is done, and at the end it runs the tests, the database scripts and the app itself.",
          "5. When the step is done, stop calling tools and say in one line what you did.",
        ]
      : [
          "4. Add or update tests for what you change. Run the tests. If they fail, read the error, fix the cause, and run them again.",
          "   For an app with a server or web pages, also start it with start_preview, check the endpoints with http_check and the pages with check_page before you finish, then stop it with stop_preview.",
          "   When the app uses MySQL or MariaDB, call dev_database start: Depo runs a local test database and writes DATABASE_URL into the app's .env. Then run the app's migrate and seed scripts so it has tables and demo data. Never ask the owner to set up a database.",
          "5. When the work is done and the tests pass, stop calling tools and reply with a short summary: what changed, which files, and the test result.",
        ]),
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

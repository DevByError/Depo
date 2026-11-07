import fs from "node:fs";
import path from "node:path";
import type { Problem } from "@depo/shared";
import { venvEnv } from "../agent/prompt";
import { whichSync } from "../security/scanners";
import { DEFAULT_IGNORES } from "../tools/fs-tools";
import { LINKED_DIRS } from "../workspace/snapshot";
import {
  type ParseContext,
  parseCargoShort,
  parseCompileall,
  parseEslintStylish,
  parseGithubAnnotations,
  parseGoVet,
  parseMypy,
  parsePyrightJson,
  parseRuffJson,
  parseTsc,
} from "./parsers";

/**
 * What to check and with which tool: Depo looks at the project's files (tsconfig.json,
 * biome.json, an ESLint config, Python files, go.mod, Cargo.toml) in the root and in sub-projects
 * (frontend/, backend/, apps/*, packages/* …) and plans only tools that are already installed on
 * this PC. Nothing is ever installed. Commands avoid writing caches into the project.
 */

export type DiagToolId =
  | "tsc"
  | "biome"
  | "eslint"
  | "ruff"
  | "compileall"
  | "mypy"
  | "pyright"
  | "go vet"
  | "cargo check";

export interface PlannedTool {
  id: DiagToolId;
  /** As listed in the result: `tsc`, or `eslint (frontend)` for a sub-project. */
  label: string;
  /** Folder relative to the root ("" = root), forward slashes. */
  folder: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** null when the output could not be read at all (broken JSON). */
  parse(out: string, ctx: ParseContext): Problem[] | null;
}

export interface SkippedTool {
  tool: string;
  reason: string;
  /** True when the project uses the tool (it is configured) but it is missing or not allowed. */
  configured: boolean;
}

export interface PlanOptions {
  /** Windows command lines (default: this OS). */
  win?: boolean;
  /** Find an executable on PATH with this environment (default: whichSync). */
  find?: (exe: string, env: Record<string, string>) => string | null;
  /** Depo's folder for caches (compiled Python files, cargo builds, mypy cache). */
  cacheDir: string;
  /** Names this target's caches, e.g. `prj_1-project`. */
  cacheKey: string;
}

const MARKERS = [
  "package.json",
  "tsconfig.json",
  "biome.json",
  "biome.jsonc",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
];
const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];
const PY_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"];
const MINUTE = 60_000;

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function read(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function childDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith(".") &&
          !DEFAULT_IGNORES.has(d.name) &&
          !LINKED_DIRS.has(d.name),
      )
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** The root and its sub-projects (folders with a project file), at most 8. */
export function projectFolders(root: string): string[] {
  const out = [""];
  const hasMarker = (rel: string) => MARKERS.some((m) => exists(path.join(root, rel, m)));
  for (const name of childDirs(root)) {
    if (["apps", "packages", "services", "libs"].includes(name)) {
      for (const sub of childDirs(path.join(root, name)))
        if (hasMarker(`${name}/${sub}`)) out.push(`${name}/${sub}`);
    } else if (hasMarker(name)) out.push(name);
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

/** A tool in node_modules/.bin of the folder or the root (workspaces install there), as a command. */
function localBin(root: string, folder: string, name: string, win: boolean): string | null {
  const dirs = folder ? [folder, ""] : [""];
  for (const d of dirs) {
    for (const ext of win ? [".cmd", ".exe", ""] : [""]) {
      const abs = path.join(root, d, "node_modules", ".bin", name + ext);
      if (exists(abs)) {
        const rel = path.relative(path.join(root, folder), abs);
        const cmd = win ? rel.replace(/\//g, "\\") : rel.split(path.sep).join("/");
        return /\s/.test(cmd) ? `"${cmd}"` : cmd;
      }
    }
  }
  return null;
}

function hasPythonFiles(dir: string): boolean {
  const pyIn = (d: string) => {
    try {
      return fs.readdirSync(d).some((f) => f.endsWith(".py"));
    } catch {
      return false;
    }
  };
  return (
    pyIn(dir) ||
    childDirs(dir)
      .slice(0, 30)
      .some((c) => pyIn(path.join(dir, c)))
  );
}

function tsconfigUsesReferencesOnly(file: string): boolean {
  // tsconfig is JSON with comments: strip them roughly; enough to see `files: []` and references.
  const text = read(file).replace(/\/\*[\s\S]*?\*\/|(^|[^:"\\])\/\/.*$/gm, "$1");
  return /"references"\s*:/.test(text) && /"files"\s*:\s*\[\s*\]/.test(text);
}

function pyConfigured(dir: string, tool: "mypy" | "pyright" | "ruff"): boolean {
  const pyproject = read(path.join(dir, "pyproject.toml"));
  if (new RegExp(`^\\[tool\\.${tool}[\\].]`, "m").test(pyproject)) return true;
  if (tool === "mypy")
    return (
      exists(path.join(dir, "mypy.ini")) ||
      exists(path.join(dir, ".mypy.ini")) ||
      /^\[mypy[\]-]/m.test(read(path.join(dir, "setup.cfg")))
    );
  if (tool === "pyright") return exists(path.join(dir, "pyrightconfig.json"));
  return exists(path.join(dir, "ruff.toml")) || exists(path.join(dir, ".ruff.toml"));
}

function safeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

export function planDiagnostics(
  root: string,
  o: PlanOptions,
): { tools: PlannedTool[]; skipped: SkippedTool[] } {
  const win = o.win ?? process.platform === "win32";
  const find = o.find ?? ((exe: string, env: Record<string, string>) => whichSync(exe, env));
  const tools: PlannedTool[] = [];
  const skipped: SkippedTool[] = [];
  const folders = projectFolders(root);
  const label = (id: string, folder: string) => (folder ? `${id} (${folder})` : id);
  const skip = (id: string, folder: string, reason: string, configured = true) =>
    skipped.push({ tool: label(id, folder), reason, configured });
  let pythonDone = false;
  let cargoAtRoot = false;
  let biomeAtRoot = false;

  for (const folder of folders) {
    const dir = path.join(root, folder);
    const add = (t: Omit<PlannedTool, "folder" | "cwd" | "label">) =>
      tools.push({ ...t, folder, cwd: dir, label: label(t.id, folder) });

    // ---- TypeScript and JavaScript ----
    if (exists(path.join(dir, "tsconfig.json"))) {
      const bin = localBin(root, folder, "tsc", win);
      if (tsconfigUsesReferencesOnly(path.join(dir, "tsconfig.json")))
        skip(
          "tsc",
          folder,
          "tsconfig.json only lists project references. Run your own type check in the Terminal.",
        );
      else if (!bin)
        skip(
          "tsc",
          folder,
          "TypeScript is not installed in node_modules. Install the project's packages first.",
        );
      else
        add({
          id: "tsc",
          command: `${bin} --noEmit --pretty false -p tsconfig.json`,
          env: {},
          timeoutMs: 4 * MINUTE,
          parse: parseTsc,
        });
    }
    const biomeConfig = exists(path.join(dir, "biome.json")) || exists(path.join(dir, "biome.jsonc"));
    if (biomeConfig && !(folder && biomeAtRoot)) {
      const bin =
        localBin(root, folder, "biome", win) ??
        (find("biome", process.env as Record<string, string>) ? "biome" : null);
      if (!bin) skip("biome", folder, "Biome is not installed. Install the project's packages first.");
      else {
        add({
          id: "biome",
          command: `${bin} lint --reporter=github .`,
          env: {},
          timeoutMs: 3 * MINUTE,
          parse: (out, ctx) => parseGithubAnnotations(out, ctx, "biome"),
        });
        if (!folder) biomeAtRoot = true;
      }
    }
    const pkg = read(path.join(dir, "package.json"));
    if (ESLINT_CONFIGS.some((c) => exists(path.join(dir, c))) || /"eslintConfig"\s*:/.test(pkg)) {
      const bin = localBin(root, folder, "eslint", win);
      if (!bin)
        skip(
          "eslint",
          folder,
          "ESLint is not installed in node_modules. Install the project's packages first.",
        );
      else
        add({
          id: "eslint",
          command: `${bin} . --no-color`,
          env: {},
          timeoutMs: 4 * MINUTE,
          parse: parseEslintStylish,
        });
    }

    // ---- Python (the top-most Python folder; the tools look inside sub-folders themselves) ----
    if (!pythonDone && (PY_MARKERS.some((m) => exists(path.join(dir, m))) || hasPythonFiles(dir))) {
      pythonDone = true;
      const venv = venvEnv(dir);
      const rootVenv = folder && !venv.VIRTUAL_ENV ? venvEnv(root) : {};
      const env = { ...(venv.VIRTUAL_ENV ? venv : rootVenv) };
      const searchEnv = { ...(process.env as Record<string, string>), ...env };
      const usable = (exe: string) => {
        const p = find(exe, searchEnv);
        // The Microsoft Store placeholder for python.exe opens the Store instead of running Python.
        return p && !/[\\/]WindowsApps[\\/]/i.test(p) ? p : null;
      };
      const python = env.VIRTUAL_ENV ? "python" : win ? "python" : usable("python3") ? "python3" : "python";
      const hasPython = !!usable(python);
      const pycache = path.join(o.cacheDir, "pycache", safeKey(o.cacheKey));
      if (usable("ruff")) {
        add({
          id: "ruff",
          command: "ruff check --output-format=json --no-cache --no-fix .",
          env,
          timeoutMs: 3 * MINUTE,
          parse: parseRuffJson,
        });
      } else if (hasPython) {
        skip(
          "ruff",
          folder,
          "Ruff is not installed, so Depo checked Python syntax only.",
          pyConfigured(dir, "ruff"),
        );
        add({
          id: "compileall",
          command: `${python} -m compileall -q -x "[\\\\/](\\.venv|venv|env|node_modules|\\.git|build|dist)[\\\\/]" .`,
          env: { ...env, PYTHONPYCACHEPREFIX: pycache },
          timeoutMs: 3 * MINUTE,
          parse: parseCompileall,
        });
      } else {
        skip("python", folder, "Python is not installed on this PC.");
      }
      if (pyConfigured(dir, "mypy")) {
        if (!usable("mypy")) skip("mypy", folder, "mypy is configured but not installed.");
        else {
          const files = /^\s*files\s*=/m.test(
            read(path.join(dir, "mypy.ini")) +
              read(path.join(dir, "setup.cfg")) +
              read(path.join(dir, "pyproject.toml")),
          );
          add({
            id: "mypy",
            command: `mypy --no-color-output --no-error-summary --show-column-numbers --no-pretty${files ? "" : ' --exclude "(^|/)(\\.?venv|env|node_modules|build|dist)/" .'}`,
            env: { ...env, MYPY_CACHE_DIR: path.join(o.cacheDir, "mypy", safeKey(o.cacheKey)) },
            timeoutMs: 5 * MINUTE,
            parse: parseMypy,
          });
        }
      }
      if (pyConfigured(dir, "pyright")) {
        const bin = localBin(root, folder, "pyright", win) ?? (usable("pyright") ? "pyright" : null);
        if (!bin) skip("pyright", folder, "Pyright is configured but not installed.");
        else
          add({
            id: "pyright",
            command: `${bin} --outputjson`,
            env,
            timeoutMs: 5 * MINUTE,
            parse: parsePyrightJson,
          });
      }
    }

    // ---- Go ----
    if (exists(path.join(dir, "go.mod"))) {
      if (!find("go", process.env as Record<string, string>))
        skip("go vet", folder, "Go is not installed on this PC.");
      else
        add({
          id: "go vet",
          command: "go vet ./...",
          // Never download modules or toolchains: missing modules show as an error instead.
          env: { GOPROXY: "off", GOTOOLCHAIN: "local" },
          timeoutMs: 5 * MINUTE,
          parse: parseGoVet,
        });
    }

    // ---- Rust ----
    if (exists(path.join(dir, "Cargo.toml")) && !(folder && cargoAtRoot)) {
      if (!folder) cargoAtRoot = true;
      if (!find("cargo", process.env as Record<string, string>))
        skip("cargo check", folder, "Rust (cargo) is not installed on this PC.");
      else
        add({
          id: "cargo check",
          command: "cargo check --offline --message-format=short",
          env: {
            CARGO_TARGET_DIR: path.join(o.cacheDir, "cargo", safeKey(o.cacheKey)),
            CARGO_NET_OFFLINE: "true",
          },
          timeoutMs: 8 * MINUTE,
          parse: parseCargoShort,
        });
    }
  }
  return { tools, skipped };
}

import fs from "node:fs";
import path from "node:path";
import type { MissingDeps, RecipeKind, RecipeRole, RunRecipe, RunRecipeBase } from "@depo/shared";
import { type PackageManager, packageManagerFor } from "../agent/stack";
import { runShell } from "../tools/shell/run";
import { PREVIEW_HOST } from "./ports";

/**
 * Run recipes: how to start a project folder so the owner can open it in a browser. Detection
 * only reads files (and, for Python, asks the interpreter whether the framework is installed);
 * it never installs anything. Commands use `{port}` for the port Depo picks at start.
 */

export interface DetectOptions {
  /** The project's saved start command ("" or undefined = none). */
  override?: string;
  /** Test hook: can `python` (run in `cwd`) import all of `modules`? */
  pythonHas?: (python: string, cwd: string, modules: string[]) => Promise<boolean>;
  /** Override the platform (tests). */
  platform?: NodeJS.Platform;
}

export interface Detection {
  recipes: RunRecipe[];
  /** Index of the recipe to start by default, or -1 when none was found. */
  suggested: number;
  notes: string[];
}

/** Folders never searched for apps. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "site-packages",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "migrations",
  "tests",
  "test",
  "docs",
  "scripts",
  "e2e",
  "fixtures",
]);
/** A folder holding one of these is a project of its own (a monorepo part). */
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "requirements.txt", "manage.py", "setup.py"];
const VENV_DIRS = [".venv", "venv", "env"];
const FRONTEND_NAMES = /^(frontend|fe|client|web|webapp|ui|site|www|app|spa|dashboard)$/i;
const BACKEND_NAMES = /^(backend|be|server|api|service|services)$/i;

const PREFERRED_PORT: Record<RecipeKind, number> = {
  next: 3000,
  vite: 5173,
  node: 3000,
  bun: 3000,
  fastapi: 8000,
  flask: 5000,
  django: 8000,
  static: 8080,
  custom: 3000,
  both: 0,
};

/** Quote one shell argument when it needs it (cmd.exe and sh both accept double quotes). */
export function quoteArg(s: string): string {
  return /[\s"&|<>^()%!;]/.test(s) || s === "" ? `"${s.replace(/"/g, '""')}"` : s;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  return out;
}

const exists = (p: string) => fs.existsSync(p);
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function baseEnv(): Record<string, string> {
  return { PORT: "{port}", HOST: PREVIEW_HOST };
}

// ---- Node ---------------------------------------------------------------------------------

function packageManager(dir: string, root: string, pkg: Record<string, unknown>): PackageManager {
  return packageManagerFor(dir, root, pkg);
}

function runScript(pm: PackageManager, script: string, args = ""): string {
  const base = `${pm} run ${script}`;
  if (!args) return base;
  // npm needs `--` before the script's own flags; pnpm, yarn and bun pass them on as they are.
  return pm === "npm" ? `${base} -- ${args}` : `${base} ${args}`;
}

function execBin(pm: PackageManager, bin: string): string {
  return pm === "npm"
    ? `npx ${bin}`
    : pm === "pnpm"
      ? `pnpm exec ${bin}`
      : pm === "yarn"
        ? `yarn ${bin}`
        : `bunx ${bin}`;
}

/** node_modules in the folder or any parent up to the target root (workspaces hoist packages). */
function hasNodeModules(dir: string, root: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (isDir(path.join(d, "node_modules"))) return true;
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) return false;
  }
}

function nodeMissing(
  dir: string,
  root: string,
  rel: string,
  pkg: Record<string, unknown>,
  pm: PackageManager,
): MissingDeps | null {
  const deps = { ...strRecord(pkg.dependencies), ...strRecord(pkg.devDependencies) };
  if (Object.keys(deps).length === 0 || hasNodeModules(dir, root)) return null;
  return {
    reason: "The packages this app needs are not installed yet (there is no node_modules folder).",
    install: `${pm} install`,
    cwd: rel,
  };
}

/** The PORT an app's own .env (or its example) asks for, so it starts where its README says. */
function envPort(dir: string): number | null {
  for (const f of [".env", ".env.example", ".env.sample"]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const n = Number(/^PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m.exec(text)?.[1]);
    if (n >= 1024 && n <= 65535) return n;
  }
  return null;
}

function detectNode(root: string, rel: string, name: string): RunRecipeBase[] {
  const dir = path.join(root, rel);
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return [];
  const scripts = strRecord(pkg.scripts);
  const deps = { ...strRecord(pkg.dependencies), ...strRecord(pkg.devDependencies) };
  const pm = packageManager(dir, root, pkg);
  const missing = nodeMissing(dir, root, rel, pkg, pm);
  const where = rel ? ` in ${rel}` : "";
  const hint = roleFromName(name);
  const recipe = (
    kind: RecipeKind,
    label: string,
    command: string,
    role: RecipeRole,
    env: Record<string, string> = {},
  ): RunRecipeBase => ({
    id: `${kind}:${rel || "."}`,
    kind,
    label: `${label}${where}`,
    command,
    cwd: rel,
    env: { ...baseEnv(), ...env },
    port: kind === "next" || kind === "vite" ? PREFERRED_PORT[kind] : (envPort(dir) ?? PREFERRED_PORT[kind]),
    readyPath: "/",
    role: hint ?? role,
    missing,
  });
  const scriptWith = (re: RegExp, order: string[]) =>
    order.find((s) => scripts[s] && re.test(scripts[s] as string)) ??
    Object.keys(scripts).find((s) => re.test(scripts[s] as string) && !/build|lint|test/.test(s));
  const hasPortFlag = (script: string | undefined) =>
    !!script && /(^|\s)(-p|--port)(\s|=|$)/.test(scripts[script] ?? "");

  if (deps.next) {
    const script = scriptWith(/\bnext\s+dev\b/, ["dev", "start:dev"]);
    const flags = "-p {port} -H 127.0.0.1";
    const command = script
      ? runScript(pm, script, hasPortFlag(script) ? "" : flags)
      : `${execBin(pm, "next")} dev ${flags}`;
    return [recipe("next", "Next.js app", command, "frontend")];
  }
  const viteScript = scriptWith(/\bvite\b(?!\s+(build|preview)\b)/, ["dev", "start", "serve"]);
  if (deps.vite && viteScript) {
    const flags = "--port {port} --host 127.0.0.1 --strictPort";
    return [
      recipe("vite", "Vite app", runScript(pm, viteScript, hasPortFlag(viteScript) ? "" : flags), "frontend"),
    ];
  }
  if (deps["react-scripts"] && scripts.start) {
    return [recipe("node", "React app", runScript(pm, "start"), "frontend", { BROWSER: "none" })];
  }
  const server = deps["@nestjs/core"]
    ? "NestJS server"
    : deps.fastify
      ? "Fastify server"
      : deps.express
        ? "Express server"
        : deps.koa
          ? "Koa server"
          : deps["@hapi/hapi"]
            ? "hapi server"
            : deps.hono
              ? "Hono server"
              : null;
  const kind: RecipeKind = pm === "bun" ? "bun" : "node";
  const order = deps["@nestjs/core"]
    ? ["start:dev", "dev", "start"]
    : ["dev", "start", "serve", "start:dev", "develop", "preview"];
  const script = order.find((s) => scripts[s]);
  if (script) {
    const label = server ?? (kind === "bun" ? "Bun app" : "Node app");
    return [recipe(kind, label, runScript(pm, script), server ? "backend" : "app")];
  }
  // No start script: run the main file with PORT set.
  const main = [typeof pkg.main === "string" ? pkg.main : "", "server.js", "index.js", "app.js", "main.js"]
    .concat(kind === "bun" ? ["server.ts", "index.ts"] : [])
    .find((f) => f && exists(path.join(dir, f)));
  if (main) {
    const runner = kind === "bun" ? "bun" : "node";
    return [
      recipe(
        kind,
        server ?? (kind === "bun" ? "Bun app" : "Node app"),
        `${runner} ${quoteArg(main)}`,
        server ? "backend" : "app",
      ),
    ];
  }
  return [];
}

// ---- Python -------------------------------------------------------------------------------

interface PyApp {
  framework: "fastapi" | "flask";
  /** File relative to the folder, forward slashes. */
  file: string;
  target: string;
  factory: boolean;
}

/** Python files in `dir` up to `depth` levels, stopping at folders that are projects of their own. */
function pythonFiles(dir: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (out.length >= 300) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        if (level >= depth || it.name.startsWith(".") || SKIP_DIRS.has(it.name)) continue;
        if (PROJECT_MARKERS.some((m) => exists(path.join(full, m)))) continue;
        walk(full, level + 1);
      } else if (
        it.isFile() &&
        it.name.endsWith(".py") &&
        !/^test_|_test\.py$|^conftest\.py$/.test(it.name)
      ) {
        out.push(toPosix(path.relative(dir, full)));
      }
    }
  };
  walk(dir, 0);
  // Likely entry points first, then the shallowest.
  const rank = (f: string) =>
    (/(^|\/)(main|app|server|api|asgi|wsgi|application)\.py$/.test(f) ? 0 : 10) + f.split("/").length;
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const FASTAPI_RE = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:fastapi\.)?FastAPI\s*\(/m;
const FLASK_RE = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:flask\.)?Flask\s*\(/m;
const FACTORY_RE = /^def\s+(create_app|make_app|get_app|app_factory)\s*\(/m;

function findPythonApp(dir: string): PyApp | null {
  for (const file of pythonFiles(dir, 3)) {
    let text: string;
    try {
      const st = fs.statSync(path.join(dir, file));
      if (st.size > 300_000) continue;
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const fa = text.match(FASTAPI_RE);
    if (fa?.[1]) return { framework: "fastapi", file, target: fa[1], factory: false };
    const fl = text.match(FLASK_RE);
    if (fl?.[1]) return { framework: "flask", file, target: fl[1], factory: false };
    const fac = text.match(FACTORY_RE);
    if (fac?.[1] && /\bFastAPI\s*\(/.test(text))
      return { framework: "fastapi", file, target: fac[1], factory: true };
    if (fac?.[1] && /\bFlask\s*\(/.test(text))
      return { framework: "flask", file, target: fac[1], factory: true };
  }
  return null;
}

/** `app/main.py` → module `app.main`; a `src/` layout or odd folder names use an app folder. */
function moduleOf(file: string): { module: string; appDir: string; packageDir: string } {
  const parts = file.replace(/\.py$/, "").split("/");
  const ident = /^[A-Za-z_]\w*$/;
  let appDir = "";
  if (parts[0] === "src" && parts.length > 1) {
    appDir = "src";
    parts.shift();
  }
  if (!parts.every((p) => ident.test(p))) {
    const stem = parts.pop() ?? "main";
    appDir = [appDir, ...parts].filter(Boolean).join("/");
    return { module: stem, appDir, packageDir: appDir };
  }
  const packageDir = parts.length > 1 ? [appDir, parts[0]].filter(Boolean).join("/") : appDir;
  return { module: parts.join("."), appDir, packageDir };
}

interface PyEnv {
  /** Interpreter as written in the command (relative to the app folder when it is a venv). */
  python: string;
  /** Absolute interpreter path for checks, or the bare command name. */
  checkPython: string;
  venv: string | null;
}

function findVenv(dir: string, root: string, win: boolean): PyEnv | null {
  const bin = win ? path.join("Scripts", "python.exe") : path.join("bin", "python");
  for (const base of dir === root ? [dir] : [dir, root]) {
    for (const v of VENV_DIRS) {
      const abs = path.join(base, v, bin);
      if (!exists(abs)) continue;
      const rel = path.relative(dir, abs);
      const written = win ? rel.split("/").join("\\") : rel.startsWith(".") ? rel : `./${rel}`;
      return { python: quoteArg(written), checkPython: abs, venv: path.join(base, v) };
    }
  }
  return null;
}

async function defaultPythonHas(python: string, cwd: string, modules: string[]): Promise<boolean> {
  const r = await runShell({
    command: `${quoteArg(python)} -c "import ${modules.join(", ")}"`,
    cwd,
    timeoutMs: 15_000,
    maxOutputBytes: 4000,
  });
  return r.exitCode === 0;
}

function systemPython(win: boolean): string {
  if (win) return "python";
  return Bun.which("python3") ? "python3" : "python";
}

function pipInstall(dir: string, extra: string[]): string {
  const req = exists(path.join(dir, "requirements.txt"))
    ? ["-r", "requirements.txt"]
    : exists(path.join(dir, "pyproject.toml"))
      ? ["-e", "."]
      : [];
  return ["-m", "pip", "install", ...req, ...extra].join(" ");
}

async function detectPython(
  root: string,
  rel: string,
  name: string,
  opts: DetectOptions,
): Promise<RunRecipeBase[]> {
  const dir = path.join(root, rel);
  const win = (opts.platform ?? process.platform) === "win32";
  const manage = exists(path.join(dir, "manage.py"));
  const app = manage ? null : findPythonApp(dir);
  if (!manage && !app) return [];
  const framework = manage ? "django" : (app as PyApp).framework;
  const modules = framework === "fastapi" ? ["fastapi", "uvicorn"] : [framework];
  const has = opts.pythonHas ?? defaultPythonHas;

  // Interpreter: the project's virtual environment, else the system Python when it has the
  // framework, else a new .venv (which the install command creates).
  const venv = findVenv(dir, root, win);
  let python: string;
  let missing: MissingDeps | null = null;
  const extra =
    framework === "fastapi" ? ["uvicorn"] : exists(path.join(dir, "requirements.txt")) ? [] : [framework];
  if (venv) {
    python = venv.python;
    if (!(await has(venv.checkPython, dir, modules)))
      missing = {
        reason: `The project's virtual environment does not have ${modules.join(" and ")} installed.`,
        install: `${venv.python} ${pipInstall(dir, extra)}`,
        cwd: rel,
      };
  } else {
    const sys = systemPython(win);
    if (await has(sys, dir, modules)) python = sys;
    else {
      python = win ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
      missing = {
        reason: `${modules.join(" and ")} ${modules.length > 1 ? "are" : "is"} not installed, and the project has no virtual environment yet.`,
        install: `${sys} -m venv .venv && ${python} ${pipInstall(dir, extra)}`,
        cwd: rel,
      };
    }
  }
  const where = rel ? ` in ${rel}` : "";
  const role = roleFromName(name) ?? "backend";
  const base = { cwd: rel, env: baseEnv(), readyPath: "/", role, missing } as const;
  if (framework === "django") {
    return [
      {
        ...base,
        id: `django:${rel || "."}`,
        kind: "django",
        label: `Django app${where}`,
        command: `${python} manage.py runserver 127.0.0.1:{port}`,
        port: PREFERRED_PORT.django,
        role: roleFromName(name) ?? "app",
      },
    ];
  }
  const found = app as PyApp;
  const { module, appDir, packageDir } = moduleOf(found.file);
  if (found.framework === "fastapi") {
    const parts = [
      `${python} -m uvicorn ${module}:${found.target}`,
      found.factory ? "--factory" : "",
      appDir ? `--app-dir ${quoteArg(appDir)}` : "",
      "--host 127.0.0.1 --port {port} --reload",
      packageDir ? `--reload-dir ${quoteArg(packageDir)}` : "",
    ];
    return [
      {
        ...base,
        id: `fastapi:${rel || "."}`,
        kind: "fastapi",
        label: `FastAPI app${where} (${found.file})`,
        command: parts.filter(Boolean).join(" "),
        port: PREFERRED_PORT.fastapi,
      },
    ];
  }
  const target = `${appDir ? `${appDir.replace(/\//g, ".")}.` : ""}${module}:${found.target}${found.factory ? "()" : ""}`;
  return [
    {
      ...base,
      id: `flask:${rel || "."}`,
      kind: "flask",
      label: `Flask app${where} (${found.file})`,
      command: `${python} -m flask --app ${quoteArg(target)} run --host 127.0.0.1 --port {port} --reload`,
      port: PREFERRED_PORT.flask,
      role: roleFromName(name) ?? "app",
    },
  ];
}

// ---- static -------------------------------------------------------------------------------

function detectStatic(root: string, rel: string, name: string): RunRecipeBase[] {
  const dir = path.join(root, rel);
  for (const sub of ["", "public", "dist", "build", "site", "www"]) {
    if (!exists(path.join(dir, sub, "index.html"))) continue;
    const cwd = [rel, sub].filter(Boolean).join("/");
    return [
      {
        id: `static:${cwd || "."}`,
        kind: "static",
        label: `Static site${cwd ? ` in ${cwd}` : ""} (built-in server)`,
        command: "",
        cwd,
        env: {},
        port: PREFERRED_PORT.static,
        readyPath: "/",
        role: roleFromName(name) ?? "frontend",
        missing: null,
      },
    ];
  }
  return [];
}

// ---- putting it together ------------------------------------------------------------------

function roleFromName(name: string): RecipeRole | null {
  if (!name) return null;
  if (BACKEND_NAMES.test(name)) return "backend";
  if (FRONTEND_NAMES.test(name)) return "frontend";
  return null;
}

async function detectFolder(
  root: string,
  rel: string,
  opts: DetectOptions,
  allowStatic: boolean,
): Promise<RunRecipeBase[]> {
  const name = rel ? (rel.split("/").pop() ?? "") : "";
  const node = detectNode(root, rel, name);
  const py = await detectPython(root, rel, name, opts);
  const out = [
    ...node.filter((r) => r.role === "frontend"),
    ...py,
    ...node.filter((r) => r.role !== "frontend"),
  ];
  if (out.length === 0 && allowStatic) return detectStatic(root, rel, name);
  return out;
}

/** First-level folders (and apps/*, packages/*, services/*) that look like projects of their own. */
function subProjects(root: string): string[] {
  const found: string[] = [];
  const consider = (rel: string) => {
    const abs = path.join(root, rel);
    if (PROJECT_MARKERS.some((m) => exists(path.join(abs, m)))) found.push(rel);
    else if (FRONTEND_NAMES.test(path.basename(rel)) && exists(path.join(abs, "index.html"))) found.push(rel);
  };
  let items: fs.Dirent[] = [];
  try {
    items = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const it of items) {
    if (!it.isDirectory() || it.name.startsWith(".") || SKIP_DIRS.has(it.name) || it.name === "public")
      continue;
    if (["apps", "packages", "services"].includes(it.name)) {
      try {
        for (const sub of fs.readdirSync(path.join(root, it.name), { withFileTypes: true }))
          if (sub.isDirectory() && !sub.name.startsWith(".")) consider(`${it.name}/${sub.name}`);
      } catch {
        // unreadable
      }
      continue;
    }
    consider(it.name);
  }
  return found.sort().slice(0, 12);
}

/** Environment variable names the frontend reads for the API address, when its code shows them. */
function apiEnvNames(root: string, recipe: RunRecipeBase): string[] {
  const names = new Set<string>();
  const dir = path.join(root, recipe.cwd);
  const re = /\b((?:VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_)?(?:API|BACKEND|SERVER)(?:_BASE)?_URL)\b/g;
  let seen = 0;
  const walk = (d: string, level: number) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (seen > 400) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        if (level < 4 && !it.name.startsWith(".") && !SKIP_DIRS.has(it.name)) walk(full, level + 1);
      } else if (/\.(m?[jt]sx?|vue|svelte|astro)$|^\.env(\.example|\.sample)?$/.test(it.name)) {
        seen++;
        try {
          const text = fs.readFileSync(full, "utf8").slice(0, 200_000);
          for (const m of text.matchAll(re)) if (m[1]) names.add(m[1]);
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(dir, 0);
  if (exists(path.join(dir, ".env.example"))) walk(dir, 4);
  if (names.size === 0) {
    names.add(
      recipe.kind === "vite"
        ? "VITE_API_URL"
        : recipe.kind === "next"
          ? "NEXT_PUBLIC_API_URL"
          : "REACT_APP_API_URL",
    );
    names.add("API_URL");
  }
  return [...names].slice(0, 8);
}

function bothRecipe(root: string, backend: RunRecipeBase, frontend: RunRecipeBase): RunRecipe {
  const apiEnv = Object.fromEntries(apiEnvNames(root, frontend).map((n) => [n, "{backend_url}"]));
  return {
    id: `both:${backend.cwd}+${frontend.cwd}`,
    kind: "both",
    label: `Frontend and backend together (${frontend.cwd || "."} + ${backend.cwd || "."})`,
    command: "",
    cwd: "",
    env: {},
    port: 0,
    readyPath: "/",
    role: "app",
    missing: backend.missing ?? frontend.missing,
    parts: [backend, { ...frontend, env: { ...frontend.env, ...apiEnv } }],
  };
}

/**
 * How to start `root` (the project folder or a task's private copy). The owner's saved command
 * comes first, then a frontend-plus-backend pair, then what the root folder and its sub-projects
 * look like they need.
 */
export async function detectRecipes(root: string, opts: DetectOptions = {}): Promise<Detection> {
  const notes: string[] = [];
  const rootRecipes = await detectFolder(root, "", opts, false);
  const subs: RunRecipeBase[] = [];
  for (const rel of subProjects(root)) subs.push(...(await detectFolder(root, rel, opts, true)));
  const rootStatic = rootRecipes.length === 0 ? detectStatic(root, "", "") : [];

  const recipes: RunRecipe[] = [];
  const override = opts.override?.trim() ?? "";
  if (override) {
    recipes.push({
      id: "custom",
      kind: "custom",
      label: "Your start command",
      command: override,
      cwd: "",
      env: baseEnv(),
      port: rootRecipes[0]?.port ?? subs[0]?.port ?? PREFERRED_PORT.custom,
      readyPath: "/",
      role: "app",
      missing: null,
    });
  }
  const backend = subs.find((r) => r.role === "backend");
  const frontend = subs.find((r) => r.role === "frontend" && r.cwd !== backend?.cwd);
  const pair = backend && frontend ? bothRecipe(root, backend, frontend) : null;
  // A root dev script in a monorepo usually starts everything already; prefer it over the pair.
  const rootDev = rootRecipes.find((r) => r.kind !== "static" && /\brun (dev|start)\b/.test(r.command));
  if (rootDev) recipes.push(rootDev);
  if (pair) recipes.push(pair);
  for (const r of [...rootRecipes, ...subs, ...rootStatic]) if (!recipes.includes(r)) recipes.push(r);

  if (recipes.length === 0)
    notes.push(
      "Depo could not tell how to start this folder. Type the command you use to start it, and Depo will remember it.",
    );
  return { recipes, suggested: recipes.length ? 0 : -1, notes };
}

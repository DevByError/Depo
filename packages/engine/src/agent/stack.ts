import fs from "node:fs";
import path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * The package manager a JS folder uses: its `packageManager` field, then lock files (in the folder
 * or up to the project root), then a Bun-only setup (bun types, `bun` in its scripts), else npm.
 * Before the first install there is no lock file, so the field and the scripts matter.
 */
export function packageManagerFor(dir: string, root: string, pkg: Record<string, unknown>): PackageManager {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  const exists = (f: string) => {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  };
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, "bun.lock")) || exists(path.join(d, "bun.lockb"))) return "bun";
    if (exists(path.join(d, "pnpm-lock.yaml"))) return "pnpm";
    if (exists(path.join(d, "yarn.lock"))) return "yarn";
    if (exists(path.join(d, "package-lock.json"))) return "npm";
    if (path.resolve(d) === path.resolve(root) || path.dirname(d) === d) break;
  }
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  const scripts = Object.values((pkg.scripts as Record<string, string> | undefined) ?? {});
  if ("@types/bun" in deps || "bun-types" in deps || scripts.some((x) => /^bun(x)?\s/.test(x))) return "bun";
  return "npm";
}

/**
 * What a project is built with, read from its manifest files (package.json, requirements.txt,
 * pyproject.toml, pubspec.yaml, docker-compose...). Cheap and deterministic: no model, no network,
 * a handful of small files at the root and one level down (monorepos: backend/, frontend/, apps/*).
 * Used to pick playbook topics and to remember the stack after a task.
 */
export interface StackInfo {
  languages: string[];
  frameworks: string[];
  databases: string[];
  tools: string[];
  /** npm, pnpm, yarn, bun, pip, poetry, uv, pipenv, flutter, cargo, go */
  packageManager: string | null;
  testCommand: string | null;
  runCommand: string | null;
  /** Ports with what uses them, e.g. 8000 → "API (uvicorn)". */
  ports: { port: number; label: string }[];
  /** Lower-case keywords for playbook selection: fastapi, react, postgres... */
  hints: string[];
  /** Folders (relative, "." for the root) that hold a project manifest. */
  dirs: string[];
}

const SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  ".next",
  ".depo",
]);
const MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "manage.py",
  "pubspec.yaml",
  "go.mod",
  "Cargo.toml",
];
const MAX_FILE = 256 * 1024;

/** JavaScript packages → [kind, display name, playbook hints]. */
const JS_PACKAGES: [string, keyof Pick<StackInfo, "frameworks" | "databases" | "tools">, string, string[]][] =
  [
    ["next", "frameworks", "Next.js", ["next.js"]],
    ["react-native", "frameworks", "React Native", ["react native", "mobile"]],
    ["expo", "frameworks", "Expo", ["expo", "mobile"]],
    ["react", "frameworks", "React", ["react"]],
    ["vite", "tools", "Vite", ["vite"]],
    ["vue", "frameworks", "Vue", ["vue"]],
    ["@sveltejs/kit", "frameworks", "SvelteKit", ["svelte"]],
    ["svelte", "frameworks", "Svelte", ["svelte"]],
    ["@angular/core", "frameworks", "Angular", ["angular"]],
    ["astro", "frameworks", "Astro", ["astro"]],
    ["@nestjs/core", "frameworks", "NestJS", ["nestjs"]],
    ["express", "frameworks", "Express", ["express"]],
    ["fastify", "frameworks", "Fastify", ["fastify"]],
    ["hono", "frameworks", "Hono", ["hono"]],
    ["koa", "frameworks", "Koa", ["koa"]],
    ["electron", "frameworks", "Electron", ["electron"]],
    ["@tauri-apps/api", "frameworks", "Tauri", ["tauri"]],
    ["prisma", "tools", "Prisma", ["prisma"]],
    ["@prisma/client", "tools", "Prisma", ["prisma"]],
    ["drizzle-orm", "tools", "Drizzle", ["drizzle"]],
    ["typeorm", "tools", "TypeORM", ["typeorm"]],
    ["mongoose", "databases", "MongoDB", ["mongodb", "mongoose"]],
    ["mongodb", "databases", "MongoDB", ["mongodb"]],
    ["pg", "databases", "PostgreSQL", ["postgres"]],
    ["postgres", "databases", "PostgreSQL", ["postgres"]],
    ["mysql2", "databases", "MySQL", ["mysql"]],
    ["better-sqlite3", "databases", "SQLite", ["sqlite"]],
    ["redis", "databases", "Redis", ["redis"]],
    ["ioredis", "databases", "Redis", ["redis"]],
    ["tailwindcss", "tools", "Tailwind CSS", ["tailwind"]],
    ["@tanstack/react-query", "tools", "TanStack Query", ["tanstack"]],
    ["react-hook-form", "tools", "React Hook Form", ["react hook form"]],
    ["zod", "tools", "Zod", ["zod"]],
    ["vitest", "tools", "Vitest", ["vitest"]],
    ["jest", "tools", "Jest", ["jest"]],
    ["@playwright/test", "tools", "Playwright", ["playwright"]],
    ["cypress", "tools", "Cypress", ["cypress"]],
  ];

/** Python packages (as written in requirements or pyproject) → [kind, display name, hints]. */
const PY_PACKAGES: [RegExp, keyof Pick<StackInfo, "frameworks" | "databases" | "tools">, string, string[]][] =
  [
    [/^fastapi$/, "frameworks", "FastAPI", ["fastapi"]],
    [/^djangorestframework$/, "frameworks", "Django REST Framework", ["drf", "django"]],
    [/^django$/, "frameworks", "Django", ["django"]],
    [/^flask$/, "frameworks", "Flask", ["flask"]],
    [/^streamlit$/, "frameworks", "Streamlit", ["streamlit"]],
    [/^sqlmodel$/, "tools", "SQLModel", ["sqlmodel"]],
    [/^sqlalchemy$/, "tools", "SQLAlchemy", ["sqlalchemy"]],
    [/^alembic$/, "tools", "Alembic", ["alembic"]],
    [/^(psycopg|psycopg2|psycopg2-binary|asyncpg)$/, "databases", "PostgreSQL", ["postgres"]],
    [/^(pymongo|motor|beanie)$/, "databases", "MongoDB", ["mongodb"]],
    [/^redis$/, "databases", "Redis", ["redis"]],
    [/^celery$/, "tools", "Celery", ["celery"]],
    [/^pytest$/, "tools", "pytest", ["pytest"]],
    [/^pgvector$/, "tools", "pgvector", ["pgvector"]],
    [/^(ollama|langchain|llama-index)$/, "tools", "local AI libraries", ["ollama"]],
  ];

/** Compose images → database names. */
const IMAGES: [RegExp, string, string][] = [
  [/postgres|postgis|pgvector/, "PostgreSQL", "postgres"],
  [/mongo/, "MongoDB", "mongodb"],
  [/redis|valkey/, "Redis", "redis"],
  [/mysql|mariadb/, "MySQL", "mysql"],
];

/** Usual development ports, labelled, for frameworks that were detected without an explicit port. */
const DEFAULT_PORTS: Record<string, [number, string]> = {
  Vite: [5173, "web (Vite dev server)"],
  "Next.js": [3000, "web (Next.js)"],
  FastAPI: [8000, "API (uvicorn)"],
  Django: [8000, "web (Django runserver)"],
  Expo: [8081, "Expo dev server"],
};

function read(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function has(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

/** The root, its direct subfolders and apps/* or packages/* that hold a manifest (at most 12). */
function projectDirs(root: string): string[] {
  const out: string[] = [];
  const consider = (rel: string) => {
    const abs = path.join(root, rel);
    if (MANIFESTS.some((m) => has(abs, m))) out.push(rel);
  };
  consider(".");
  const children = (rel: string): string[] => {
    try {
      return fs
        .readdirSync(path.join(root, rel), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
        .map((d) => (rel === "." ? d.name : `${rel}/${d.name}`))
        .slice(0, 30);
    } catch {
      return [];
    }
  };
  for (const c of children(".")) {
    if (out.length >= 12) break;
    if (c === "apps" || c === "packages" || c === "services") {
      for (const cc of children(c)) if (out.length < 12) consider(cc);
    } else consider(c);
  }
  return out;
}

function pythonPackages(dir: string): string[] {
  const names = new Set<string>();
  const req = read(path.join(dir, "requirements.txt")) ?? "";
  for (const line of req.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)/.exec(line.replace(/#.*/, ""));
    if (m?.[1]) names.add(m[1].toLowerCase().replace(/_/g, "-").replace(/\[.*$/, ""));
  }
  const py = read(path.join(dir, "pyproject.toml")) ?? "";
  // Dependency strings like "fastapi>=0.115" or poetry tables like `fastapi = "^0.115"`.
  for (const m of py.matchAll(/["']\s*([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~^ ;]|["'])/g))
    if (m[1]) names.add(m[1].toLowerCase().replace(/_/g, "-"));
  for (const m of py.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["'{]/gm))
    if (m[1]) names.add(m[1].toLowerCase().replace(/_/g, "-"));
  return [...names];
}

/** Where the FastAPI app object lives, as a uvicorn target (app.main:app). */
function fastapiTarget(dir: string): string | null {
  for (const rel of ["app/main.py", "main.py", "src/main.py", "app.py", "api/main.py", "src/app/main.py"]) {
    const text = read(path.join(dir, rel));
    const m = text ? /^(\w+)\s*=\s*FastAPI\(/m.exec(text) : null;
    if (m?.[1]) return `${rel.replace(/\.py$/, "").replace(/\//g, ".")}:${m[1]}`;
    if (text && /create_app\(\)/.test(text) && /FastAPI\(/.test(text))
      return `${rel.replace(/\.py$/, "").replace(/\//g, ".")}:app`;
  }
  return null;
}

function addPort(info: StackInfo, port: number, label: string) {
  if (!Number.isInteger(port) || port < 80 || port > 65535) return;
  if (!info.ports.some((p) => p.port === port)) info.ports.push({ port, label });
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function detectStack(root: string): StackInfo {
  const info: StackInfo = {
    languages: [],
    frameworks: [],
    databases: [],
    tools: [],
    packageManager: null,
    testCommand: null,
    runCommand: null,
    ports: [],
    hints: [],
    dirs: [],
  };
  const hints: string[] = [];
  const explicitPorts = new Set<number>();
  const dirs = projectDirs(root);
  info.dirs = dirs;
  const prefix = (rel: string) => (rel === "." ? "" : `cd ${rel} && `);

  for (const rel of dirs) {
    const dir = path.join(root, rel);
    // ---- JavaScript / TypeScript
    const pkgText = read(path.join(dir, "package.json"));
    if (pkgText) {
      try {
        const pkg = JSON.parse(pkgText) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        info.languages.push(deps.typescript || has(dir, "tsconfig.json") ? "TypeScript" : "JavaScript");
        for (const [name, kind, label, h] of JS_PACKAGES) {
          if (!(name in deps)) continue;
          info[kind].push(label);
          hints.push(...h);
        }
        const pm = packageManagerFor(dir, root, pkg as Record<string, unknown>);
        info.packageManager ??= pm;
        const scripts = pkg.scripts ?? {};
        // `bun test` is Bun's own runner (it skips the script), so Bun runs scripts with `bun run`.
        const run = (s: string) =>
          pm === "bun" && s === "test"
            ? "bun run test"
            : pm === "npm" && s !== "test" && s !== "start"
              ? `npm run ${s}`
              : `${pm} ${s}`;
        if (scripts.test && !/no test specified/.test(scripts.test))
          info.testCommand ??= `${prefix(rel)}${run("test")}`;
        const runScript = scripts.dev ? "dev" : scripts.start ? "start" : null;
        if (runScript) info.runCommand ??= `${prefix(rel)}${run(runScript)}`;
        for (const s of Object.values(scripts)) {
          for (const m of s.matchAll(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})\b/g)) {
            addPort(info, Number(m[1]), `${rel === "." ? "app" : rel} (package.json script)`);
            explicitPorts.add(Number(m[1]));
          }
        }
      } catch {
        // A broken package.json says nothing reliable.
      }
    }
    // ---- Python
    const isPython = has(dir, "requirements.txt") || has(dir, "pyproject.toml") || has(dir, "manage.py");
    if (isPython) {
      info.languages.push("Python");
      const pkgs = pythonPackages(dir);
      for (const [re, kind, label, h] of PY_PACKAGES) {
        if (!pkgs.some((p) => re.test(p))) continue;
        info[kind].push(label);
        hints.push(...h);
      }
      if (has(dir, "manage.py") && !info.frameworks.includes("Django")) {
        info.frameworks.push("Django");
        hints.push("django");
      }
      info.packageManager ??= has(dir, "poetry.lock")
        ? "poetry"
        : has(dir, "uv.lock")
          ? "uv"
          : has(dir, "Pipfile")
            ? "pipenv"
            : "pip";
      const tests =
        has(dir, "tests") || has(dir, "test") || pkgs.includes("pytest") || has(dir, "pytest.ini");
      if (tests) {
        info.testCommand ??= `${prefix(rel)}python -m pytest -q`;
        if (!info.tools.includes("pytest")) info.tools.push("pytest");
        hints.push("pytest");
      }
      const target = pkgs.includes("fastapi") ? fastapiTarget(dir) : null;
      if (target) info.runCommand ??= `${prefix(rel)}uvicorn ${target} --reload`;
      else if (has(dir, "manage.py")) info.runCommand ??= `${prefix(rel)}python manage.py runserver`;
    }
    // ---- Others
    if (has(dir, "pubspec.yaml")) {
      info.languages.push("Dart");
      info.frameworks.push("Flutter");
      hints.push("flutter", "mobile");
      info.packageManager ??= "flutter";
      info.testCommand ??= `${prefix(rel)}flutter test`;
      info.runCommand ??= `${prefix(rel)}flutter run`;
    }
    if (has(dir, "go.mod")) {
      info.languages.push("Go");
      info.packageManager ??= "go";
      info.testCommand ??= `${prefix(rel)}go test ./...`;
    }
    if (has(dir, "Cargo.toml")) {
      info.languages.push("Rust");
      info.packageManager ??= "cargo";
      info.testCommand ??= `${prefix(rel)}cargo test`;
    }
  }

  // ---- Containers and configuration at the root
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
    .map((f) => read(path.join(root, f)))
    .find((t): t is string => t !== null);
  if (compose) {
    info.tools.push("Docker Compose");
    hints.push("docker");
    for (const m of compose.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)) {
      const image = (m[1] ?? "").toLowerCase();
      for (const [re, name, hint] of IMAGES)
        if (re.test(image)) {
          info.databases.push(name);
          hints.push(hint);
        }
    }
    // "5432:5432", "127.0.0.1:8000:8000", - 3000:3000
    for (const m of compose.matchAll(/["'\s-](?:[\d.]+:)?(\d{2,5}):(\d{2,5})["'\s]/g)) {
      addPort(info, Number(m[1]), "docker compose");
      explicitPorts.add(Number(m[1]));
    }
  }
  if (has(root, "Dockerfile")) {
    info.tools.push("Docker");
    hints.push("docker");
  }
  const envExample = read(path.join(root, ".env.example"));
  if (envExample) {
    for (const m of envExample.matchAll(/^\s*([A-Z0-9_]*PORT)\s*=\s*(\d{2,5})\s*$/gm)) {
      addPort(info, Number(m[2]), `${m[1]} in .env.example`);
      explicitPorts.add(Number(m[2]));
    }
  }
  const runCmd = has(root, "run.cmd") || has(root, "run.bat");
  const runSh = has(root, "run.sh");
  if (runCmd || runSh) {
    const win = has(root, "run.cmd") ? "run.cmd" : "run.bat";
    info.runCommand = runCmd && runSh ? `${win} (Windows) or ./run.sh` : runCmd ? win : "./run.sh";
  }
  for (const fw of uniq([...info.frameworks, ...info.tools])) {
    const d = DEFAULT_PORTS[fw];
    if (d && !explicitPorts.has(d[0])) addPort(info, d[0], d[1]);
  }

  info.languages = uniq(info.languages);
  info.frameworks = uniq(info.frameworks);
  // React is implied by Next.js and React Native; keep the more specific name only.
  if (info.frameworks.includes("Next.js") || info.frameworks.includes("React Native"))
    info.frameworks = info.frameworks.filter((f) => f !== "React");
  info.databases = uniq(info.databases);
  info.tools = uniq(info.tools);
  info.hints = uniq(hints);
  if (info.hints.includes("next.js") || info.hints.includes("react native"))
    info.hints = info.hints.filter((h) => h !== "react");
  info.ports.sort((a, b) => a.port - b.port);
  return info;
}

/** One line for prompts and memory: "Python with FastAPI; PostgreSQL; pytest, Alembic". */
export function stackSummary(s: StackInfo): string {
  if (!s.languages.length && !s.frameworks.length) return "";
  const parts = [
    `${s.languages.join(" and ") || "unknown language"}${s.frameworks.length ? ` with ${s.frameworks.join(", ")}` : ""}`,
  ];
  if (s.databases.length) parts.push(s.databases.join(", "));
  if (s.tools.length) parts.push(s.tools.join(", "));
  return parts.join("; ");
}

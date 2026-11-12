import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { RpcResponse } from "@depo/shared";
import { startFakeOllama } from "../../../scripts/fake-ollama-lib";
import { codingSystemPrompt } from "../src/agent/prompt";
import { BLUEPRINT_AGENTS, manifestOf } from "../src/agents/manifests";
import { findBlock } from "../src/blocks";
import { PY_PASSWORDS } from "../src/blocks/other-blocks";
import {
  BLUEPRINTS,
  blueprintDetail,
  compactTree,
  findBlueprint,
  isBlankProject,
  projectEntries,
  writeBlueprint,
} from "../src/blueprints";
import {
  BLUEPRINT_STEP,
  blueprintFor,
  blueprintHint,
  pickBlueprint,
  summaryWithBlueprint,
  withBlueprint,
} from "../src/blueprints/plan";
import { slugify } from "../src/blueprints/render";
import { FASTAPI_TEMPLATES } from "../src/blueprints/templates-fastapi-service";
import { FULLSTACK_TEMPLATES } from "../src/blueprints/templates-fullstack";
import { WEB_TEMPLATES } from "../src/blueprints/templates-react-web-app";
import { createEngine, type Engine } from "../src/engine";
import { executeTool, type ToolContext } from "../src/tools/index";
import "../src/tools/block-tools";
import { TEST_TOKEN, tempDir } from "./helpers";

let cleanup: (() => void)[] = [];
let engine: Engine | null = null;
let stopFake = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  stopFake();
  stopFake = () => {};
  for (const c of cleanup) c();
  cleanup = [];
});

function temp(label: string): string {
  const t = tempDir(label);
  cleanup.push(t.cleanup);
  return t.dir;
}

function run(cmd: string[], cwd: string, timeout = 180_000): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", CI: "1" },
  });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** All files under `dir`, relative, with forward slashes. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const python = ["python", "python3"].find((p) => {
  try {
    return Bun.spawnSync([p, "-c", "import sys; assert sys.version_info >= (3, 10)"]).exitCode === 0;
  } catch {
    return false;
  }
});
const pythonHasDeps =
  !!python && Bun.spawnSync([python, "-c", "import fastapi, jwt, httpx, pytest"]).exitCode === 0;
if (!pythonHasDeps)
  console.warn(
    "Skipping the blueprint pytest runs: python 3.10+ with fastapi, PyJWT, httpx and pytest is missing.",
  );

const NAME = 'Ünï "Shop" <app>';
const VARS = { name: NAME, description: "Orders & stock for a small shop." };

async function ctxIn(dir: string): Promise<ToolContext> {
  if (!engine) {
    engine = createEngine({
      dataRoot: path.join(temp("depo bp engine"), "data"),
      token: TEST_TOKEN,
      heartbeatMs: 60_000,
    });
    await engine.start();
  }
  return {
    root: dir,
    bus: engine.bus,
    approvals: engine.approvals,
    projectId: null,
    taskId: null,
    agent: "backend@1.0.0",
    readPaths: new Set<string>(),
  };
}

async function rpc(port: number, method: string, params: unknown): Promise<RpcResponse> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket error"));
  });
  const out = await new Promise<RpcResponse>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === 1) res(msg);
    };
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  ws.close();
  return out;
}

describe("the blueprint library", () => {
  test("every template file is embedded, and each manifest is complete", () => {
    const filesDir = path.resolve(import.meta.dir, "../src/blueprints/files");
    const maps: Record<string, Record<string, string>> = {
      "fastapi-service": FASTAPI_TEMPLATES,
      "react-web-app": WEB_TEMPLATES,
      fullstack: FULLSTACK_TEMPLATES,
    };
    for (const [folder, map] of Object.entries(maps)) {
      const onDisk = walk(path.join(filesDir, folder)).map((f) => f.replace(/\.tpl$/, ""));
      expect(Object.keys(map).sort()).toEqual(onDisk);
    }
    expect(BLUEPRINTS.map((b) => b.id)).toEqual([
      "fullstack",
      "next-bun-mysql",
      "fastapi-service",
      "react-web-app",
    ]);
    for (const b of BLUEPRINTS) {
      expect(b.title.length).toBeGreaterThan(3);
      expect(b.summary.length).toBeGreaterThan(20);
      expect(b.stack.length).toBeGreaterThan(1);
      expect(b.features.length).toBeGreaterThanOrEqual(4);
      expect(b.ports.length).toBeGreaterThan(0);
      expect(b.runCommand && b.testCommand).toBeTruthy();
      expect(b.extendGuide.length).toBeLessThanOrEqual(1200);
      expect(b.extendGuide.length).toBeGreaterThan(400);
      expect(`${b.summary} ${b.features.join(" ")}`).not.toContain("—");
    }
    expect(findBlueprint(" FastAPI-Service ")?.id).toBe("fastapi-service");
    expect(findBlueprint("nope")).toBeUndefined();
    const d = blueprintDetail(findBlueprint("fullstack") as NonNullable<ReturnType<typeof findBlueprint>>);
    expect(d.files.length).toBe(d.fileCount);
    expect(d.totalBytes).toBe(d.files.reduce((n, f) => n + f.size, 0));
    expect(d.files.some((f) => f.path === "api/app/main.py")).toBe(true);
    expect(d.files.some((f) => f.path === "web/src/App.tsx")).toBe(true);
  });

  test("the blueprints reuse the building blocks' code as it is", () => {
    const fast = findBlueprint("fastapi-service")?.files(VARS) ?? [];
    const file = (p: string) => fast.find((f) => f.path === p)?.content ?? "";
    expect(file("app/core/passwords.py")).toContain(PY_PASSWORDS);
    expect(findBlock("auth-py")?.files.find((f) => f.path === "app/auth.py")?.content).toContain(
      PY_PASSWORDS,
    );
    expect(file("app/core/rbac.py")).toBe(
      findBlock("rbac-py")?.files.find((f) => f.path === "app/rbac.py")?.content ?? "-",
    );
    const web = findBlueprint("react-web-app")?.files(VARS) ?? [];
    const block = findBlock("login-form-react")?.files.find((f) => f.path.endsWith("validate.ts"));
    expect(block).toBeTruthy();
    expect(web.some((f) => f.content === block?.content)).toBe(true);
  });

  test("names become a slug, and are escaped where they land in code", () => {
    expect(slugify(NAME)).toBe("uni-shop-app");
    expect(slugify("!!!")).toBe("app");
    const files = findBlueprint("react-web-app")?.files(VARS) ?? [];
    const get = (p: string) => files.find((f) => f.path === p)?.content ?? "";
    expect(JSON.parse(get("package.json")).name).toBe("uni-shop-app");
    expect(get("index.html")).toContain("<title>Ünï &#34;Shop&#34; &#60;app&#62;</title>");
    expect(get("src/lib/config.ts")).toContain(JSON.stringify(NAME));
  });

  for (const b of BLUEPRINTS) {
    test(`${b.id}: generated into a folder with spaces, the tree is complete and clean`, () => {
      const root = path.join(temp("depo bp"), "my new app");
      const written = writeBlueprint(root, b, VARS);
      const expected = b.files(VARS).map((f) => f.path);
      expect(walk(root)).toEqual([...expected].sort());
      expect(written.length).toBe(expected.length);
      for (const rel of expected) {
        expect(rel.startsWith("/") || rel.includes("..") || rel.includes("\\")).toBe(false);
        const text = fs.readFileSync(path.join(root, rel), "utf8");
        expect(text).not.toContain("__DEPO_");
        if (/\.(cmd|bat|ps1)$/.test(rel)) expect(text.replace(/\r\n/g, "")).not.toContain("\n");
        else expect(text).not.toContain("\r");
        if (/\.(ts|tsx)$/.test(rel)) {
          const loader = rel.endsWith("x") ? "tsx" : "ts";
          expect(() => new Bun.Transpiler({ loader }).transformSync(text)).not.toThrow();
        }
        if (rel.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
        if (rel.endsWith(".sh") && process.platform !== "win32")
          expect(fs.statSync(path.join(root, rel)).mode & 0o111).toBeGreaterThan(0);
        // No real-looking secrets in the library.
        expect(/AKIA[0-9A-Z]{16}|sk_live_|-----BEGIN/.test(text)).toBe(false);
      }
      const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
      expect(readme).toContain(NAME);
      expect(readme).toContain("Orders & stock for a small shop.");
      for (const h of ["## Run it", "## Test it"]) expect(readme).toContain(h);
      // Writing again over a project is refused.
      expect(() => writeBlueprint(root, b, VARS)).toThrow();
      if (python) {
        const r = run([python, "-m", "compileall", "-q", "."], root);
        expect(r.code).toBe(0);
      }
    });
  }

  test("fullstack: an api and a web app, the /api proxy, one run script and one test script", () => {
    const root = path.join(temp("depo bp full"), "shop app");
    writeBlueprint(root, findBlueprint("fullstack") as NonNullable<ReturnType<typeof findBlueprint>>, VARS);
    for (const f of ["README.md", "run.cmd", "run.ps1", "run.sh", "test.cmd", "test.ps1", "test.sh"])
      expect(fs.existsSync(path.join(root, f))).toBe(true);
    for (const f of [
      "api/app/main.py",
      "api/requirements.txt",
      "api/run.cmd",
      "web/package.json",
      "web/run.sh",
    ])
      expect(fs.existsSync(path.join(root, f))).toBe(true);
    expect(fs.existsSync(path.join(root, "api", ".gitignore"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "web", "vite.config.ts"), "utf8")).toContain('"/api"');
    const run = fs.readFileSync(path.join(root, "run.cmd"), "utf8");
    expect(run).toContain("api\\run.cmd");
    expect(run).toContain("web\\run.cmd");
    const test = fs.readFileSync(path.join(root, "test.sh"), "utf8");
    expect(test).toContain("api/run.sh test");
    expect(test).toContain("web/run.sh test");
  });

  test.if(pythonHasDeps)(
    "fastapi-service: its own pytest suite passes as written",
    () => {
      const root = path.join(temp("depo bp py"), "shop api");
      writeBlueprint(
        root,
        findBlueprint("fastapi-service") as NonNullable<ReturnType<typeof findBlueprint>>,
        VARS,
      );
      const r = run(
        [
          python as string,
          "-m",
          "pytest",
          "-q",
          "-p",
          "no:cacheprovider",
          "-W",
          "error",
          "-W",
          "ignore:Using `httpx` with",
        ],
        root,
      );
      if (r.code !== 0) console.error(r.out.slice(-4000));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/\b\d{2,} passed\b/);
    },
    180_000,
  );

  test.if(pythonHasDeps)(
    "fullstack: the api tests pass from the project root, as its test command runs them",
    () => {
      const root = path.join(temp("depo bp full py"), "shop app");
      writeBlueprint(root, findBlueprint("fullstack") as NonNullable<ReturnType<typeof findBlueprint>>, VARS);
      const r = run([python as string, "-m", "pytest", "-q", "-p", "no:cacheprovider", "api"], root);
      if (r.code !== 0) console.error(r.out.slice(-4000));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/\b\d{2,} passed\b/);
    },
    180_000,
  );

  test("react-web-app: typecheck and tests pass after an install (structure only when packages cannot be installed)", () => {
    // The long form of the folder: a CI runner's temp folder is a short name ("RUNNER~1") that vitest
    // cannot match to the setup file it is asked to load.
    const root = path.join(fs.realpathSync.native(temp("depo bp web")), "shop web");
    writeBlueprint(
      root,
      findBlueprint("react-web-app") as NonNullable<ReturnType<typeof findBlueprint>>,
      VARS,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const s of ["dev", "build", "typecheck", "test"]) expect(pkg.scripts[s]).toBeTruthy();
    // Exact versions only, so a fresh install gets what the blueprint was tested with.
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies }))
      expect(String(v)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).compilerOptions.strict).toBe(
      true,
    );
    const install = run(["bun", "install", "--no-progress"], root, 150_000);
    if (install.code !== 0) {
      console.warn(
        `Skipping the web typecheck and tests: packages could not be installed.\n${install.out.slice(-600)}`,
      );
      return;
    }
    const tsc = run(["bun", "run", "typecheck"], root);
    if (tsc.code !== 0) console.error(tsc.out.slice(-4000));
    expect(tsc.code).toBe(0);
    const tests = run(["bun", "run", "test"], root);
    if (tests.code !== 0) console.error(tests.out.slice(-4000));
    expect(tests.code).toBe(0);
    expect(tests.out).toMatch(/Tests\s+\d+ passed/);
  }, 300_000);
});

describe("the blank-project check", () => {
  test("docs, git and editor settings do not count as a project; code does", () => {
    const root = temp("depo bp blank");
    expect(isBlankProject(root)).toBe(true);
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "README.md"), "# Shop\n");
    fs.writeFileSync(path.join(root, "notes.txt"), "ideas");
    fs.writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
    expect(projectEntries(root)).toEqual([]);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.mkdirSync(path.join(root, "src"));
    expect(projectEntries(root)).toEqual(["package.json", "src/"]);
    expect(isBlankProject(path.join(root, "missing"))).toBe(true);
  });

  test("compactTree folds big folders and stays within its budget", () => {
    const files =
      findBlueprint("fullstack")
        ?.files(VARS)
        .map((f) => f.path) ?? [];
    const tree = compactTree(files);
    expect(tree.length).toBeLessThanOrEqual(1800);
    expect(tree).toContain("api/");
    expect(tree).toContain("web/");
  });
});

describe("use_blueprint and list_blueprints", () => {
  test("starts an empty copy, answers within budget, and says so when run again", async () => {
    const root = temp("depo bp tool");
    const ctx = await ctxIn(root);
    const changed: string[] = [];
    ctx.onFileChanged = (p) => changed.push(p);
    const r = await executeTool("use_blueprint", { id: "fastapi-service", name: "Shop API" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content.length).toBeLessThan(4000);
    expect(r.content).toContain("Started from the FastAPI service blueprint");
    expect(r.content).toContain("Run: python -m uvicorn");
    expect(r.content).toContain("Test: python -m pytest -q");
    expect(r.content).toContain("How to extend it:");
    expect(fs.existsSync(path.join(root, "app", "main.py"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain("# Shop API");
    expect(changed.length).toBe(findBlueprint("fastapi-service")?.files({ name: "Shop API" }).length);
    // Files are not marked as read: the first edit shows the agent the file.
    expect(ctx.readPaths.size).toBe(0);
    const again = await executeTool("use_blueprint", { id: "fastapi-service", name: "Shop API" }, ctx);
    expect(again.isError).toBe(false);
    expect(again.content).toContain("already in place");
  });

  test("refuses a copy that already has code, and writes nothing", async () => {
    const root = temp("depo bp tool refuse");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"mine"}');
    fs.mkdirSync(path.join(root, "src"));
    const ctx = await ctxIn(root);
    const r = await executeTool("use_blueprint", { id: "react-web-app" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Nothing was written");
    expect(r.content).toContain("package.json");
    expect(walk(root)).toEqual(["package.json"]);
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe('{"name":"mine"}');
    expect((await executeTool("use_blueprint", { id: "no-such-thing" }, ctx)).isError).toBe(true);
  });

  test("keeps the owner's README text and .gitignore lines in an otherwise empty copy", async () => {
    const root = temp("depo bp tool readme");
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "idea.md"), "An idea.");
    fs.writeFileSync(path.join(root, "README.md"), "# Bakery\n\nOrders for our bakery.\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "my-secret.txt\n");
    const ctx = await ctxIn(root);
    const r = await executeTool("use_blueprint", { id: "react-web-app" }, ctx);
    expect(r.isError).toBe(false);
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme.startsWith("# Bakery")).toBe(true);
    expect(readme).toContain("Orders for our bakery.");
    expect(readme).toContain("npm test");
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("my-secret.txt");
    expect(ignore).toContain("node_modules");
    expect(fs.readFileSync(path.join(root, "docs", "idea.md"), "utf8")).toBe("An idea.");
  });

  test("list_blueprints lists them all and shows one with its extend guide", async () => {
    const ctx = await ctxIn(temp("depo bp list"));
    const all = await executeTool("list_blueprints", {}, ctx);
    for (const b of BLUEPRINTS) expect(all.content).toContain(`- ${b.id}:`);
    expect(all.content.length).toBeLessThan(2500);
    const one = await executeTool("list_blueprints", { id: "fullstack" }, ctx);
    expect(one.content).toContain("How to extend it:");
    expect(one.content).toContain(findBlueprint("fullstack")?.extendGuide.slice(0, 60) ?? "-");
    expect((await executeTool("list_blueprints", { id: "zzz" }, ctx)).isError).toBe(true);
  });

  test("the Thinking, Backend, Frontend and Integration agents have the tools; others do not", () => {
    expect(BLUEPRINT_AGENTS).toEqual(["thinking", "backend", "frontend", "integration"]);
    for (const id of BLUEPRINT_AGENTS) {
      expect(manifestOf(id).tools).toContain("use_blueprint");
      expect(manifestOf(id).tools).toContain("list_blueprints");
    }
    for (const id of ["reasoning", "security", "testing"] as const)
      expect(manifestOf(id).tools).not.toContain("use_blueprint");
  });
});

describe("blueprints in plans", () => {
  test("blueprintFor picks by mode, and steps aside for other stacks and other kinds of programs", () => {
    const id = (m: Parameters<typeof blueprintFor>[0], t: string) => blueprintFor(m, t)?.id ?? null;
    expect(id("full", "a booking system for a clinic")).toBe("fullstack");
    expect(id("backend", "an orders API")).toBe("fastapi-service");
    expect(id("ai", "a question answering service")).toBe("fastapi-service");
    expect(id("frontend", "a dashboard for sales")).toBe("react-web-app");
    expect(id("single", "a todo app with login")).toBe("fullstack");
    expect(id("single", "a REST API for invoices")).toBe("fastapi-service");
    expect(id("single", "a dashboard page")).toBe("react-web-app");
    expect(id("full", "a todo app with Next.js and FastAPI")).toBeNull();
    expect(id("backend", "an API in Express")).toBeNull();
    expect(id("backend", "a Django admin")).toBeNull();
    expect(id("frontend", "a Vue dashboard")).toBeNull();
    expect(id("single", "a CLI that renames photos")).toBeNull();
    expect(id("single", "make a landing page")).toBeNull();
    expect(id("full", "a mobile app for runners")).toBeNull();
    expect(id("fix", "build a new login page")).toBeNull();
    expect(id("single", "an ASP.NET API in C# for orders")).toBeNull();
  });

  test("pickBlueprint needs new work in an empty project", () => {
    const root = temp("depo bp pick");
    expect(pickBlueprint("full", "a booking system", root)?.id).toBe("fullstack");
    expect(pickBlueprint("backend", "fix the login bug", root)).toBeNull();
    expect(pickBlueprint("backend", "build an orders API", root)?.id).toBe("fastapi-service");
    fs.writeFileSync(path.join(root, "main.py"), "print('hi')\n");
    expect(pickBlueprint("full", "a booking system", root)).toBeNull();
    expect(blueprintHint("build a todo app with login", root)).toBe("");
  });

  test("the single coder is told about the closest blueprint only in an empty project", () => {
    const empty = temp("depo bp coder");
    const p = codingSystemPrompt({
      projectName: "Shop",
      root: empty,
      request: "build a shop web app with login",
    });
    expect(p).toContain("use_blueprint fullstack");
    const code = temp("depo bp coder code");
    fs.writeFileSync(path.join(code, "app.py"), "x = 1\n");
    expect(
      codingSystemPrompt({ projectName: "Shop", root: code, request: "build a shop with login" }),
    ).not.toContain("This project is empty");
  });

  test("withBlueprint adds the step before the first build task, and every builder waits for it", () => {
    const bp = findBlueprint("fullstack") as NonNullable<ReturnType<typeof findBlueprint>>;
    const nodes = [
      {
        id: "brief",
        title: "Brief",
        owner: "project-management",
        deps: [] as string[],
        criteria: [] as string[],
      },
      { id: "database", title: "Schema", owner: "database", deps: ["brief"], criteria: [] as string[] },
      { id: "backend", title: "API", owner: "backend", deps: ["database"], criteria: [] as string[] },
      { id: "security", title: "Audit", owner: "security", deps: ["backend"], criteria: [] as string[] },
    ];
    const out = withBlueprint(nodes, bp, "integration");
    expect(out.map((n) => n.id)).toEqual(["brief", BLUEPRINT_STEP, "database", "backend", "security"]);
    const step = out[1];
    expect(step?.title).toBe("Start from the Full stack app blueprint");
    expect(step?.owner).toBe("integration");
    expect(step?.criteria?.join(" ")).toContain("use_blueprint fullstack");
    expect(step?.deps).toEqual([]);
    expect(out.find((n) => n.id === "database")?.deps).toEqual(["brief", BLUEPRINT_STEP]);
    expect(out.find((n) => n.id === "backend")?.deps).toEqual(["database", BLUEPRINT_STEP]);
    expect(out.find((n) => n.id === "security")?.deps).toEqual(["backend"]);
    // The input is left as it was.
    expect(nodes[1]?.deps).toEqual(["brief"]);
  });

  test("withBlueprint keeps the Manager's own blueprint step, moved before the code, without loops", () => {
    const bp = findBlueprint("fastapi-service") as NonNullable<ReturnType<typeof findBlueprint>>;
    const nodes = [
      { id: "database", title: "Schema", owner: "database", deps: [] as string[] },
      { id: "start", title: "Start from the blueprint", owner: "backend", deps: ["database"] },
      { id: "backend", title: "API", owner: "backend", deps: ["start"] },
    ];
    const out = withBlueprint(nodes, bp, "backend");
    expect(out.length).toBe(3);
    const step = out.find((n) => n.id === "start");
    expect(step?.deps).toEqual([]);
    expect(step?.title).toBe("Start from the FastAPI service blueprint");
    expect(out.find((n) => n.id === "database")?.deps).toEqual(["start"]);
    expect(out.find((n) => n.id === "backend")?.deps).toEqual(["start"]);
    expect(summaryWithBlueprint("Build the shop", bp)).toBe(
      "Build the shop. Starts from the FastAPI service blueprint (fastapi-service).",
    );
    expect(summaryWithBlueprint("Uses the FastAPI service blueprint.", bp)).toBe(
      "Uses the FastAPI service blueprint.",
    );
    expect(summaryWithBlueprint("", bp)).toBe("Starts from the FastAPI service blueprint (fastapi-service).");
  });

  async function planFor(folder: (dir: string) => void, text: string) {
    const fake = startFakeOllama();
    stopFake = fake.stop;
    const t = temp("depo bp plan");
    const e = createEngine({
      dataRoot: path.join(t, "data"),
      token: TEST_TOKEN,
      heartbeatMs: 60_000,
      tasks: { retryDelayMs: 10 },
    });
    engine = e;
    await e.start();
    e.models.setProviders([{ id: "ollama", kind: "ollama", baseUrl: fake.url, enabled: true }]);
    e.models.assign("coder", { providerId: "ollama", model: "qwen2.5-coder:1.5b" });
    e.settings.set("team.approve_plan", true);
    const proj = path.join(t, "shop project");
    fs.mkdirSync(proj);
    folder(proj);
    const project = await e.projects.open(proj);
    const events: string[] = [];
    e.bus.subscribe((ev) => events.push(ev.text));
    const task = e.tasks.send(project.id, text, undefined, "full");
    const deadline = Date.now() + 20_000;
    while (e.approvals.list().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    const plan = e.tasks.teamState(task.id).plan;
    const [req] = e.approvals.list();
    e.approvals.respond(req?.id ?? "", false);
    await e.tasks.settled(task.id);
    const board = e.tasks.blackboard.read(project.id, "design-reference.md")?.content ?? "";
    return Object.assign(plan ?? { nodes: [], summary: "" }, { events, board, ok: !!plan });
  }

  test("a build on an empty project: Depo writes the blueprint before the team plans, and says so", async () => {
    const plan = await planFor(
      (dir) => fs.writeFileSync(path.join(dir, "README.md"), "# Shop\n"),
      "build an online shop with login",
    );
    expect(plan.ok).toBe(true);
    expect(
      plan.events.some((t) => /^Started from Depo's Full stack app blueprint \(\d+ files, tested\)$/.test(t)),
    ).toBe(true);
    // The agents extend it instead of planning a blueprint step of their own.
    expect(plan.nodes.some((n) => n.id === BLUEPRINT_STEP)).toBe(false);
    expect(plan.board).toContain("Depo already wrote the Full stack app starting project");
  }, 60_000);

  test("a build plan on a project with code does not mention a blueprint", async () => {
    const plan = await planFor((dir) => {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"shop"}');
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");
    }, "build an online shop with login");
    expect(plan.ok).toBe(true);
    expect(plan.nodes.some((n) => /blueprint/i.test(`${n.id} ${n.title}`))).toBe(false);
    expect(plan.summary).not.toMatch(/blueprint/i);
    expect(plan.events.some((t) => t.startsWith("Started from Depo's"))).toBe(false);
  }, 60_000);
});

describe("blueprint RPCs over WebSocket", () => {
  test("list, get, and create a project with a first commit when git is ready", async () => {
    const t = temp("depo bp rpc");
    const e = createEngine({ dataRoot: path.join(t, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    const { port } = await e.start();

    const list = await rpc(port, "blueprints.list", {});
    const listed = (list.result as { blueprints: { id: string; fileCount: number; features: string[] }[] })
      .blueprints;
    expect(listed.map((b) => b.id)).toEqual([
      "fullstack",
      "next-bun-mysql",
      "fastapi-service",
      "react-web-app",
    ]);
    expect(listed.every((b) => b.fileCount > 10 && b.features.length > 0)).toBe(true);

    const got = await rpc(port, "blueprints.get", { id: "react-web-app" });
    const detail = got.result as {
      files: { path: string; size: number }[];
      totalBytes: number;
      extendGuide: string;
    };
    expect(detail.files.find((f) => f.path === "src/App.tsx")?.size).toBeGreaterThan(100);
    expect(detail.totalBytes).toBeGreaterThan(10_000);
    expect(detail.extendGuide.length).toBeGreaterThan(100);
    expect((await rpc(port, "blueprints.get", { id: "nope" })).error).toBeTruthy();

    const parent = path.join(t, "my projects");
    fs.mkdirSync(parent);
    const created = await rpc(port, "blueprints.create", {
      id: "fastapi-service",
      parentDir: parent,
      name: "Shop API",
      description: "Orders and stock.",
    });
    expect(created.error).toBeUndefined();
    const res = created.result as {
      project: {
        id: string;
        rootPath: string;
        origin: string;
        isGit: boolean;
        stack: string;
        description: string;
      };
      files: number;
      git: "committed" | "initialized" | "skipped";
    };
    expect(res.project.origin).toBe("created");
    expect(res.project.rootPath).toBe(path.join(parent, "Shop API"));
    expect(res.project.stack).toContain("FastAPI");
    expect(res.project.description).toBe("Orders and stock.");
    expect(res.files).toBe(findBlueprint("fastapi-service")?.files({ name: "Shop API" }).length);
    // The folder stays empty but for the README: the first task writes the blueprint into its
    // private copy, so the starting project and the work arrive together in one review.
    expect(fs.existsSync(path.join(res.project.rootPath, "app", "main.py"))).toBe(false);
    expect(fs.readdirSync(res.project.rootPath).filter((f) => f !== ".git")).toEqual(["README.md"]);
    expect(fs.readFileSync(path.join(res.project.rootPath, "README.md"), "utf8")).toContain(
      "Orders and stock.",
    );
    expect(e.registry.getSettings(res.project.id).starter).toBe("fastapi-service");
    expect(res.project.isGit).toBe(res.git !== "skipped");
    // The agents learn which starting point the owner chose.
    expect(e.memory.list(res.project.id).some((m) => m.text.includes("FastAPI service blueprint"))).toBe(
      true,
    );

    // Without git, and refusals: an unknown blueprint, a name that is taken, a bad name.
    const plain = await rpc(port, "blueprints.create", {
      id: "react-web-app",
      parentDir: parent,
      name: "Shop Web",
      initGit: false,
    });
    const p2 = plain.result as { project: { rootPath: string; isGit: boolean }; git: string };
    expect(p2.git).toBe("skipped");
    expect(p2.project.isGit).toBe(false);
    expect(fs.existsSync(path.join(p2.project.rootPath, ".git"))).toBe(false);
    expect(
      (await rpc(port, "blueprints.create", { id: "nope", parentDir: parent, name: "X" })).error,
    ).toBeTruthy();
    expect(
      (await rpc(port, "blueprints.create", { id: "fullstack", parentDir: parent, name: "Shop API" })).error,
    ).toBeTruthy();
    expect(
      (await rpc(port, "blueprints.create", { id: "fullstack", parentDir: parent, name: "../up" })).error,
    ).toBeTruthy();
    expect(fs.readdirSync(parent).sort()).toEqual(["Shop API", "Shop Web"]);
  }, 60_000);
});

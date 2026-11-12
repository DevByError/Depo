import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent, PageCheck, PreviewInfo } from "@depo/shared";
import { MANIFESTS } from "../src/agents/manifests";
import {
  normalizeFile,
  parseCargoShort,
  parseCompileall,
  parseEslintStylish,
  parseGithubAnnotations,
  parseGoVet,
  parseMypy,
  parsePyrightJson,
  parseRuffJson,
  parseTsc,
  sortProblems,
} from "../src/diagnostics/parsers";
import { planDiagnostics, projectFolders } from "../src/diagnostics/plan";
import { crashesFromLog, mergeRuntime, pageCheckProblems, previewProblems } from "../src/diagnostics/runtime";
import { formatForAgent } from "../src/diagnostics/service";
import { createEngine, type Engine } from "../src/engine";
import { executeTool, TOOLS, type ToolContext } from "../src/tools/index";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

const lines = (...l: string[]) => l.join("\n");
const WIN = { root: "C:\\Users\\Me\\My App", cwd: "C:\\Users\\Me\\My App" };
const POSIX = { root: "/home/me/my app", cwd: "/home/me/my app" };

describe("diagnostics parsers (real tool output)", () => {
  test("tsc: file(line,col), codes, Windows backslashes, global errors and continuation lines", () => {
    const out = lines(
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src\\b.ts(2,19): error TS7006: Parameter 'a' implicitly has an 'any' type.",
      "src/c.ts(3,5): error TS2322: Type '{ a: number; }' is not assignable to type 'B'.",
      "  Object literal may only specify known properties, and 'a' does not exist in type 'B'.",
      "error TS5083: Cannot read file 'C:/x/tsconfig.base.json'.",
    );
    const p = parseTsc(out, WIN);
    expect(p).toHaveLength(4);
    expect(p[0]).toEqual({
      tool: "tsc",
      severity: "error",
      file: "src/a.ts",
      line: 1,
      column: 7,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    });
    expect(p[1]?.file).toBe("src/b.ts");
    expect(p[2]?.message).toContain("\nObject literal may only specify known properties");
    expect(p[3]).toMatchObject({ file: null, line: null, code: "TS5083" });
  });

  test("Biome GitHub annotations with absolute paths and escapes", () => {
    const out = lines(
      "::error title=lint/suspicious/noDoubleEquals,file=/home/me/my app/src/a.ts,line=5,endLine=5,col=7,endColumn=9::Using == may be unsafe if you are relying on type coercion.",
      "::warning title=lint/style/useConst,file=src/b.ts,line=2,col=1::Use const%2C not let.",
      "lint ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "  × Some errors were emitted while running checks.",
    );
    const p = parseGithubAnnotations(out, POSIX, "biome");
    expect(p).toEqual([
      {
        tool: "biome",
        severity: "error",
        file: "src/a.ts",
        line: 5,
        column: 7,
        code: "lint/suspicious/noDoubleEquals",
        message: "Using == may be unsafe if you are relying on type coercion.",
      },
      {
        tool: "biome",
        severity: "warning",
        file: "src/b.ts",
        line: 2,
        column: 1,
        code: "lint/style/useConst",
        message: "Use const, not let.",
      },
    ]);
  });

  test("ESLint stylish: file headers, errors, warnings, parse errors without a rule", () => {
    const out = lines(
      "",
      "C:\\Users\\Me\\My App\\app.js",
      "  1:7  error    'a' is assigned a value but never used  no-unused-vars",
      "  2:1  warning  Unexpected console statement            no-console",
      "",
      "C:\\Users\\Me\\My App\\src\\broken.js",
      "  3:10  error  Parsing error: Unexpected token (",
      "",
      "✖ 3 problems (2 errors, 1 warning)",
    );
    const p = parseEslintStylish(out, WIN);
    expect(p.map((x) => [x.file, x.line, x.column, x.severity, x.code])).toEqual([
      ["app.js", 1, 7, "error", "no-unused-vars"],
      ["app.js", 2, 1, "warning", "no-console"],
      ["src/broken.js", 3, 10, "error", null],
    ]);
    expect(p[0]?.message).toBe("'a' is assigned a value but never used");
    expect(p[2]?.message).toBe("Parsing error: Unexpected token (");
  });

  test("Ruff JSON: syntax errors and undefined names are errors, style rules warnings", () => {
    const out = JSON.stringify([
      {
        code: "invalid-syntax",
        filename: "/home/me/my app/bad.py",
        location: { row: 7, column: 1 },
        message: "unexpected EOF while parsing",
        severity: "error",
      },
      {
        code: "F401",
        filename: "/home/me/my app/ok.py",
        location: { row: 1, column: 8 },
        message: "`sys` imported but unused",
      },
      {
        code: "F821",
        filename: "/home/me/my app/pkg/m.py",
        location: { row: 4, column: 12 },
        message: "Undefined name `y`",
      },
      {
        code: null,
        filename: "/home/me/my app/old.py",
        location: { row: 2, column: 1 },
        message: "SyntaxError: invalid syntax",
      },
    ]);
    const p = parseRuffJson(out, POSIX);
    expect(p?.map((x) => [x.file, x.line, x.severity, x.code])).toEqual([
      ["bad.py", 7, "error", "invalid-syntax"],
      ["ok.py", 1, "warning", "F401"],
      ["pkg/m.py", 4, "error", "F821"],
      ["old.py", 2, "error", null],
    ]);
    expect(parseRuffJson("ruff crashed", POSIX)).toBeNull();
  });

  test("compileall: the file, line and the error line", () => {
    const out = lines(
      "*** Error compiling '.\\app\\bad.py'...",
      '  File ".\\app\\bad.py", line 6',
      '    print("hi"',
      "         ^",
      "SyntaxError: '(' was never closed",
      "",
    );
    expect(parseCompileall(out, WIN)).toEqual([
      {
        tool: "compileall",
        severity: "error",
        file: "app/bad.py",
        line: 6,
        column: null,
        code: "SyntaxError",
        message: "SyntaxError: '(' was never closed",
      },
    ]);
  });

  test("mypy, Pyright, go vet and cargo check", () => {
    const mypy = parseMypy(
      lines(
        'typed.py:2:12: error: Incompatible return value type (got "str", expected "int")  [return-value]',
        "typed.py:2:12: note: See https://mypy.readthedocs.io",
      ),
      POSIX,
    );
    expect(mypy).toEqual([
      {
        tool: "mypy",
        severity: "error",
        file: "typed.py",
        line: 2,
        column: 12,
        code: "return-value",
        message: 'Incompatible return value type (got "str", expected "int")',
      },
    ]);

    const pyright = parsePyrightJson(
      JSON.stringify({
        version: "1.1.414",
        generalDiagnostics: [
          {
            file: "/home/me/my app/bad.py",
            severity: "error",
            message: '"y" is not defined',
            range: { start: { line: 3, character: 11 }, end: { line: 3, character: 12 } },
            rule: "reportUndefinedVariable",
          },
          {
            file: "/home/me/my app/x.py",
            severity: "information",
            message: "note",
            range: { start: { line: 0, character: 0 } },
          },
        ],
      }),
      POSIX,
    );
    expect(pyright?.map((x) => [x.file, x.line, x.column, x.severity, x.code])).toEqual([
      ["bad.py", 4, 12, "error", "reportUndefinedVariable"],
      ["x.py", 1, 1, "info", null],
    ]);

    const vet = parseGoVet(
      lines(
        "# example.com/demo/sub",
        "vet: sub/sub.go:4:9: undefined: undefinedThing",
        "# example.com/demo",
        "./main.go:7:2: fmt.Printf format %d has arg s of wrong type string",
      ),
      { root: "/home/me/my app", cwd: "/home/me/my app/backend" },
    );
    expect(vet.map((x) => [x.file, x.line, x.column, x.severity])).toEqual([
      ["backend/sub/sub.go", 4, 9, "error"],
      ["backend/main.go", 7, 2, "warning"],
    ]);

    const cargo = parseCargoShort(
      lines(
        "    Checking demo v0.1.0 (/home/me/my app)",
        "src/main.rs:3:20: error[E0425]: cannot find value `y` in this scope",
        "src/main.rs:2:9: warning: unused variable: `x`: help: if this is intentional, prefix it with an underscore: `_x`",
        'error: could not compile `demo` (bin "demo") due to 1 previous error',
      ),
      POSIX,
    );
    expect(cargo.map((x) => [x.file, x.line, x.severity, x.code])).toEqual([
      ["src/main.rs", 3, "error", "E0425"],
      ["src/main.rs", 2, "warning", null],
    ]);
  });

  test("paths: inside the root become relative (any case on Windows), outside stay absolute", () => {
    expect(normalizeFile("c:\\users\\me\\my app\\src\\x.ts", WIN)).toBe("src/x.ts");
    expect(normalizeFile("../shared/y.ts", { root: WIN.root, cwd: `${WIN.root}\\frontend` })).toBe(
      "shared/y.ts",
    );
    expect(normalizeFile("/usr/lib/python3/site.py", POSIX)).toBe("/usr/lib/python3/site.py");
    const sorted = sortProblems([
      { tool: "a", severity: "warning", file: "a.ts", line: 1, column: 1, code: null, message: "w" },
      { tool: "a", severity: "error", file: "b.ts", line: 9, column: 1, code: null, message: "e2" },
      { tool: "a", severity: "error", file: "b.ts", line: 2, column: 1, code: null, message: "e1" },
      { tool: "a", severity: "error", file: "b.ts", line: 2, column: 1, code: null, message: "e1" },
    ]);
    expect(sorted.map((p) => p.message)).toEqual(["e1", "e2", "w"]);
  });
});

/** A project folder with the given files (content "" = empty file). */
function makeProject(files: Record<string, string>): string {
  const t = tempDir("depo diag");
  cleanup = t.cleanup;
  const root = path.join(t.dir, "my app");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe("detecting what to run", () => {
  test("TypeScript, Biome and ESLint from node_modules; Windows command lines; sub-projects", () => {
    const root = makeProject({
      "tsconfig.json": '{ "compilerOptions": { "strict": true } }',
      "biome.json": "{}",
      "node_modules/.bin/tsc.cmd": "",
      "node_modules/.bin/biome.cmd": "",
      "frontend/package.json": '{ "name": "web" }',
      "frontend/eslint.config.js": "export default [];",
      "frontend/node_modules/.bin/eslint.cmd": "",
      "frontend/tsconfig.json": "{}",
    });
    expect(projectFolders(root)).toEqual(["", "frontend"]);
    const plan = planDiagnostics(root, { win: true, find: () => null, cacheDir: "C:\\cache", cacheKey: "p" });
    expect(plan.tools.map((t) => [t.label, t.command])).toEqual([
      ["tsc", "node_modules\\.bin\\tsc.cmd --noEmit --pretty false -p tsconfig.json"],
      ["biome", "node_modules\\.bin\\biome.cmd lint --reporter=github ."],
      ["tsc (frontend)", "..\\node_modules\\.bin\\tsc.cmd --noEmit --pretty false -p tsconfig.json"],
      ["eslint (frontend)", "node_modules\\.bin\\eslint.cmd . --no-color"],
    ]);
    expect(plan.tools[2]?.cwd).toBe(path.join(root, "frontend"));
    expect(plan.skipped).toEqual([]);
  });

  test("missing tools are skipped with a plain reason; nothing is installed", () => {
    const root = makeProject({
      "tsconfig.json": "{}",
      ".eslintrc.json": "{}",
      "app/main.py": "print('hi')\n",
      "pyproject.toml": "[tool.mypy]\nstrict = true\n",
      "svc/go.mod": "module x\n",
      "Cargo.toml": "[package]\nname='x'\n",
    });
    const plan = planDiagnostics(root, { win: false, find: () => null, cacheDir: "/cache", cacheKey: "p" });
    expect(plan.tools).toEqual([]);
    expect(plan.skipped.map((s) => [s.tool, s.configured])).toEqual([
      ["tsc", true],
      ["eslint", true],
      ["python", true],
      ["mypy", true],
      ["cargo check", true],
      ["go vet (svc)", true],
    ]);
    expect(plan.skipped[0]?.reason).toBe(
      "TypeScript is not installed in node_modules. Install the project's packages first.",
    );
    expect(plan.skipped.find((s) => s.tool === "python")?.reason).toBe("Python is not installed on this PC.");
  });

  test("Python: ruff when installed (never fixing), else compileall without writing into the project", () => {
    const root = makeProject({ "requirements.txt": "fastapi\n", "app/main.py": "x = 1\n" });
    const withRuff = planDiagnostics(root, {
      win: true,
      find: (exe) => (exe === "ruff" || exe === "python" ? `C:\\Py\\${exe}.exe` : null),
      cacheDir: "C:\\cache",
      cacheKey: "p",
    });
    expect(withRuff.tools.map((t) => t.command)).toEqual([
      "ruff check --output-format=json --no-cache --no-fix .",
    ]);
    const noRuff = planDiagnostics(root, {
      win: true,
      find: (exe) => (exe === "python" ? "C:\\Python312\\python.exe" : null),
      cacheDir: "C:\\cache",
      cacheKey: "prj 1",
    });
    expect(noRuff.tools[0]?.id).toBe("compileall");
    expect(noRuff.tools[0]?.command).toStartWith("python -m compileall -q -x ");
    expect(noRuff.tools[0]?.env.PYTHONPYCACHEPREFIX).toBe(path.join("C:\\cache", "pycache", "prj_1"));
    expect(noRuff.skipped).toEqual([
      {
        tool: "ruff",
        reason: "Ruff is not installed, so Depo checked Python syntax only.",
        configured: false,
      },
    ]);
    // The Microsoft Store placeholder is not Python.
    const store = planDiagnostics(root, {
      win: true,
      find: (exe) =>
        exe === "python" ? "C:\\Users\\Me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe" : null,
      cacheDir: "C:\\cache",
      cacheKey: "p",
    });
    expect(store.tools).toEqual([]);
    expect(store.skipped[0]?.tool).toBe("python");
  });

  test("go vet and cargo check never download anything", () => {
    const root = makeProject({ "go.mod": "module x\n", "rs/Cargo.toml": "[package]\nname='x'\n" });
    const plan = planDiagnostics(root, {
      win: false,
      find: (exe) => `/usr/bin/${exe}`,
      cacheDir: "/cache",
      cacheKey: "p",
    });
    const go = plan.tools.find((t) => t.id === "go vet");
    expect(go?.env).toMatchObject({ GOPROXY: "off", GOTOOLCHAIN: "local" });
    const cargo = plan.tools.find((t) => t.id === "cargo check");
    expect(cargo?.command).toContain("--offline");
    expect(cargo?.env.CARGO_TARGET_DIR).toStartWith(path.join("/cache"));
    expect(cargo?.label).toBe("cargo check (rs)");
  });
});

describe("runtime problems", () => {
  const ROOT = "C:\\proj";
  test("Python tracebacks and JavaScript stacks point at the innermost project frame", () => {
    const log = [
      "INFO:     Started server process [1234]",
      "Traceback (most recent call last):",
      '  File "C:\\proj\\.venv\\Lib\\site-packages\\starlette\\routing.py", line 74, in app',
      "    response = await func(request)",
      '  File "C:\\proj\\app\\main.py", line 12, in read_item',
      "    return 1 / 0",
      "           ~~^~~",
      "ZeroDivisionError: division by zero",
      "GET /items 500",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "    at render (C:\\proj\\src\\App.jsx:8:20)",
      "    at node:internal/process/task_queues:95:5",
      "Error: is not a crash without a stack",
    ];
    const crashes = crashesFromLog(log, ROOT);
    expect(crashes).toHaveLength(2);
    expect(crashes[0]).toMatchObject({
      message: "ZeroDivisionError: division by zero",
      file: "app/main.py",
      line: 12,
    });
    expect(crashes[0]?.excerpt[0]).toBe("Traceback (most recent call last):");
    expect(crashes[1]).toMatchObject({
      message: "TypeError: Cannot read properties of undefined (reading 'map')",
      file: "src/App.jsx",
      line: 8,
      column: 20,
    });
  });

  test("a preview that stopped with an error and console errors from a page check", () => {
    const info = {
      id: "prv_1",
      state: "failed",
      exitCode: 1,
      error: "The app stopped (exit code 1).",
      startedAt: "2026-11-07T10:00:00.000Z",
      stoppedAt: "2026-11-07T10:00:05.000Z",
    } as PreviewInfo;
    const p = previewProblems(
      [{ info, lines: [{ seq: 1, stream: "err", text: "ModuleNotFoundError: No module named 'x'" }] }],
      ROOT,
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      source: "preview",
      severity: "error",
      code: "exit 1",
      message: "The app stopped (exit code 1).",
    });
    expect(p[0]?.excerpt).toContain("ModuleNotFoundError");

    const view = (width: "phone" | "desktop") => ({
      width,
      consoleErrors: [
        {
          kind: "exception",
          text: "ReferenceError: foo is not defined",
          source: "http://127.0.0.1:5173/src/App.tsx?t=1:12:5",
        },
      ],
    });
    const check = {
      id: "qa_1",
      url: "http://127.0.0.1:5173/",
      at: "2026-11-07T10:01:00.000Z",
      views: [view("phone"), view("desktop")],
    } as unknown as PageCheck;
    const c = pageCheckProblems(check, (rel) => rel === "src/App.tsx");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      source: "page check",
      file: "src/App.tsx",
      line: 12,
      count: 2,
      code: "exception",
    });
    const merged = mergeRuntime([...p, ...c, ...c.map((x) => ({ ...x }))]);
    expect(merged.map((m) => [m.source, m.count])).toEqual([
      ["page check", 4],
      ["preview", 1],
    ]);
  });
});

describe("diagnostics service and the agent tool", () => {
  /** A project whose "tsc" is a tiny script printing one tsc error (a .cmd on Windows). */
  function fakeTscProject() {
    const t = tempDir("depo diag svc");
    cleanup = t.cleanup;
    const root = path.join(t.dir, "my app");
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const n: number = 'x';\n");
    const msg = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(root, "node_modules", ".bin", "tsc.cmd"),
        `@echo off\r\necho ${msg}\r\nexit /b 2\r\n`,
      );
    } else {
      const bin = path.join(root, "node_modules", ".bin", "tsc");
      fs.writeFileSync(bin, `#!/bin/sh\necho "${msg}"\nexit 2\n`);
      fs.chmodSync(bin, 0o755);
    }
    return { root, dataRoot: path.join(t.dir, "data") };
  }

  test("runs the installed tools, keeps the newest result in the readiness shape, tells the feed", async () => {
    const { root, dataRoot } = fakeTscProject();
    engine = createEngine({ dataRoot, token: TEST_TOKEN, heartbeatMs: 60_000 });
    const project = await engine.projects.open(root);
    const events: DepoEvent[] = [];
    engine.bus.subscribe((e) => {
      if (e.type === "linting") events.push(e);
    });
    expect(engine.diagnostics.latest(project.id, null)).toBeNull();
    const r = await engine.diagnostics.run({ projectId: project.id, taskId: null });
    expect(r.tools).toEqual(["tsc"]);
    expect(r.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(r.problems[0]).toMatchObject({
      file: "src/a.ts",
      line: 1,
      column: 7,
      code: "TS2322",
      tool: "tsc",
    });
    expect(r.runs[0]).toMatchObject({ tool: "tsc", exitCode: 2, problems: 1, error: null });
    const latest = engine.diagnostics.latest(project.id, null);
    expect(latest).toMatchObject({ tools: ["tsc"], skipped: [], counts: { error: 1, warning: 0, info: 0 } });
    expect(typeof latest?.at).toBe("string");
    expect(engine.diagnostics.latest(project.id, "tsk_other")).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("Diagnostics (tsc): 1 error");
    expect(events[0]?.taskId).toBeNull();
    // A project rule can block a tool; it is then listed as skipped.
    const exe = r.runs[0]?.command.split(" ")[0] ?? "";
    engine.registry.setSettings(project.id, { commandDeny: [exe] });
    const blocked = await engine.diagnostics.run({ projectId: project.id, taskId: null });
    expect(blocked.tools).toEqual([]);
    expect(blocked.skipped).toEqual(["tsc"]);
    expect(blocked.notes[0]?.reason).toBe("Blocked by this project's command rules.");
  });

  test("the diagnostics tool: available to the right agents, compact and worst first", async () => {
    const { root, dataRoot } = fakeTscProject();
    engine = createEngine({ dataRoot, token: TEST_TOKEN, heartbeatMs: 60_000 });
    const project = await engine.projects.open(root);
    expect(TOOLS.some((t) => t.name === "diagnostics")).toBe(true);
    const withTool = MANIFESTS.filter((m) => m.tools.includes("diagnostics")).map((m) => m.id);
    expect(withTool.sort()).toEqual(["backend", "enhancement", "frontend", "integration", "testing"]);
    const ctx: ToolContext = {
      root,
      bus: engine.bus,
      approvals: engine.approvals,
      projectId: project.id,
      taskId: "tsk_test",
      agent: "backend@1.0.0",
      diagnostics: engine.diagnostics,
    };
    const res = await executeTool("diagnostics", {}, ctx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain("Checked (tsc): 1 error.");
    expect(res.content).toContain(
      "error src/a.ts:1:7: TS2322 Type 'string' is not assignable to type 'number'.",
    );
    expect(res.content).toContain("Fix the errors you introduced");
    const none = await executeTool("diagnostics", {}, { ...ctx, diagnostics: undefined });
    expect(none.isError).toBe(true);
    expect(none.content).toContain("only available while working on a project task");
  });

  test("the agent's list stays under about 1500 characters, errors before warnings", () => {
    const problems = Array.from({ length: 80 }, (_, i) => ({
      tool: "eslint",
      severity: i % 2 ? ("warning" as const) : ("error" as const),
      file: `src/file${i}.ts`,
      line: i + 1,
      column: 1,
      code: "rule",
      message: `Problem number ${i} with a fairly long explanation of what is wrong here`,
    }));
    const sorted = sortProblems(problems);
    const text = formatForAgent({
      projectId: "p",
      taskId: "t",
      target: "Task",
      at: "",
      durationMs: 1,
      tools: ["eslint"],
      skipped: ["mypy"],
      notes: [],
      counts: { error: 40, warning: 40, info: 0 },
      problems: sorted,
      truncated: false,
      runs: [],
      by: "frontend@1.0.0",
    });
    expect(text.length).toBeLessThanOrEqual(1600);
    const body = text.split("\n").slice(1);
    expect(body[0]).toStartWith("error ");
    expect(text).toContain("more not shown");
    expect(text).toContain("Not checked: mypy.");
  });
});

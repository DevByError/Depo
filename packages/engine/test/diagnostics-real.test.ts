import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createEngine, type Engine } from "../src/engine";
import { whichSync } from "../src/security/scanners";
import { TEST_TOKEN, tempDir } from "./helpers";

/**
 * Diagnostics with the real tools, end to end through the service (policy, contained shell,
 * parsers). Each case is skipped when its tool is not installed on this PC, so the suite passes
 * everywhere and proves the parsers on real output wherever the tools exist.
 */

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

const has = (exe: string) => {
  const p = whichSync(exe);
  return !!p && !/[\\/]WindowsApps[\\/]/i.test(p);
};
const PYTHON = process.platform === "win32" ? "python" : "python3";

async function check(files: Record<string, string>) {
  const t = tempDir("depo diag real");
  cleanup = t.cleanup;
  const root = path.join(t.dir, "my app");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  const project = await engine.projects.open(root);
  const result = await engine.diagnostics.run({ projectId: project.id, taskId: null });
  return { result, root };
}

test.skipIf(!has("ruff"))(
  "ruff finds a syntax error and an unused import, and fixes nothing",
  async () => {
    const bad = 'import os\n\nprint("hi"\n';
    const { result, root } = await check({
      "requirements.txt": "",
      "app/bad.py": bad,
      "app/ok.py": "import sys\nx = 1\n",
    });
    expect(result.tools).toEqual(["ruff"]);
    expect(result.runs[0]?.error).toBeNull();
    const files = result.problems.map((p) => [p.file, p.severity]);
    expect(files).toContainEqual(["app/bad.py", "error"]);
    expect(result.problems.some((p) => p.file === "app/ok.py" && p.code === "F401")).toBe(true);
    expect(fs.readFileSync(path.join(root, "app/bad.py"), "utf8")).toBe(bad);
    expect(fs.existsSync(path.join(root, ".ruff_cache"))).toBe(false);
  },
  60_000,
);

test.skipIf(!has(PYTHON))(
  "compileall finds a syntax error without writing __pycache__ into the project",
  async () => {
    const t = tempDir("depo diag py");
    cleanup = t.cleanup;
    const root = path.join(t.dir, "py app");
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", "bad.py"), "def f(:\n    pass\n");
    fs.writeFileSync(path.join(root, "pkg", "good.py"), "x = 1\n");
    engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    // Pretend ruff is missing so the fallback runs.
    const project = await engine.projects.open(root);
    const { DiagnosticsService } = await import("../src/diagnostics/service");
    const svc = new DiagnosticsService({
      bus: engine.bus,
      logger: engine.logger,
      sqlite: engine.database.sqlite,
      cacheDir: path.join(t.dir, "data", "diagnostics"),
      projectRoot: () => root,
      workspaceRoot: () => null,
      taskProject: () => null,
      taskTitle: () => null,
      commandRules: () => null,
      find: (exe, env) => (exe === "ruff" ? null : whichSync(exe, env)),
    });
    const r = await svc.run({ projectId: project.id, taskId: null });
    expect(r.tools).toEqual(["compileall"]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({
      file: "pkg/bad.py",
      line: 1,
      severity: "error",
      tool: "compileall",
    });
    expect(fs.existsSync(path.join(root, "pkg", "__pycache__"))).toBe(false);
  },
  60_000,
);

test.skipIf(!has("go"))(
  "go vet: a type error is an error, a vet finding a warning, nothing downloaded",
  async () => {
    const { result } = await check({
      "go.mod": "module example.com/demo\n\ngo 1.21\n",
      "main.go": 'package main\n\nimport "fmt"\n\nfunc main() {\n\ts := "x"\n\tfmt.Printf("%d\\n", s)\n}\n',
      "sub/sub.go": "package sub\n\nfunc F() int {\n\treturn undefinedThing\n}\n",
    });
    expect(result.tools).toEqual(["go vet"]);
    expect(result.problems.map((p) => [p.file, p.line, p.severity])).toEqual([
      ["sub/sub.go", 4, "error"],
      ["main.go", 7, "warning"],
    ]);
  },
  120_000,
);

test.skipIf(!has("cargo"))(
  "cargo check: an error with its code, offline, building outside the project",
  async () => {
    const { result, root } = await check({
      "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/main.rs": 'fn main() {\n    let x = 5;\n    println!("{}", y);\n}\n',
    });
    expect(result.tools).toEqual(["cargo check"]);
    expect(result.problems[0]).toMatchObject({
      file: "src/main.rs",
      line: 3,
      severity: "error",
      code: "E0425",
    });
    expect(fs.existsSync(path.join(root, "target"))).toBe(false);
  },
  180_000,
);

test.skipIf(!has("mypy"))(
  "mypy runs when configured, with its cache outside the project",
  async () => {
    const { result, root } = await check({
      "mypy.ini": "[mypy]\n",
      "app/typed.py": 'def g() -> int:\n    return "s"\n',
      "requirements.txt": "",
    });
    expect(result.tools).toContain("mypy");
    const mypy = result.problems.filter((p) => p.tool === "mypy");
    expect(mypy).toHaveLength(1);
    expect(mypy[0]).toMatchObject({ file: "app/typed.py", line: 2, severity: "error", code: "return-value" });
    expect(fs.existsSync(path.join(root, ".mypy_cache"))).toBe(false);
  },
  120_000,
);

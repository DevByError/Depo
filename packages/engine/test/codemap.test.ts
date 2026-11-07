import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiSchema, type RpcResponse } from "@depo/shared";
import { MANIFESTS } from "../src/agents/manifests";
import { analyseSource, regexImports } from "../src/codeindex/analyse";
import { declaredEntries } from "../src/codeindex/codemap";
import {
  areaOf,
  buildGraph,
  buildView,
  groupModules,
  type MapFile,
  mermaidFromView,
  overviewText,
  stronglyConnected,
} from "../src/codeindex/graph";
import { ImportResolver, parseJsonc } from "../src/codeindex/resolve";
import { checkMermaid } from "../src/design/mermaid";
import { createEngine, type Engine } from "../src/engine";
import { CODE_MAP_BUDGET } from "../src/tools/codemap-tools";
import { executeTool, toolDefinitions } from "../src/tools/index";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function resolverFor(files: Record<string, string>) {
  return new ImportResolver({ files: Object.keys(files), read: (rel) => files[rel] ?? null });
}

describe("import extraction", () => {
  test("typescript: every import form, never comments or strings", async () => {
    const src = [
      'import x from "./a";',
      "import { b,",
      '  c } from "@/lib/c";',
      'import "./side-effect.css";',
      'export { d } from "../d.js";',
      'export * from "./e";',
      'const f = require("./f");',
      'const g = await import("./g");',
      'import type { T } from "./t";',
      'import h = require("./h");',
      '// import nope from "./comment";',
      "const s = \"import fake from './str'\";",
      "export function run(a: number) { if (a > 1 && a < 5) { return a ? 1 : 2; } for (const i of [1]) {} return 0; }",
    ].join("\n");
    const a = await analyseSource("src/x.ts", "typescript", src);
    expect(a.imports.map((i) => [i.spec, i.kind, i.line])).toEqual([
      ["./a", "import", 1],
      ["@/lib/c", "import", 2],
      ["./side-effect.css", "import", 4],
      ["../d.js", "export", 5],
      ["./e", "export", 6],
      ["./f", "require", 7],
      ["./g", "dynamic", 8],
      ["./t", "type", 9],
      ["./h", "import", 10],
    ]);
    // if, &&, ternary, for: four branches inside the exported function.
    expect(a.branches).toBe(4);
    expect(a.symbols.map((s) => s.name)).toContain("run");
  });

  test("python: absolute, aliased, relative and from-imports with several names", async () => {
    const src = [
      "import os, app.db as database",
      "from . import models, schemas as s",
      "from ..core.config import (settings,",
      "    Settings)",
      "from fastapi import *",
      "# import commented",
      "def main(x):",
      "    if x and x > 1:",
      "        return [i for i in range(x) if i]",
      "    return 0",
      "",
      'if __name__ == "__main__":',
      "    main(3)",
    ].join("\n");
    const a = await analyseSource("app/api/routes.py", "python", src);
    expect(a.imports.map((i) => `${i.kind}:${i.spec}:${i.name}`)).toEqual([
      "import:os:",
      "import:app.db:",
      "from:.:models",
      "from:.:schemas",
      "from:..core.config:settings",
      "from:..core.config:Settings",
      "from:fastapi:",
    ]);
    expect(a.entry).toBe("runs as a script");
    expect(a.branches).toBeGreaterThanOrEqual(4);
  });

  test("other languages: best-effort patterns", () => {
    const go =
      'package main\n\nimport (\n  "fmt"\n  db "example.com/shop/internal/db"\n)\n\nimport "example.com/shop/api"\n';
    expect(regexImports("main.go", "go", go).map((i) => i.spec)).toEqual([
      "example.com/shop/api",
      "fmt",
      "example.com/shop/internal/db",
    ]);
    const rs = "mod routes;\npub mod db;\nuse crate::db::pool::Pool;\nuse serde::{Deserialize};\n";
    expect(regexImports("src/main.rs", "rust", rs).map((i) => `${i.kind}:${i.spec}`)).toEqual([
      "mod:routes",
      "mod:db",
      "use:crate::db::pool::Pool",
      "use:serde",
    ]);
    expect(
      regexImports("A.java", "java", "import com.acme.shop.Cart;\nimport static java.util.List.of;\n").length,
    ).toBe(2);
    expect(
      regexImports("a.rb", "ruby", "require_relative 'lib/x'\nrequire 'json'\n").map((i) => i.spec),
    ).toEqual(["./lib/x", "json"]);
    expect(
      regexImports("App.vue", null, '<script setup>\nimport Btn from "./Btn.vue";\n</script>').map(
        (i) => i.spec,
      ),
    ).toEqual(["./Btn.vue"]);
    expect(
      regexImports("index.html", null, '<script type="module" src="/src/main.tsx"></script>').map(
        (i) => i.spec,
      ),
    ).toEqual(["/src/main.tsx"]);
  });
});

describe("import resolution", () => {
  test("typescript: relative, .js to .ts, index files, tsconfig paths with extends, workspace packages", () => {
    const files: Record<string, string> = {
      "tsconfig.base.json": '{ "compilerOptions": { "strict": true } }',
      "apps/web/tsconfig.json": `{
        // comments and trailing commas are fine
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },
      }`,
      "apps/web/src/main.tsx": "",
      "apps/web/src/lib/cn.ts": "",
      "apps/web/src/components/index.ts": "",
      "apps/web/src/util.ts": "",
      "packages/shared/package.json":
        '{ "name": "@acme/shared", "exports": { ".": "./src/index.ts", "./contracts": { "import": "./src/contracts.ts" } } }',
      "packages/shared/src/index.ts": "",
      "packages/shared/src/contracts.ts": "",
    };
    const r = resolverFor(files);
    const from = "apps/web/src/main.tsx";
    const ref = (spec: string) => ({ spec, name: "", kind: "import" });
    expect(r.resolve(from, ref("@/lib/cn"))).toBe("apps/web/src/lib/cn.ts");
    expect(r.resolve(from, ref("./components"))).toBe("apps/web/src/components/index.ts");
    expect(r.resolve(from, ref("./util.js"))).toBe("apps/web/src/util.ts");
    expect(r.resolve(from, ref("@acme/shared"))).toBe("packages/shared/src/index.ts");
    expect(r.resolve(from, ref("@acme/shared/contracts"))).toBe("packages/shared/src/contracts.ts");
    expect(r.resolve(from, ref("react"))).toBeNull();
    expect(r.external(from, ref("@tanstack/react-query/devtools"))).toBe("@tanstack/react-query");
    expect(r.external(from, ref("node:fs"))).toBeNull();
    expect(r.external(from, ref("@/lib/missing"))).toBeNull();
    expect(r.resolve(from, ref("../../../outside"))).toBeNull();
  });

  test("python: packages, relative imports, submodules named in from-imports, src layout", () => {
    const files: Record<string, string> = {
      "src/shop/__init__.py": "",
      "src/shop/main.py": "",
      "src/shop/models/__init__.py": "",
      "src/shop/models/user.py": "",
      "src/shop/core/config.py": "",
      "src/shop/api/routes.py": "",
      "tests/test_api.py": "",
    };
    const r = resolverFor(files);
    const imp = (spec: string, name = "") => ({ spec, name, kind: name ? "from" : "import" });
    expect(r.resolve("src/shop/api/routes.py", imp("..models", "user"))).toBe("src/shop/models/user.py");
    expect(r.resolve("src/shop/api/routes.py", imp("..models", "User"))).toBe("src/shop/models/__init__.py");
    expect(r.resolve("src/shop/api/routes.py", imp("..core.config", "settings"))).toBe(
      "src/shop/core/config.py",
    );
    expect(r.resolve("tests/test_api.py", imp("shop.api.routes"))).toBe("src/shop/api/routes.py");
    expect(r.resolve("tests/test_api.py", imp("shop.core.config.Settings"))).toBe("src/shop/core/config.py");
    expect(r.resolve("tests/test_api.py", imp("fastapi"))).toBeNull();
    expect(r.external("tests/test_api.py", imp("fastapi.testclient"))).toBe("fastapi");
    expect(r.external("tests/test_api.py", imp("os.path"))).toBeNull();
  });

  test("go modules, rust mod and use, java, c includes", () => {
    const files: Record<string, string> = {
      "go.mod": "module example.com/shop\n\ngo 1.22\n",
      "main.go": "",
      "internal/db/db.go": "",
      "internal/db/db_test.go": "",
      "Cargo.toml": "[package]\nname='x'\n",
      "src/main.rs": "",
      "src/routes.rs": "",
      "src/db/mod.rs": "",
      "src/db/pool.rs": "",
      "src/main/java/com/acme/Cart.java": "",
      "src/main/java/com/acme/App.java": "",
      "native/lib.c": "",
      "native/lib.h": "",
    };
    const r = resolverFor(files);
    expect(r.resolve("main.go", { spec: "example.com/shop/internal/db", name: "", kind: "import" })).toBe(
      "internal/db/db.go",
    );
    expect(r.resolve("src/main.rs", { spec: "routes", name: "", kind: "mod" })).toBe("src/routes.rs");
    expect(r.resolve("src/main.rs", { spec: "db", name: "", kind: "mod" })).toBe("src/db/mod.rs");
    expect(r.resolve("src/routes.rs", { spec: "crate::db::pool::Pool", name: "", kind: "use" })).toBe(
      "src/db/pool.rs",
    );
    expect(
      r.resolve("src/main/java/com/acme/App.java", { spec: "com.acme.Cart", name: "", kind: "import" }),
    ).toBe("src/main/java/com/acme/Cart.java");
    expect(r.resolve("native/lib.c", { spec: "lib.h", name: "", kind: "include" })).toBe("native/lib.h");
  });

  test("jsonc parsing keeps slashes inside strings", () => {
    expect(parseJsonc('{ "a": "http://x/*y*/", // c\n "b": [1,], }')).toEqual({ a: "http://x/*y*/", b: [1] });
    expect(parseJsonc("not json")).toBeNull();
  });
});

describe("graph", () => {
  const f = (p: string, lines = 10): MapFile => ({
    path: p,
    lang: "typescript",
    lines,
    symbols: 1,
    branches: 0,
    entry: null,
  });

  test("cycles are found (Tarjan) and listed largest first", () => {
    const adj = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a", "d"])],
      ["d", new Set(["e"])],
      ["e", new Set(["d"])],
      ["f", new Set(["a"])],
    ]);
    expect(stronglyConnected(["a", "b", "c", "d", "e", "f"], adj)).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    // A long chain does not overflow the stack.
    const n = 20_000;
    const chain = new Map<string, Set<string>>();
    for (let i = 0; i < n; i++) chain.set(`n${i}`, new Set([`n${(i + 1) % n}`]));
    expect(stronglyConnected([...chain.keys()], chain)[0]?.length).toBe(n);
  });

  test("folders merge bottom-up until the module count fits", () => {
    const paths = [
      "src/a/x.ts",
      "src/a/deep/one.ts",
      "src/a/deep/two.ts",
      "src/b/y.ts",
      "src/b/z/w.ts",
      "main.ts",
    ];
    const all = groupModules(paths, 10);
    expect(new Set(all.values()).size).toBe(5);
    const four = groupModules(paths, 4);
    expect(new Set(four.values()).size).toBeLessThanOrEqual(4);
    expect(four.get("src/b/z/w.ts")).toBe("src/b");
    expect(four.get("main.ts")).toBe("");
    // Zooming into a folder never merges above it.
    const zoom = groupModules(
      paths.filter((p) => p.startsWith("src/a/")),
      1,
      "src/a",
    );
    expect(new Set(zoom.values())).toEqual(new Set(["src/a"]));
  });

  test("areas come from folder names and file kinds", () => {
    expect(areaOf("apps/web/src/components", ["apps/web/src/components/Button.tsx"])).toBe("ui");
    expect(areaOf("app/api", ["app/api/routes.py"])).toBe("server");
    expect(areaOf("app/models", ["app/models/user.py"])).toBe("data");
    expect(areaOf("tests", ["tests/test_api.py"])).toBe("tests");
    expect(areaOf("scripts", ["scripts/build.ts"])).toBe("tooling");
    expect(areaOf("misc", ["misc/a.ts"])).toBe("other");
  });

  test("module view, cycles flagged on edges, Mermaid that passes the checker, budgeted text", () => {
    const files = [
      f("src/ui/app.tsx", 120),
      f("src/ui/button.tsx"),
      f("src/api/client.ts"),
      f("src/api/auth.ts"),
      f("src/lib/util.ts", 300),
    ];
    const imports = [
      { from: "src/ui/app.tsx", to: "src/ui/button.tsx", library: null },
      { from: "src/ui/app.tsx", to: "src/api/client.ts", library: null },
      { from: "src/api/client.ts", to: "src/lib/util.ts", library: null },
      { from: "src/lib/util.ts", to: "src/api/auth.ts", library: null },
      { from: "src/api/auth.ts", to: "src/lib/util.ts", library: null },
      { from: "src/ui/app.tsx", to: null, library: "react" },
      { from: "src/ui/button.tsx", to: null, library: "react" },
    ];
    const g = buildGraph({
      files,
      imports,
      entries: [{ path: "src/ui/app.tsx", reason: "package.json main" }],
    });
    expect(g.cycles).toEqual([["src/api/auth.ts", "src/lib/util.ts"]]);
    const view = buildView(g, {
      projectId: "p",
      level: "module",
      focus: null,
      indexing: false,
      updatedAt: null,
    });
    expect(view.nodes.map((n) => n.id)).toEqual(["src/api", "src/lib", "src/ui"]);
    // Cycles are listed as files; the modules and module edges they cross are flagged.
    expect(view.cycles).toEqual([["src/api/auth.ts", "src/lib/util.ts"]]);
    expect(view.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual(["src/api", "src/lib"]);
    expect(view.edges.find((e) => e.from === "src/lib" && e.to === "src/api")?.cycle).toBe(true);
    // The api -> lib module edge carries auth.ts -> util.ts, which is part of the cycle.
    expect(view.edges.find((e) => e.from === "src/api" && e.to === "src/lib")?.cycle).toBe(true);
    expect(view.edges.find((e) => e.from === "src/ui" && e.to === "src/api")?.cycle).toBe(false);
    expect(view.summary.libraries).toEqual([{ name: "react", count: 2 }]);
    expect(view.entryPoints[0]).toEqual({ path: "src/ui/app.tsx", reason: "package.json main" });
    expect(view.hotSpots.largest[0]?.path).toBe("src/lib/util.ts");
    expect(view.nodes.find((n) => n.id === "src/ui")?.entry).toBe(true);

    const mmd = mermaidFromView(view, 'My "Shop"');
    const check = checkMermaid(mmd);
    expect(check.issues).toEqual([]);
    expect(mmd).toContain("linkStyle");
    expect(mmd).toContain("class ");
    expect(mmd).not.toContain('My "Shop"');

    const text = overviewText(view, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("Entry points: src/ui/app.tsx");
    expect(text).toContain("Import cycles: src/api/auth.ts <-> src/lib/util.ts");

    // File level around one file: its imports and importers only.
    const around = buildView(g, {
      projectId: "p",
      level: "file",
      focus: "src/lib/util.ts",
      indexing: false,
      updatedAt: null,
    });
    expect(around.nodes.map((n) => n.id).sort()).toEqual([
      "src/api/auth.ts",
      "src/api/client.ts",
      "src/lib/util.ts",
    ]);
    expect(around.nodes.find((n) => n.id === "src/lib/util.ts")?.outside).toBe(false);
  });

  test("type-only imports are dependencies but never cycles; a shared folder alone is no cycle", () => {
    const files = [
      f("tools/index.ts"),
      f("tools/preview.ts"),
      f("main.ts"),
      f("agent/run.ts"),
      f("logger.ts"),
    ];
    const g = buildGraph({
      files,
      imports: [
        { from: "tools/index.ts", to: "tools/preview.ts", library: null },
        { from: "tools/preview.ts", to: "tools/index.ts", library: null, typeOnly: true },
        // main.ts and logger.ts share the top folder: main -> agent -> logger is not a cycle.
        { from: "main.ts", to: "agent/run.ts", library: null },
        { from: "agent/run.ts", to: "logger.ts", library: null },
      ],
    });
    expect(g.cycles).toEqual([]);
    expect(g.in.get("tools/index.ts")?.has("tools/preview.ts")).toBe(true);
    const view = buildView(g, {
      projectId: "p",
      level: "module",
      focus: null,
      indexing: false,
      updatedAt: null,
    });
    expect(view.cycles).toEqual([]);
    expect(view.nodes.some((n) => n.inCycle)).toBe(false);
    expect(view.edges.some((e) => e.cycle)).toBe(false);
  });

  test("a big project stays readable: at most 40 modules and 24 in the diagram", () => {
    const files: MapFile[] = [];
    for (let i = 0; i < 120; i++) for (let j = 0; j < 3; j++) files.push(f(`pkg${i % 6}/mod${i}/f${j}.ts`));
    const imports = files
      .slice(1)
      .map((x, i) => ({ from: x.path, to: files[i]?.path ?? null, library: null }));
    const g = buildGraph({ files, imports });
    const view = buildView(g, {
      projectId: "p",
      level: "module",
      focus: null,
      indexing: false,
      updatedAt: null,
    });
    expect(view.nodes.length).toBeLessThanOrEqual(40);
    const mmd = mermaidFromView(view, "Big");
    expect(checkMermaid(mmd).issues).toEqual([]);
    expect((mmd.match(/\["/g) ?? []).length).toBeLessThanOrEqual(24 + 6);
  });

  test("declared entry points from package.json scripts, bin and pyproject", () => {
    const files: Record<string, string> = {
      "package.json":
        '{ "scripts": { "start": "node --enable-source-maps server/index.js" }, "bin": { "shop": "./cli.js" } }',
      "server/index.js": "",
      "cli.js": "",
      "pyproject.toml":
        '[project]\nname = "shop"\n\n[project.scripts]\nshop-admin = "shop.admin:main"\n\n[tool.x]\n',
      "shop/admin.py": "",
    };
    const r = resolverFor(files);
    expect(declaredEntries(Object.keys(files), r, (rel) => files[rel] ?? null)).toEqual([
      { path: "server/index.js", reason: "npm start" },
      { path: "cli.js", reason: "command line tool (package.json bin)" },
      { path: "shop/admin.py", reason: "script shop-admin" },
    ]);
  });
});

/** A small project: a TS app with an alias and a Python API, plus a cycle and an entry point. */
const FIXTURE: Record<string, string> = {
  "package.json": '{ "name": "shop", "scripts": { "dev": "vite" }, "dependencies": { "react": "19.0.0" } }',
  "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./web/src/*"] } } }',
  "web/index.html": '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  "web/src/main.tsx":
    'import { createRoot } from "react-dom/client";\nimport { App } from "@/App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
  "web/src/App.tsx":
    'import { Button } from "@/components/Button";\nimport { api } from "./lib/api";\nexport function App() { return <Button onClick={() => api()} />; }\n',
  "web/src/components/Button.tsx":
    'import { cn } from "../lib/cn";\nexport function Button(p: { onClick(): void }) { return <button className={cn()} onClick={p.onClick} />; }\n',
  "web/src/lib/cn.ts": "export function cn(...a: string[]) { return a.filter(Boolean).join(' '); }\n",
  "web/src/lib/api.ts":
    'import { cn } from "./cn";\nexport async function api() { return fetch("/api/items" + cn()); }\n',
  "api/app/__init__.py": "",
  "api/app/main.py":
    "from fastapi import FastAPI\nfrom .routes import router\n\napp = FastAPI()\napp.include_router(router)\n",
  "api/app/routes.py": "from fastapi import APIRouter\nfrom . import models\n\nrouter = APIRouter()\n",
  "api/app/models.py": "from .routes import router\n\nclass Item:\n    pass\n",
  "api/tests/test_main.py": "from app.main import app\n\ndef test_ok():\n    assert app\n",
  "README.md": "# Shop\n",
};

async function setupProject() {
  const t = tempDir("depo codemap");
  cleanup = t.cleanup;
  const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  engine = e;
  const root = path.join(t.dir, "my shop");
  write(root, FIXTURE);
  const project = await e.projects.open(root);
  e.indexer.ensure(project.id);
  await e.indexer.idle(project.id);
  return { e, root, project, dir: t.dir };
}

describe("code map service", () => {
  test("indexes imports, finds the cycle and the entry points, and answers file questions", async () => {
    const { e, project } = await setupProject();
    const map = await e.indexer.map.get(project.id, "module");
    expect(ApiSchema["codemap.get"].result.safeParse(map).success).toBe(true);
    expect(map.summary.files).toBe(11); // README and package.json are not code
    expect(map.summary.libraries.map((l) => l.name)).toEqual(
      expect.arrayContaining(["fastapi", "react-dom"]),
    );
    const paths = map.entryPoints.map((x) => x.path);
    expect(paths).toContain("api/app/main.py");
    expect(paths).toContain("web/src/main.tsx");
    expect(paths).not.toContain("api/tests/test_main.py");

    const file = await e.indexer.map.file(project.id, "web/src/lib/cn.ts");
    expect(file.importedBy.map((i) => i.path).sort()).toEqual([
      "web/src/components/Button.tsx",
      "web/src/lib/api.ts",
    ]);
    const app = await e.indexer.map.file(project.id, "web\\src\\App.tsx");
    expect(app.imports.map((i) => i.target)).toEqual(["web/src/components/Button.tsx", "web/src/lib/api.ts"]);
    expect(app.symbols.map((s) => s.name)).toContain("App");
    const routes = await e.indexer.map.file(project.id, "api/app/routes.py");
    expect(routes.inCycle).toBe(true);
    expect(routes.imports.find((i) => i.spec === "fastapi.APIRouter")?.library).toBe("fastapi");
    const test = await e.indexer.map.file(project.id, "api/tests/test_main.py");
    expect(test.imports[0]?.target).toBe("api/app/main.py");
    expect(await e.indexer.map.file(project.id, "web/index.html").then((x) => x.imports[0]?.target)).toBe(
      "web/src/main.tsx",
    );
    await expect(e.indexer.map.file(project.id, "nope.ts")).rejects.toThrow("not in the code index");

    const zoom = await e.indexer.map.get(project.id, "file", "web/src");
    expect(zoom.nodes.filter((n) => !n.outside).map((n) => n.id)).toEqual(
      expect.arrayContaining(["web/src/App.tsx", "web/src/lib/cn.ts"]),
    );
  }, 20_000);

  test("the watcher keeps edges current, and new targets resolve old imports", async () => {
    const { e, root, project } = await setupProject();
    // An import of a file that does not exist yet...
    fs.writeFileSync(
      path.join(root, "web", "src", "lib", "api.ts"),
      'import { cn } from "./cn";\nimport { log } from "./log";\nexport const api = () => cn(log());\n',
    );
    await waitUntil(
      async () => (await e.indexer.map.file(project.id, "web/src/lib/api.ts")).imports.length === 2,
    );
    expect((await e.indexer.map.file(project.id, "web/src/lib/api.ts")).imports[1]?.target).toBeNull();
    // ...resolves once the file appears.
    fs.writeFileSync(path.join(root, "web", "src", "lib", "log.ts"), "export const log = () => 'x';\n");
    await waitUntil(async () => {
      const f = await e.indexer.map.file(project.id, "web/src/lib/api.ts");
      return f.imports[1]?.target === "web/src/lib/log.ts";
    });
    fs.rmSync(path.join(root, "web", "src", "lib", "log.ts"));
    await waitUntil(async () => {
      const f = await e.indexer.map.file(project.id, "web/src/lib/api.ts");
      return f.imports[1]?.target === null;
    });
  }, 30_000);

  test("the code_map tool answers within its budget, for the project, a folder and a file", async () => {
    const { e, root, project } = await setupProject();
    const knowledge = {
      repoMap: () => "",
      findSymbols: () => [],
      search: async () => [],
      remember: () => {},
      codeMap: (a: { path?: string; folder?: string }) => e.indexer.map.text(project.id, a),
    };
    const ctx = {
      root,
      bus: e.bus,
      approvals: e.approvals,
      projectId: project.id,
      taskId: null,
      agent: "coder",
      knowledge,
    };
    const overview = await executeTool("code_map", {}, ctx);
    expect(overview.isError).toBe(false);
    expect(overview.content.length).toBeLessThanOrEqual(CODE_MAP_BUDGET);
    expect(overview.content).toContain("Entry points:");
    expect(overview.content).toContain("api/app");
    const one = await executeTool("code_map", { path: "cn.ts" }, ctx);
    expect(one.content).toContain("web/src/lib/cn.ts");
    expect(one.content).toContain("Imported by 2 files");
    expect(one.content.length).toBeLessThanOrEqual(CODE_MAP_BUDGET);
    const folder = await executeTool("code_map", { folder: "api" }, ctx);
    expect(folder.content).toContain("Code map of api");
    expect((await executeTool("code_map", { path: "missing.ts" }, ctx)).content).toContain("No indexed file");
    const without = await executeTool("code_map", {}, { ...ctx, knowledge: undefined });
    expect(without.isError).toBe(true);
    // Given to the agents that need to understand structure, and listed for the model.
    for (const id of ["thinking", "reasoning", "backend", "frontend", "integration", "enhancement"])
      expect(MANIFESTS.find((m) => m.id === id)?.tools).toContain("code_map");
    expect(MANIFESTS.find((m) => m.id === "security")?.tools).not.toContain("code_map");
    expect(toolDefinitions(["code_map"])[0]?.name).toBe("code_map");
  }, 20_000);

  test("the auto architecture diagram is listed in Diagrams, kept out of the project, and valid", async () => {
    const { e, root, project, dir } = await setupProject();
    const list = await e.design.listDiagrams(project.id);
    const auto = list.find((d) => d.source === "auto");
    expect(auto?.path).toBe(".depo/code-map.mmd");
    expect(checkMermaid(auto?.content ?? "").issues).toEqual([]);
    expect(auto?.content).toContain("flowchart LR");
    expect(fs.existsSync(path.join(root, ".depo"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "data", "projects", project.id, "code-map.mmd"))).toBe(true);
    // A new module shows up after the index notices it.
    write(root, { "worker/jobs.py": "from api.app import models\n" });
    await waitUntil(async () => {
      const again = (await e.design.listDiagrams(project.id)).find((d) => d.source === "auto");
      return again?.content.includes("worker") === true;
    });
  }, 30_000);
});

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 12_000) {
  const start = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function connect(port: number) {
  return new Promise<{ ws: WebSocket; call(method: string, params?: unknown): Promise<RpcResponse> }>(
    (resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
      let n = 1;
      const pending = new Map<number, (r: RpcResponse) => void>();
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
      };
      ws.onerror = () => reject(new Error("socket error"));
      ws.onopen = () =>
        resolve({
          ws,
          call: (method, params) =>
            new Promise((res) => {
              const id = n++;
              pending.set(id, res);
              ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            }),
        });
    },
  );
}

const hasGit = Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).success;

describe("code map RPC", () => {
  test("codemap.get, codemap.file and codemap.repo keep their contracts over the WebSocket", async () => {
    const { e, root, project } = await setupProject();
    if (hasGit) {
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: root });
      run("init", "-q", "-b", "main");
      run("add", ".");
      run("commit", "-q", "-m", "first");
      fs.appendFileSync(path.join(root, "web", "src", "lib", "cn.ts"), "// more\n");
      run("commit", "-q", "-am", "second");
      fs.writeFileSync(path.join(root, "notes.txt"), "uncommitted\n");
    }
    const { port } = await e.start();
    const c = await connect(port);
    const ok = async (method: keyof typeof ApiSchema, params: unknown) => {
      const res = await c.call(method, params);
      if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
      const parsed = ApiSchema[method].result.safeParse(res.result);
      if (!parsed.success)
        throw new Error(`${method} broke its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
      return parsed.data as Record<string, unknown>;
    };
    try {
      const map = (await ok("codemap.get", { projectId: project.id, level: "module" })) as {
        nodes: { id: string }[];
        hotSpots: { churn: { path: string; value: number }[] };
      };
      expect(map.nodes.length).toBeGreaterThan(2);
      if (hasGit) expect(map.hotSpots.churn[0]).toMatchObject({ path: "web/src/lib/cn.ts", value: 2 });
      await ok("codemap.get", { projectId: project.id, level: "file", focus: "web/src/App.tsx" });
      const file = (await ok("codemap.file", { projectId: project.id, path: "web/src/lib/cn.ts" })) as {
        churn: number | null;
      };
      expect(file.churn).toBe(hasGit ? 2 : null);
      const repo = (await ok("codemap.repo", { projectId: project.id })) as {
        stack: { languages: string[] };
        git: { branch: string; changed: number; lastCommit: { subject: string } } | null;
      };
      expect(repo.stack.languages.length).toBeGreaterThan(0);
      if (hasGit)
        expect(repo.git).toMatchObject({ branch: "main", changed: 1, lastCommit: { subject: "second" } });
      const diagrams = (await ok("diagrams.list", { projectId: project.id })) as {
        diagrams: { source: string }[];
      };
      expect(diagrams.diagrams.some((d) => d.source === "auto")).toBe(true);
      // Bad input is refused by the schema; unknown projects and files give plain errors.
      const bad = await c.call("codemap.get", { projectId: project.id, level: "folder" });
      expect("error" in bad).toBe(true);
      const unknown = await c.call("codemap.file", { projectId: project.id, path: "nope.py" });
      expect("error" in unknown && unknown.error.message).toContain("not in the code index");
    } finally {
      c.ws.close();
    }
  }, 30_000);
});

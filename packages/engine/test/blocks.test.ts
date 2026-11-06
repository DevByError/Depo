import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BLOCKS, findBlock, searchBlocks } from "../src/blocks";
import { createEngine, type Engine } from "../src/engine";
import { executeTool, type ToolContext } from "../src/tools/index";
import "../src/tools/block-tools";
import { MODE_AGENTS } from "../src/agents/manifests";
import { builderFor, templateNodes } from "../src/agents/team";
import { TEST_TOKEN, tempDir } from "./helpers";

let cleanup: (() => void)[] = [];
let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  for (const c of cleanup) c();
  cleanup = [];
});

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}
const pythonOk = (() => {
  try {
    return Bun.spawnSync(["python", "-c", "import sys; assert sys.version_info >= (3, 10)"]).exitCode === 0;
  } catch {
    return false;
  }
})();

async function ctxIn(dir: string): Promise<ToolContext> {
  const t = tempDir("depo blocks engine");
  cleanup.push(t.cleanup);
  engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
  await engine.start();
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

describe("building blocks", () => {
  test("the library is well formed: unique ids, safe relative paths, notes, and valid syntax", () => {
    expect(BLOCKS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(BLOCKS.map((b) => b.id)).size).toBe(BLOCKS.length);
    for (const b of BLOCKS) {
      expect(b.notes.length).toBeGreaterThan(0);
      expect(b.files.length).toBeGreaterThan(0);
      for (const f of b.files) {
        expect(f.path.startsWith("/")).toBe(false);
        expect(f.path.includes("..")).toBe(false);
        expect(f.content.includes("\r")).toBe(false);
        // No real-looking secrets inside the library itself.
        expect(/AKIA[0-9A-Z]{16}|sk_live_|-----BEGIN/.test(f.content)).toBe(false);
        if (/\.(ts|tsx)$/.test(f.path)) {
          const loader = f.path.endsWith("x") ? "tsx" : "ts";
          expect(() => new Bun.Transpiler({ loader }).transformSync(f.content)).not.toThrow();
        }
      }
      if (b.test) expect(b.files.some((f) => /test/.test(f.path))).toBe(true);
    }
    expect(findBlock("auth-ts")?.stack).toBe("ts");
    expect(findBlock("nope")).toBeUndefined();
    expect(searchBlocks({ text: "login" }).map((b) => b.id)).toContain("auth-py");
    expect(searchBlocks({ stack: "py" }).every((b) => b.stack === "py")).toBe(true);
  });

  for (const b of BLOCKS.filter((x) => x.stack !== "py" && x.test)) {
    test(`${b.id}: added to an empty project, its own tests pass`, async () => {
      const t = tempDir("depo block");
      cleanup.push(t.cleanup);
      const ctx = await ctxIn(t.dir);
      const r = await executeTool("use_block", { id: b.id }, ctx);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("Run its tests with");
      const res = run(["bun", "test", ...b.test.replace(/^bun test /, "").split(" ")], t.dir);
      expect(res.out).toContain(" 0 fail");
      expect(res.code).toBe(0);
    }, 60_000);
  }

  for (const b of BLOCKS.filter((x) => x.stack === "py")) {
    test.skipIf(!pythonOk)(
      `${b.id}: added to an empty project, its own tests pass`,
      async () => {
        const t = tempDir("depo block py");
        cleanup.push(t.cleanup);
        const ctx = await ctxIn(t.dir);
        const r = await executeTool("use_block", { id: b.id }, ctx);
        expect(r.isError).toBe(false);
        const res = run(["python", "-I", ...b.test.replace(/^python /, "").split(" ")], t.dir);
        expect(res.out).toContain("OK");
        expect(res.code).toBe(0);
      },
      60_000,
    );
  }

  test("both Python blocks can share one project (the shared package file is not a conflict)", async () => {
    const t = tempDir("depo block both");
    cleanup.push(t.cleanup);
    const ctx = await ctxIn(t.dir);
    expect((await executeTool("use_block", { id: "auth-py" }, ctx)).isError).toBe(false);
    expect((await executeTool("use_block", { id: "rbac-py" }, ctx)).isError).toBe(false);
    expect(fs.existsSync(path.join(t.dir, "app/rbac.py"))).toBe(true);
  });

  test("it never overwrites a different file, can use a sub folder, and refuses folders outside the project", async () => {
    const t = tempDir("depo block safe");
    cleanup.push(t.cleanup);
    const ctx = await ctxIn(t.dir);
    fs.mkdirSync(path.join(t.dir, "src/auth"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "src/auth/index.ts"), "// my own code\n");
    const refused = await executeTool("use_block", { id: "auth-ts" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("src/auth/index.ts");
    expect(fs.readFileSync(path.join(t.dir, "src/auth/index.ts"), "utf8")).toBe("// my own code\n");
    expect(fs.existsSync(path.join(t.dir, "src/auth/password.ts"))).toBe(false);

    const ok = await executeTool("use_block", { id: "auth-ts", dir: "backend" }, ctx);
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("cd backend && bun test");
    expect(fs.existsSync(path.join(t.dir, "backend/src/auth/password.ts"))).toBe(true);

    expect((await executeTool("use_block", { id: "auth-ts", dir: "../outside" }, ctx)).isError).toBe(true);
    expect((await executeTool("use_block", { id: "no-such-block" }, ctx)).isError).toBe(true);
    const list = await executeTool("list_blocks", { search: "audit" }, ctx);
    expect(list.content).toContain("audit-log-ts");
    expect((await executeTool("list_blocks", { search: "zzzz" }, ctx)).content).toContain("No block matches");
  });

  test("the audit-log block detects tampering (run for real)", async () => {
    const t = tempDir("depo block audit");
    cleanup.push(t.cleanup);
    const ctx = await ctxIn(t.dir);
    await executeTool("use_block", { id: "audit-log-ts" }, ctx);
    const script = path.join(t.dir, "try.ts");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'import { appendAudit, verifyAudit } from "./src/audit";',
        'appendAudit("a.log", { actor: "x", action: "login" });',
        'appendAudit("a.log", { actor: "x", action: "delete" });',
        "const before = verifyAudit('a.log').ok;",
        'fs.writeFileSync("a.log", fs.readFileSync("a.log", "utf8").replace("login", "read"));',
        "console.log(JSON.stringify([before, verifyAudit('a.log').ok]));",
      ].join("\n"),
    );
    const r = run(["bun", "try.ts"], t.dir);
    expect(r.out.trim()).toBe("[true,false]");
  });
});

describe("refined work modes", () => {
  test("fix reproduces first, then fixes with the right builder, then verifies", () => {
    const n = templateNodes("fix", "the submit button on the page is cut off on phones");
    expect(n.map((x) => x.id)).toEqual(["reproduce", "fix", "verify"]);
    expect(n.map((x) => x.owner)).toEqual(["testing", "frontend", "testing"]);
    expect(n[1]?.deps).toEqual(["reproduce"]);
    expect(templateNodes("fix", "login returns 500 for new users")[1]?.owner).toBe("backend");
    expect(templateNodes("fix", "the orders query is slow, add an index")[1]?.owner).toBe("database");
    expect(builderFor("")).toBe("backend");
  });

  test("refactor records a baseline first and compares at the end; import adds a baseline, a scan and an overview", () => {
    const r = templateNodes("refactor", "split the user service");
    expect(r.map((x) => x.id)).toEqual(["baseline", "analysis", "change", "testing"]);
    expect(r[0]?.owner).toBe("testing");
    const i = templateNodes("import", "");
    expect(i.map((x) => x.id)).toEqual(["analysis", "diagrams", "baseline", "security", "docs"]);
    expect(i.find((x) => x.id === "docs")?.deps).toEqual(["diagrams", "baseline", "security"]);
    for (const mode of ["fix", "refactor", "import", "backend"] as const)
      for (const node of templateNodes(mode, "x")) expect(MODE_AGENTS[mode]).toContain(node.owner);
  });
});

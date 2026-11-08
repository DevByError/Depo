import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withCodeFrames } from "../src/agent/finish";
import { ApprovalCenter } from "../src/approvals";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { testRuns } from "../src/readiness/service";
import { executeTool, type ToolContext } from "../src/tools/index";
import { codeFrame, compileProblem } from "../src/tools/syntax";
import { tempDir } from "./helpers";

// The owner's third part-1 run: qwen2.5-coder:3b appended this to the blueprint's be/src/app.ts
// (which already declares createApp), the backend tests failed with "createApp has already been
// declared", and neither 3b nor 7b could take it out again in three rounds.
const APP = fs.readFileSync(
  path.join(import.meta.dir, "..", "src", "blueprints", "files", "next-bun-mysql", "be", "src", "app.ts.tpl"),
  "utf8",
);
const JUNK =
  "import { NextResponse, NextRequest } from 'next/server';\nimport { createApp } from './app';\nimport { store, config } from './db';\nimport { auth } from './auth';\n\nexport default createApp({ store, config, limiter: null });\n";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project() {
  const t = tempDir("depo compile guard");
  const root = path.join(t.dir, "copy");
  fs.mkdirSync(path.join(root, "be", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "fe", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "be", "src", "app.ts"), APP);
  fs.writeFileSync(
    path.join(root, "fe", "app", "layout.tsx"),
    "export default function L() { return null; }\n",
  );
  fs.writeFileSync(
    path.join(root, "fe", "app", "page.tsx"),
    "export default function P() { return null; }\n",
  );
  const logger = createLogger({ dir: path.join(t.dir, "logs"), level: "error", stderr: false });
  const db = openDatabase({
    file: path.join(t.dir, "db", "t.db"),
    backupsDir: path.join(t.dir, "bk"),
    logger,
  });
  cleanup = () => {
    db.close();
    t.cleanup();
  };
  const bus = new EventBus(db.db, logger);
  const ctx: ToolContext = {
    root,
    bus,
    approvals: new ApprovalCenter(bus),
    projectId: null,
    taskId: null,
    agent: "coder",
  };
  return { root, ctx };
}

describe("a change that breaks a file that compiled is not saved", () => {
  test("Bun's parser finds the owner's error, with its line", () => {
    expect(compileProblem("be/src/app.ts", APP)).toBeNull();
    const p = compileProblem("be/src/app.ts", `${APP}\n${JUNK}`);
    expect(p?.message).toBe('"createApp" has already been declared');
    expect(p?.lineText).toBe("import { createApp } from './app';");
    expect(p?.noteLine).toBe(APP.split("\n").findIndex((l) => l.includes("export function createApp")) + 1);
    expect(
      compileProblem("fe/app/page.tsx", "export default function P() { return <main>hi</main>; }"),
    ).toBeNull();
    expect(compileProblem("be/src/x.ts", "export function f() {\n  return 1;\n")?.message).toBe(
      "Unexpected end of file",
    );
    expect(compileProblem("notes.md", "{{{")).toBeNull();
  });

  test("the owner's append is refused with the error and the lines, and app.ts stays as it was", async () => {
    const { root, ctx } = project();
    const r = await executeTool("append_file", { path: "be/src/app.ts", content: JUNK }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("be/src/app.ts does not compile at line");
    expect(r.content).toContain('"createApp" has already been declared (it is already declared at line');
    expect(r.content).toMatch(/>\d+│ import \{ createApp \} from '\.\/app';/);
    expect(r.content).toContain("leave out what the file already has");
    expect(fs.readFileSync(path.join(root, "be", "src", "app.ts"), "utf8")).toBe(APP);
  });

  test("edits that break it are refused too; a new broken file is kept with a warning, then fixed", async () => {
    const { root, ctx } = project();
    const first = APP.split("\n").find((l) => l.includes("export function createApp")) ?? "";
    const edit = await executeTool(
      "edit_file",
      { path: "be/src/app.ts", edits: [{ search: first, replace: `${first}\n  {` }] },
      { ...ctx, readPaths: new Set(["be/src/app.ts"]) },
    );
    expect(edit.isError).toBe(true);
    expect(fs.readFileSync(path.join(root, "be", "src", "app.ts"), "utf8")).toBe(APP);
    const created = await executeTool(
      "write_file",
      { path: "be/src/skills.ts", content: "export function search(q: string) {\n  return [q];\n" },
      ctx,
    );
    expect(created.isError).toBe(false);
    expect(created.content).toContain("Warning from Depo: be/src/skills.ts does not compile at line");
    expect(created.content).toContain("Unexpected end of file");
    const fixed = await executeTool(
      "edit_file",
      { path: "be/src/skills.ts", edits: [{ search: "  return [q];", replace: "  return [q];\n}" }] },
      { ...ctx, readPaths: new Set(["be/src/skills.ts"]) },
    );
    expect(fixed.isError).toBe(false);
    expect(fixed.content).not.toContain("Warning");
  });
});

describe("files in places the project does not use", () => {
  test("a pages/ page in an app-router Next.js app is refused with the right path", async () => {
    const { ctx } = project();
    const r = await executeTool(
      "write_file",
      { path: "fe/pages/skills/[id]/page.tsx", content: "export default function S() { return null; }\n" },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Write the page as fe/app/skills/[id]/page.tsx");
    const home = await executeTool(
      "write_file",
      { path: "fe/pages/index.tsx", content: "export default function H() { return null; }\n" },
      ctx,
    );
    expect(home.content).toContain("Write the page as fe/app/page.tsx");
  });

  test("code left as stubs is refused; a comment that only mentions an implementation is fine", async () => {
    const { ctx } = project();
    const stub = await executeTool(
      "write_file",
      {
        path: "be/src/api/skills.ts",
        content: "export async function getSkills() {\n  // Add implementation here\n}\n",
      },
      ctx,
    );
    expect(stub.isError).toBe(true);
    expect(stub.content).toContain('has code left for later ("// Add implementation here")');
    const ok = await executeTool(
      "write_file",
      {
        path: "be/src/api/rank.ts",
        content: "// The implementation here uses word counts.\nexport const rank = (n: number) => n * 2;\n",
      },
      ctx,
    );
    expect(ok.isError).toBe(false);
  });
});

describe("Depo's problem report shows the lines an error points at", () => {
  test("the owner's Windows test output becomes app.ts lines 55 to 61, marked at 58", () => {
    const { root } = project();
    fs.writeFileSync(path.join(root, "be", "src", "app.ts"), `${APP}\n${JUNK}`);
    const line = `${APP}\n${JUNK}`.split("\n").indexOf("import { createApp } from './app';") + 1;
    const winRoot = "C:\\Users\\baran\\AppData\\Local\\Depo\\workspaces\\tsk_1\\tree";
    const problem = `The tests in be fail (\`bun run test\`):\nerror: "createApp" has already been declared\n    at ${winRoot}\\be\\src\\app.ts:${line}:10`;
    // The copy's own path, as the test output prints it on the owner's PC.
    const framed = withCodeFrames(problem.replaceAll(winRoot, root.replace(/\//g, "\\")), root);
    expect(framed).toContain(`be/src/app.ts around line ${line}:`);
    expect(framed).toContain(`>${line}│ import { createApp } from './app';`);
    // Paths relative to a part are found too; other files are left alone.
    expect(withCodeFrames(`src/app.ts:${line}:10`, root)).toContain(`be/src/app.ts around line ${line}:`);
    expect(withCodeFrames("C:\\elsewhere\\x.ts:3:1", root)).toBe("C:\\elsewhere\\x.ts:3:1");
    expect(codeFrame("a\nb\nc", 2, 1)).toBe(" 1│ a\n>2│ b\n 3│ c");
  });
});

describe("the readiness card runs tests where they are", () => {
  test("in each part with a test script when the top has none", () => {
    const t = tempDir("depo test runs");
    cleanup = t.cleanup;
    const root = t.dir;
    fs.mkdirSync(path.join(root, "be"));
    fs.mkdirSync(path.join(root, "fe"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(
      path.join(root, "be", "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );
    fs.writeFileSync(path.join(root, "be", "bun.lock"), "");
    fs.writeFileSync(
      path.join(root, "fe", "package.json"),
      JSON.stringify({ scripts: { test: "bun test lib" } }),
    );
    fs.writeFileSync(path.join(root, "fe", "bun.lock"), "");
    expect(testRuns(root, "bun run test")).toEqual([
      { cwd: "be", command: "bun run test" },
      { cwd: "fe", command: "bun run test" },
    ]);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    expect(testRuns(root, "bun run test")).toEqual([{ cwd: ".", command: "bun run test" }]);
  });
});

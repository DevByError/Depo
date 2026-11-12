import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createEngine, type Engine } from "../src/engine";
import { buildShowcase } from "../src/showcase";
import { describeError } from "../src/util/errors";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

describe("agent version 1.1 and the showcase", () => {
  test("installing is repeatable, leaves 1.0 running and shows in the showcase", async () => {
    const t = tempDir("depo upgrades");
    cleanup = t.cleanup;
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    const first = e.lab.installUpgrades();
    // 15 agents get 1.1; the five focus roles also get 1.2 and 1.3.
    expect(first.created).toHaveLength(15 + 5 * 2);
    expect(e.lab.installUpgrades().created).toHaveLength(0);
    for (const id of ["manager", "backend", "frontend", "testing", "ui-ux-design"] as const)
      expect(e.lab.versions(id).map((v) => v.version)).toEqual(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);
    expect(e.lab.versions("security").map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
    const backend = e.lab.versions("backend");
    expect(backend.find((v) => v.active)?.version).toBe("1.0.0");
    expect(backend[1]?.manifest.prompt).toContain("Version 1.1 working rules");
    // Each version holds the rules of the ones before it.
    expect(backend[3]?.manifest.prompt).toContain("Version 1.1 working rules");
    expect(backend[3]?.manifest.prompt).toContain("Version 1.2 project memory");
    expect(backend[3]?.manifest.prompt).toContain("Version 1.3 backend checklist");
    expect(backend[2]?.manifest.prompt).not.toContain("Version 1.3");
    expect(e.lab.versions("manager")[3]?.manifest.prompt).toContain("manager checklist");
    const s = buildShowcase(e.lab, { playbooks: 3 });
    expect(s.totals.agents).toBe(15);
    expect(s.agents.find((a) => a.id === "backend")?.versions).toHaveLength(4);
    expect(s.features.length).toBeGreaterThan(8);
  });
});

describe("allow everything for a task", () => {
  test("commands and tool permissions pass, applying changes still waits", async () => {
    const t = tempDir("depo allow all");
    cleanup = t.cleanup;
    const e = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    engine = e;
    await e.start();
    const approvals = e.approvals;
    approvals.allowTask("tsk_a");
    const base = { projectId: "p", agent: "coder", reason: "r" } as const;
    expect(await approvals.request({ ...base, taskId: "tsk_a", kind: "command", title: "Run x?" })).toBe(
      true,
    );
    expect(await approvals.request({ ...base, taskId: "tsk_a", kind: "other", title: "Use tool?" })).toBe(
      true,
    );
    void approvals.request({ ...base, taskId: "tsk_a", kind: "apply", title: "Apply?" });
    expect(approvals.list()).toHaveLength(1);
    const other = approvals.request({ ...base, taskId: "tsk_b", kind: "command", title: "Run y?" });
    expect(approvals.list()).toHaveLength(2);
    for (const a of approvals.list()) approvals.respond(a.id, false);
    expect(await other).toBe(false);
  });
});

describe("exact errors", () => {
  test("the cause chain and code are kept", () => {
    const inner = Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:11434"), { code: "ETIMEDOUT" });
    const outer = new Error("Could not reach Ollama", { cause: inner });
    const d = describeError(outer);
    expect(d.message).toBe("Could not reach Ollama");
    expect(d.detail).toContain("Caused by: Error (ETIMEDOUT): connect ETIMEDOUT");
    expect(describeError("plain").message).toBe("plain");
  });
});

describe("a follow-up updates, it does not start again", () => {
  test("only the agents the change touches run again", async () => {
    const { templateNodes, updateNodes } = await import("../src/agents/team");
    const all = templateNodes("full", "build a shop");
    const ui = updateNodes(all, "make the buttons bigger and the page layout responsive");
    const uiOwners = new Set(ui?.map((n) => n.owner));
    expect(uiOwners.has("frontend")).toBe(true);
    expect(uiOwners.has("ui-ux-design")).toBe(true);
    expect(uiOwners.has("testing")).toBe(true);
    // The brief, options, critique and deck are not planned again.
    expect(uiOwners.has("project-management")).toBe(false);
    expect(uiOwners.has("thinking")).toBe(false);
    expect((ui?.length ?? 99) < all.length).toBe(true);
    // Every dependency left points at a node that is still in the plan.
    const ids = new Set(ui?.map((n) => n.id));
    for (const n of ui ?? []) for (const d of n.deps ?? []) expect(ids.has(d)).toBe(true);

    const api = updateNodes(all, "add a password reset endpoint to the api");
    const apiOwners = new Set(api?.map((n) => n.owner));
    expect(apiOwners.has("backend")).toBe(true);
    expect(apiOwners.has("security")).toBe(true);
    expect(apiOwners.has("frontend")).toBe(false);
  });
});

describe("lessons from the first real run", () => {
  test("the prompt's example paths come from the project, never an invented be/ folder", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { smallModelSteps, exampleFiles } = await import("../src/agent/prompt");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo example "));
    try {
      fs.mkdirSync(path.join(root, "lib"), { recursive: true });
      fs.writeFileSync(path.join(root, "lib/math.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(root, "lib/test_math.py"), "def test_add():\n    pass\n");
      expect(exampleFiles(root)).toEqual({ code: "lib/math.py", fresh: "lib/hello.py", lang: "python" });
      const text = smallModelSteps(root).join("\n");
      expect(text).toContain("lib/hello.py");
      expect(text).toContain("lib/math.py");
      expect(text).not.toContain("be/src");
      expect(text).toContain("Never invent a folder");
      // An empty folder falls back to a plain src/ path.
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "depo example2 "));
      try {
        expect(exampleFiles(empty).code).toBe("src/app.ts");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a named file written under another path is pushed back", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { misplacedFiles, stillToDo } = await import("../src/agent/request-check");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depo misplaced "));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/math.ts"), "export const add = 1;\n");
      const ask = "Add multiply to src/math.ts and a test in src/math.test.ts";
      expect(misplacedFiles(ask, root, ["be/src/math.ts", "be/src/math.test.ts"])[0]).toContain(
        "the request names it and it exists, but you wrote be/src/math.ts instead",
      );
      expect(stillToDo(ask, root, ["be/src/math.ts"])[0]).toContain("src/math.ts");
      // Changing the named file is fine, and so is a change with no named file.
      expect(misplacedFiles(ask, root, ["src/math.ts"])).toEqual([]);
      expect(misplacedFiles("add a helper", root, ["be/src/math.ts"])).toEqual([]);
      expect(misplacedFiles(ask, root, [])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("DEPO.md does not keep pasted code as the answer", async () => {
    const { updatedDepoMd } = await import("../src/projectdoc/depomd");
    const out = updatedDepoMd(
      "",
      {
        at: "2026-11-13T10:00:00.000Z",
        title: "Add divide",
        request: "add divide",
        answer: '```ts import { expect } from "@playwright/test"; test("x", () => {});```',
        outcome: "review",
        done: ["Add divide"],
        blocked: [],
        pending: [],
      },
      () => "# DEPO.md: x\n",
    );
    expect(out).toContain("Did: Add divide.");
    expect(out).not.toContain("playwright");
  });
});

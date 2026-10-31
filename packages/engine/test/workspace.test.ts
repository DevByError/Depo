import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { DepoEvent } from "@depo/shared";
import { openDatabase } from "../src/db";
import { EventBus } from "../src/events/bus";
import { createLogger } from "../src/logger";
import { editFileTool, writeFileTool } from "../src/tools/fs-tools";
import { ProjectService } from "../src/workspace/service";
import { tempDir } from "./helpers";

let base = "";
let proj = "";
let svc: ProjectService;
let events: DepoEvent[] = [];
let cleanup = () => {};
let closeDb = () => {};

const read = (rel: string) => fs.readFileSync(path.join(proj, rel), "utf8");

beforeEach(() => {
  const t = tempDir("depo ws");
  cleanup = t.cleanup;
  base = t.dir;
  proj = path.join(base, "my api");
  fs.mkdirSync(path.join(proj, "app"), { recursive: true });
  fs.mkdirSync(path.join(proj, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(proj, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(proj, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(proj, "__pycache__", "x.pyc"), Buffer.from([0, 1, 2]));
  const main = [
    "from fastapi import FastAPI",
    "",
    "app = FastAPI()",
    "",
    "",
    "@app.get('/')",
    "def index():",
    "    return {'ok': True}",
    "",
    "",
    "def helper():",
    "    return 1",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(proj, "app", "main.py"), main);
  fs.writeFileSync(path.join(proj, "app", "old.py"), "x = 1\n");
  fs.writeFileSync(path.join(proj, "logo.png"), Buffer.from([137, 80, 78, 71, 0, 0, 1]));
  const logger = createLogger({ dir: path.join(base, "logs"), level: "error", stderr: false });
  const db = openDatabase({
    file: path.join(base, "data", "db", "t.db"),
    backupsDir: path.join(base, "data", "bk"),
    logger,
  });
  closeDb = () => db.close();
  const bus = new EventBus(db.db, logger);
  events = [];
  bus.subscribe((e) => events.push(e));
  svc = new ProjectService(db.db, bus, logger, {
    root: path.join(base, "data"),
    workspaces: path.join(base, "data", "workspaces"),
    checkpoints: path.join(base, "data", "checkpoints"),
  });
});

afterEach(() => {
  closeDb();
  cleanup();
});

describe("projects", () => {
  test("open validates the folder and is idempotent", async () => {
    const p = await svc.open(proj);
    expect(p.name).toBe("my api");
    expect(p.isGit).toBe(false);
    expect((await svc.open(`"${proj}"`)).id).toBe(p.id);
    expect(await svc.list()).toHaveLength(1);
    await expect(svc.open(path.join(base, "missing"))).rejects.toThrow("Folder not found");
    await expect(svc.open(path.join(proj, "app", "main.py"))).rejects.toThrow("is a file");
    await expect(svc.open(path.parse(proj).root)).rejects.toThrow("whole drive");
    await expect(svc.open(path.join(base, "data"))).rejects.toThrow("Depo's own data");
  });
});

describe("shadow workspace and change sets", () => {
  test("copies sources, links dependencies, skips caches", async () => {
    await svc.open(proj);
    const ws = svc.createWorkspace(proj, "tsk_1");
    expect(Object.keys(ws.manifest).sort()).toEqual(["app/main.py", "app/old.py", "logo.png"]);
    expect(fs.existsSync(path.join(ws.root, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(fs.lstatSync(path.join(ws.root, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(ws.root, "__pycache__"))).toBe(false);
    // Removing the workspace must not touch the real node_modules.
    svc.discardWorkspace(ws.dir);
    expect(fs.existsSync(path.join(proj, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  test("edits in the workspace never touch the project until applied; undo restores", async () => {
    const p = await svc.open(proj);
    const ws = svc.createWorkspace(proj, "tsk_2");
    editFileTool(ws.root, "app/main.py", [
      { search: "app = FastAPI()", replace: "app = FastAPI(title='Demo')" },
      { search: "def helper():\n    return 1", replace: "def helper():\n    return 2" },
    ]);
    writeFileTool(ws.root, "app/health.py", "def ok():\n    return True\n");
    fs.rmSync(path.join(ws.root, "app", "old.py"));
    fs.writeFileSync(path.join(ws.root, "logo.png"), Buffer.from([137, 80, 78, 71, 0, 0, 2]));
    expect(read("app/main.py")).not.toContain("Demo");

    const cs = svc.collectChanges(p.id, null, ws, "Add health");
    if (!cs) throw new Error("expected changes");
    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath)).toEqual(["app/health.py", "app/main.py", "app/old.py", "logo.png"]);
    expect(byPath["app/health.py"]).toMatchObject({ kind: "added", additions: 2, deletions: 0 });
    expect(byPath["app/old.py"]).toMatchObject({ kind: "deleted", deletions: 1 });
    expect(byPath["logo.png"]).toMatchObject({ kind: "modified", binary: true, hunks: [] });
    expect(byPath["app/main.py"]?.hunks).toHaveLength(2);

    // Apply only the second hunk of main.py, plus the new file.
    const r1 = svc.applyChangeSet(cs.id, ws, [
      { path: "app/main.py", hunks: [1] },
      { path: "app/health.py" },
    ]);
    expect(r1.applied).toEqual(["app/main.py", "app/health.py"]);
    expect(read("app/main.py")).toContain("return 2");
    expect(read("app/main.py")).not.toContain("Demo");
    expect(read("app/health.py")).toContain("def ok");
    expect(r1.changeSet.status).toBe("partially_applied");
    expect(events.some((e) => e.type === "checkpoint_created")).toBe(true);
    expect(events.some((e) => e.type === "applied_changes")).toBe(true);

    // The rest is offered as a new pending change set.
    const pending = svc.listChangeSets(p.id).find((c) => c.status === "pending");
    expect(pending?.files.map((f) => f.path)).toEqual(["app/main.py", "app/old.py", "logo.png"]);
    expect(pending?.files[0]?.hunks).toHaveLength(1);

    const r2 = svc.applyChangeSet(pending?.id ?? "", ws);
    expect(r2.applied.sort()).toEqual(["app/main.py", "app/old.py", "logo.png"]);
    expect(read("app/main.py")).toContain("Demo");
    expect(fs.existsSync(path.join(proj, "app", "old.py"))).toBe(false);
    expect(r2.changeSet.status).toBe("applied");

    // Undo the second apply, then the first.
    const [latest, first] = svc.listCheckpoints(p.id);
    const u2 = svc.restoreCheckpoint(latest?.id ?? "");
    expect(u2.conflicts).toEqual([]);
    expect(read("app/main.py")).not.toContain("Demo");
    expect(read("app/old.py")).toBe("x = 1\n");
    const u1 = svc.restoreCheckpoint(first?.id ?? "");
    expect(u1.restored.sort()).toEqual(["app/health.py", "app/main.py"]);
    expect(read("app/main.py")).toContain("return 1");
    expect(fs.existsSync(path.join(proj, "app", "health.py"))).toBe(false);
    expect(() => svc.restoreCheckpoint(first?.id ?? "")).toThrow("already restored");
    expect(svc.getChangeSet(cs.id).status).toBe("reverted");
  });

  test("conflicts: the user edited the project file meanwhile", async () => {
    const p = await svc.open(proj);
    const ws = svc.createWorkspace(proj, "tsk_3");
    editFileTool(ws.root, "app/old.py", [{ search: "x = 1", replace: "x = 2" }]);
    fs.writeFileSync(path.join(proj, "app", "old.py"), "x = 100\n");
    const cs = svc.collectChanges(p.id, null, ws, "Change x");
    expect(cs?.files[0]?.conflict).toBe(true);
    const r = svc.applyChangeSet(cs?.id ?? "", ws);
    expect(r.applied).toEqual([]);
    expect(r.conflicts).toEqual(["app/old.py"]);
    expect(read("app/old.py")).toBe("x = 100\n");
  });

  test("undo refuses to overwrite later edits unless forced", async () => {
    const p = await svc.open(proj);
    const ws = svc.createWorkspace(proj, "tsk_4");
    editFileTool(ws.root, "app/old.py", [{ search: "x = 1", replace: "x = 2" }]);
    const cs = svc.collectChanges(p.id, null, ws, "x2");
    const r = svc.applyChangeSet(cs?.id ?? "", ws);
    fs.writeFileSync(path.join(proj, "app", "old.py"), "x = 3\n");
    const undo = svc.restoreCheckpoint(r.checkpointId ?? "");
    expect(undo.conflicts).toEqual(["app/old.py"]);
    expect(read("app/old.py")).toBe("x = 3\n");
    svc.restoreCheckpoint(r.checkpointId ?? "", true);
    expect(read("app/old.py")).toBe("x = 1\n");
  });

  test("no changes → no change set; discard marks it discarded", async () => {
    const p = await svc.open(proj);
    const ws = svc.createWorkspace(proj, "tsk_5");
    expect(svc.collectChanges(p.id, null, ws, "nothing")).toBeNull();
    writeFileTool(ws.root, "NEW.md", "hi\n");
    const cs = svc.collectChanges(p.id, null, ws, "doc");
    expect(svc.discardChangeSet(cs?.id ?? "").status).toBe("discarded");
    expect(() => svc.applyChangeSet(cs?.id ?? "", ws)).toThrow("already discarded");
    expect(fs.existsSync(path.join(proj, "NEW.md"))).toBe(false);
  });
});

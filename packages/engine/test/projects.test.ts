import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { DepoEvent } from "@depo/shared";
import { type HandlerContext, handlers } from "../src/api/handlers";
import { createEngine, type Engine } from "../src/engine";
import { errorSignature } from "../src/memory/store";
import { isGitUrl, repoName } from "../src/projects/registry";
import { TEST_TOKEN, tempDir } from "./helpers";

let engine: Engine | null = null;
let cleanup = () => {};
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  cleanup();
  cleanup = () => {};
});

type GitFake = (args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;

async function setup(git?: GitFake) {
  const t = tempDir("depo projects");
  cleanup = t.cleanup;
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    ...(git ? { git } : {}),
  });
  engine = e;
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  const work = path.join(t.dir, "work");
  fs.mkdirSync(work);
  const ctx: HandlerContext = {
    bus: e.bus,
    settings: e.settings,
    models: e.models,
    approvals: e.approvals,
    projects: e.projects,
    tasks: e.tasks,
    registry: e.registry,
    memory: e.memory,
    scheduler: e.scheduler,
    indexer: e.indexer,
    previews: e.previews,
    info: { startedAt: new Date(), dataDir: e.dirs.root, dbPath: e.database.path, schemaVersion: 3 },
  };
  return { e, work, events, ctx };
}

/** Reads the central directory of a .zip: file names → uncompressed contents. */
function readZip(file: string): Map<string, string> {
  const buf = fs.readFileSync(file);
  const out = new Map<string, string>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("projects", () => {
  test("create makes a folder with a README, git and project memory", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({
      name: "Shop API",
      parentDir: work,
      description: "Orders and payments",
      stack: "Python, FastAPI",
    });
    expect(p.rootPath).toBe(path.join(work, "Shop API"));
    expect(p.origin).toBe("created");
    expect(p.stack).toBe("Python, FastAPI");
    expect(fs.readFileSync(path.join(p.rootPath, "README.md"), "utf8")).toContain("Orders and payments");
    expect(fs.existsSync(path.join(p.rootPath, ".git"))).toBe(true);
    expect(e.memory.getMarkdown(p.id)).toContain("Python, FastAPI");
    await expect(e.registry.create({ name: "Shop API", parentDir: work })).rejects.toThrow("not empty");
  });

  test("import a local folder detects the stack", async () => {
    const { e, work } = await setup();
    const dir = path.join(work, "api");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "api"\n');
    const p = await e.registry.importSource({ source: dir });
    expect(p.origin).toBe("imported");
    expect(p.stack).toBe("Python");
    await expect(e.registry.importSource({ source: path.join(work, "missing") })).rejects.toThrow();
  });

  test("import a git URL clones into the chosen folder", async () => {
    const calls: string[][] = [];
    const git: GitFake = async (args, cwd) => {
      calls.push(args);
      if (args[0] === "clone") {
        const dest = args[3] as string;
        fs.mkdirSync(path.join(dest, ".git"), { recursive: true });
        fs.writeFileSync(path.join(dest, "package.json"), '{"name":"widgets"}');
        expect(cwd).toBe(path.dirname(dest));
      }
      return { code: 0, output: "" };
    };
    const { e, work } = await setup(git);
    const p = await e.registry.importSource({
      source: "https://github.com/acme/widgets.git",
      parentDir: work,
    });
    expect(calls[0]?.slice(0, 3)).toEqual(["clone", "--", "https://github.com/acme/widgets.git"]);
    expect(p.rootPath).toBe(path.join(work, "widgets"));
    expect(p.name).toBe("widgets");
    // A clone into an existing folder is refused before git runs.
    await expect(
      e.registry.importSource({ source: "git@github.com:acme/widgets.git", parentDir: work }),
    ).rejects.toThrow("already exists");
  });

  test("a failed clone leaves nothing behind", async () => {
    const git: GitFake = async (args) => {
      if (args[0] === "clone") fs.mkdirSync(args[3] as string, { recursive: true });
      return { code: 128, output: "fatal: repository not found" };
    };
    const { e, work } = await setup(git);
    await expect(
      e.registry.importSource({ source: "https://example.com/x/nope.git", parentDir: work }),
    ).rejects.toThrow("repository not found");
    expect(fs.existsSync(path.join(work, "nope"))).toBe(false);
  });

  test("rename, archive and unarchive", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({ name: "one", parentDir: work, initGit: false });
    const renamed = await e.registry.update(p.id, { name: "Renamed", description: "new" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.description).toBe("new");
    await e.registry.update(p.id, { archived: true });
    expect((await e.projects.list()).map((x) => x.id)).not.toContain(p.id);
    expect((await e.projects.list(true)).find((x) => x.id === p.id)?.archivedAt).not.toBeNull();
    await e.registry.update(p.id, { archived: false });
    expect((await e.projects.list()).map((x) => x.id)).toContain(p.id);
  });

  test("duplicate copies files, memory and settings but not installed packages", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({ name: "orig", parentDir: work, initGit: false });
    fs.writeFileSync(path.join(p.rootPath, "main.py"), "print('hi')\n");
    fs.mkdirSync(path.join(p.rootPath, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(p.rootPath, "node_modules", "left-pad", "index.js"), "x");
    e.memory.add(p.id, "decision", "Use SQLite for storage");
    e.registry.setSettings(p.id, { maxSteps: 60, commandAllow: ["make lint"] });

    const copy = await e.registry.duplicate(p.id);
    expect(copy.rootPath).toBe(path.join(work, "orig copy"));
    expect(fs.readFileSync(path.join(copy.rootPath, "main.py"), "utf8")).toBe("print('hi')\n");
    expect(fs.existsSync(path.join(copy.rootPath, "node_modules"))).toBe(false);
    expect(e.memory.list(copy.id).map((f) => f.text)).toContain("Use SQLite for storage");
    expect(e.registry.getSettings(copy.id).maxSteps).toBe(60);
    expect(e.registry.getSettings(copy.id).commandAllow).toEqual(["make lint"]);
    const again = await e.registry.duplicate(p.id);
    expect(again.rootPath).toBe(path.join(work, "orig copy (2)"));
  });

  test("export writes a zip with the files and Depo data", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({ name: "zipme", parentDir: work, initGit: false });
    fs.mkdirSync(path.join(p.rootPath, "src"));
    fs.writeFileSync(path.join(p.rootPath, "src", "app.ts"), "export const ünï = 1;\n");
    fs.mkdirSync(path.join(p.rootPath, "node_modules"));
    fs.writeFileSync(path.join(p.rootPath, "node_modules", "big.js"), "x");
    e.memory.add(p.id, "fact", "API runs on port 8000");
    const out = path.join(work, "exports");
    fs.mkdirSync(out);
    const res = await e.registry.exportProject(p.id, out);
    expect(path.dirname(res.path)).toBe(out);
    const files = readZip(res.path);
    expect(files.get("zipme/src/app.ts")).toBe("export const ünï = 1;\n");
    expect([...files.keys()].some((k) => k.includes("node_modules"))).toBe(false);
    const meta = JSON.parse(files.get("zipme/.depo-export/project.json") ?? "{}");
    expect(meta.format).toBe("depo-project-export@1");
    expect(meta.memoryFacts[0].text).toBe("API runs on port 8000");
    expect(files.get("zipme/.depo-export/project-memory.md")).toContain("zipme");
  });

  test("delete removes the project from Depo and keeps the folder", async () => {
    const { e, work, ctx } = await setup();
    const p = await e.registry.create({ name: "keepme", parentDir: work, initGit: false });
    e.memory.add(p.id, "fact", "something");
    await handlers["projects.delete"]({ id: p.id }, ctx);
    expect(fs.existsSync(path.join(p.rootPath, "README.md"))).toBe(true);
    expect((await e.projects.list(true)).map((x) => x.id)).not.toContain(p.id);
    expect(e.memory.list(p.id)).toHaveLength(0);
    expect(fs.existsSync(e.memory.markdownPath(p.id))).toBe(false);
  });

  test("project settings have defaults, validate and persist", async () => {
    const { e, work, ctx } = await setup();
    const p = await e.registry.create({ name: "s", parentDir: work, initGit: false });
    expect(e.registry.getSettings(p.id)).toEqual({
      fullAccess: false,
      indexEnabled: true,
      maxParallel: 1,
      paused: false,
      commandAllow: [],
      commandDeny: [],
      maxSteps: 40,
      previewCommand: "",
    });
    const next = handlers["projects.settings.set"](
      { id: p.id, patch: { indexEnabled: false, maxParallel: 2 } },
      ctx,
    );
    expect(next.maxParallel).toBe(2);
    expect(e.registry.getSettings(p.id).indexEnabled).toBe(false);
    expect(() => e.registry.setSettings(p.id, { maxSteps: 1 })).toThrow();
  });

  test("overview combines tasks, index and memory", async () => {
    const { e, work, ctx } = await setup();
    const p = await e.registry.create({ name: "ov", parentDir: work, initGit: false });
    e.memory.add(p.id, "fact", "a");
    e.memory.recordLesson(p.id, "ModuleNotFoundError: No module named 'httpx'", "pip install httpx");
    const o = await handlers["projects.overview"]({ id: p.id }, ctx);
    expect(o.project.id).toBe(p.id);
    expect(o.memory.facts).toBe(1);
    expect(o.memory.lessons).toBe(1);
    expect(o.lastTestRun).toBeNull();
    expect(o.index.state).toBeDefined();
  });

  test("git URL helpers", () => {
    expect(isGitUrl("https://github.com/a/b.git")).toBe(true);
    expect(isGitUrl("git@github.com:a/b.git")).toBe(true);
    expect(isGitUrl("C:\\Users\\me\\code")).toBe(false);
    expect(isGitUrl("/home/me/code")).toBe(false);
    expect(repoName("https://github.com/a/my-repo.git")).toBe("my-repo");
    expect(repoName("git@github.com:a/b")).toBe("b");
  });
});

describe("memory", () => {
  test("project and global markdown, facts and prompt context", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({ name: "mem", parentDir: work, initGit: false });
    e.memory.setMarkdown(p.id, "# mem\nUses Postgres in production.");
    e.memory.setMarkdown(null, "Prefer short commit messages.");
    const fact = e.memory.add(p.id, "preference", "Use tabs");
    e.memory.update(fact.id, "Use 4 spaces");
    e.memory.add(null, "preference", "Answer in English");
    const ctxText = e.memory.contextFor(p.id);
    expect(ctxText).toContain("Uses Postgres in production.");
    expect(ctxText).toContain("Use 4 spaces");
    expect(ctxText).not.toContain("Use tabs");
    expect(ctxText).toContain("Prefer short commit messages.");
    expect(ctxText).toContain("Answer in English");
    expect(e.memory.contextFor(p.id, 50).length).toBeLessThan(120);
    e.memory.remove(fact.id);
    expect(e.memory.list(p.id)).toHaveLength(0);
  });

  test("lessons are deduplicated by error signature and found again", async () => {
    const { e, work } = await setup();
    const p = await e.registry.create({ name: "les", parentDir: work, initGit: false });
    const out1 =
      "Traceback...\n  File \"C:\\x\\app.py\", line 3\nModuleNotFoundError: No module named 'httpx'\n";
    const out2 = "  File \"/tmp/other/app.py\", line 99\nModuleNotFoundError: No module named 'httpx'\n";
    expect(errorSignature(out1)).toBe(errorSignature(out2));
    const a = e.memory.recordLesson(p.id, out1, "added httpx to requirements.txt");
    const b = e.memory.recordLesson(p.id, out2, "added httpx to requirements-dev.txt");
    expect(b?.id).toBe(a?.id);
    expect(b?.uses).toBe(1);
    expect(e.memory.findLessons(p.id, out2).map((f) => f.id)).toEqual([a?.id ?? ""]);
    expect(e.memory.findLessons(p.id, "all good")).toEqual([]);
  });
});

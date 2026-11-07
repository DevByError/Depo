import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Project, type ProjectSettings, ProjectSettingsSchema } from "@depo/shared";
import { and, desc, eq } from "drizzle-orm";
import { detectProject } from "../agent/prompt";
import type { AppDb } from "../db";
import { changeSets, events, projectSettings, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { MemoryStore } from "../memory/store";
import { DEFAULT_IGNORES } from "../tools/fs-tools";
import type { ProjectService } from "../workspace/service";
import { ZipWriter } from "./zip";

/** Folders never copied by duplicate or export: installed packages, caches, build output. */
const HEAVY_DIRS = new Set([...DEFAULT_IGNORES, "env", ".next", ".nuxt", ".turbo", ".gradle", "coverage"]);
HEAVY_DIRS.delete(".git");

const SETTING_KEYS = Object.keys(ProjectSettingsSchema.shape) as (keyof ProjectSettings)[];

export interface ProjectRegistryOptions {
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  projects: ProjectService;
  memory: MemoryStore;
  /** Runs git; injectable for tests. */
  git?: (args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;
}

/**
 * Project lifecycle: create, import (folder or git), rename, archive, duplicate, export,
 * delete, and per-project settings. Only create, import (clone) and duplicate write to disk
 * outside Depo's data folder, and each writes into a new folder that did not exist before.
 */
export class ProjectRegistry {
  private readonly log: Logger;
  constructor(private readonly o: ProjectRegistryOptions) {
    this.log = o.logger.child({ component: "projects" });
  }

  async create(p: {
    name: string;
    parentDir: string;
    description?: string;
    stack?: string;
    initGit?: boolean;
    /**
     * Fills the new folder instead of the README and `git init` (blueprints). When it fails, the
     * folder is removed again if Depo made it.
     */
    populate?: (dest: string) => Promise<void> | void;
  }): Promise<Project> {
    const parent = existingDir(p.parentDir, "Parent folder");
    const dest = path.join(parent, p.name.trim());
    const existed = fs.existsSync(dest);
    if (existed && fs.readdirSync(dest).length > 0) {
      throw new Error(`${dest} already exists and is not empty. Pick another name, or import it instead.`);
    }
    fs.mkdirSync(dest, { recursive: true });
    const description = p.description?.trim() ?? "";
    if (p.populate) {
      try {
        await p.populate(dest);
      } catch (err) {
        if (!existed) fs.rmSync(dest, { recursive: true, force: true });
        throw err;
      }
    } else {
      fs.writeFileSync(
        path.join(dest, "README.md"),
        `# ${p.name.trim()}\n${description ? `\n${description}\n` : ""}`,
        { flag: "wx" },
      );
      if (p.initGit !== false) {
        const r = await this.git(["init", "-q"], dest, 30_000);
        if (r.code !== 0) this.log.warn("git init failed", { output: r.output });
      }
    }
    const project = await this.o.projects.open(dest, {
      origin: "created",
      description,
      stack: p.stack ?? "",
    });
    this.o.memory.initProject(project.id, { name: project.name, description, stack: p.stack ?? "" });
    return project;
  }

  async importSource(p: { source: string; parentDir?: string }): Promise<Project> {
    const source = p.source.trim();
    let root: string;
    if (isGitUrl(source)) {
      if (!p.parentDir) throw new Error("Choose a folder to clone the repository into.");
      const parent = existingDir(p.parentDir, "Destination folder");
      const name = repoName(source);
      root = path.join(parent, name);
      if (fs.existsSync(root)) throw new Error(`${root} already exists. Choose another destination folder.`);
      this.o.bus.emit({
        agent: "engine",
        type: "project_changed",
        text: `Cloning ${source}`,
        details: { change: "cloning", jobId: `clone-${name}` },
        status: "running",
        ephemeral: true,
      });
      const r = await this.git(["clone", "--", source, root], parent, 15 * 60_000);
      this.o.bus.emit({
        agent: "engine",
        type: "project_changed",
        text: r.code === 0 ? `Cloned ${source}` : `Could not clone ${source}`,
        details: { change: "cloning", jobId: `clone-${name}`, clear: true },
        status: r.code === 0 ? "succeeded" : "failed",
        ephemeral: true,
      });
      if (r.code !== 0) {
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error(`git clone failed: ${lastLines(r.output, 3) || `exit code ${r.code}`}`);
      }
    } else {
      root = this.o.projects.validateFolder(source);
    }
    const detected = detectProject(root);
    const stack = detected.kind === "unknown" ? "" : detected.kind;
    const project = await this.o.projects.open(root, { origin: "imported", stack });
    this.o.memory.initProject(project.id, { name: project.name, description: "", stack });
    return project;
  }

  async update(
    id: string,
    patch: { name?: string; description?: string; stack?: string; archived?: boolean },
  ): Promise<Project> {
    const before = await this.o.projects.get(id);
    const now = new Date().toISOString();
    const set: Partial<typeof projects.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.description !== undefined) set.description = patch.description.trim();
    if (patch.stack !== undefined) set.stack = patch.stack.trim();
    if (patch.archived !== undefined) set.archivedAt = patch.archived ? now : null;
    if (patch.archived && this.activeTasks(id) > 0)
      throw new Error("Stop this project's running tasks first.");
    this.o.db.update(projects).set(set).where(eq(projects.id, id)).run();
    const what =
      patch.archived === true
        ? "Archived"
        : patch.archived === false
          ? "Restored"
          : patch.name && patch.name !== before.name
            ? "Renamed"
            : "Updated";
    this.o.bus.emit({
      projectId: id,
      agent: "user",
      type: "project_changed",
      text: `${what} project ${patch.name ?? before.name}`,
      details: { change: what.toLowerCase() },
      status: "succeeded",
    });
    return this.o.projects.get(id);
  }

  async duplicate(id: string, name?: string): Promise<Project> {
    const src = await this.o.projects.get(id);
    if (!src.exists) throw new Error(`The project folder is missing: ${src.rootPath}`);
    const parent = path.dirname(src.rootPath);
    const dest = uniquePath(parent, name?.trim() || `${path.basename(src.rootPath)} copy`);
    copyTree(src.rootPath, dest);
    const copy = await this.o.projects.open(dest, {
      origin: "duplicated",
      description: src.description,
      stack: src.stack,
    });
    if (name?.trim()) await this.update(copy.id, { name: name.trim() });
    this.o.memory.copyProject(id, copy.id);
    this.setSettings(copy.id, this.getSettings(id));
    return this.o.projects.get(copy.id);
  }

  /** A .zip with the project files (without installed packages and caches) and its Depo data. */
  async exportProject(id: string, destDir?: string): Promise<{ path: string; bytes: number; files: number }> {
    const p = await this.o.projects.get(id);
    if (!p.exists) throw new Error(`The project folder is missing: ${p.rootPath}`);
    const dir = destDir?.trim() ? existingDir(destDir, "Export folder") : defaultExportDir(p.rootPath);
    const stamp = new Date().toISOString().slice(0, 10);
    const file = uniquePath(dir, `${safeFileName(p.name)}-depo-${stamp}.zip`);
    const zip = new ZipWriter(file);
    const top = safeFileName(p.name);
    try {
      walkFiles(p.rootPath, (rel, abs) => {
        const st = fs.statSync(abs);
        if (st.size > 200 * 1024 * 1024) return;
        zip.add(`${top}/${rel}`, fs.readFileSync(abs), st.mtime);
      });
      const meta = {
        format: "depo-project-export@1",
        exportedAt: new Date().toISOString(),
        project: { ...p, rootPath: undefined },
        settings: this.getSettings(id),
        memoryFacts: this.o.memory.list(id),
        tasks: this.o.db
          .select()
          .from(tasks)
          .where(eq(tasks.projectId, id))
          .orderBy(desc(tasks.createdAt))
          .all()
          .map((t) => ({
            title: t.title,
            prompt: t.prompt,
            status: t.status,
            summary: t.summary,
            createdAt: t.createdAt,
          })),
        changeSets: this.o.db
          .select()
          .from(changeSets)
          .where(eq(changeSets.projectId, id))
          .all()
          .map((c) => ({
            title: c.title,
            status: c.status,
            files: JSON.parse(c.files),
            createdAt: c.createdAt,
          })),
      };
      zip.add(`${top}/.depo-export/project.json`, new TextEncoder().encode(JSON.stringify(meta, null, 2)));
      zip.add(
        `${top}/.depo-export/project-memory.md`,
        new TextEncoder().encode(this.o.memory.getMarkdown(id)),
      );
      const result = zip.close();
      this.o.bus.emit({
        projectId: id,
        agent: "user",
        type: "project_changed",
        text: `Exported ${p.name} to ${file}`,
        details: { change: "exported", path: file, files: result.files, bytes: result.bytes },
        status: "succeeded",
      });
      return { path: file, ...result };
    } catch (err) {
      zip.abort();
      fs.rmSync(file, { force: true });
      throw err;
    }
  }

  /** Remove from Depo. The project folder itself is never deleted. */
  delete(id: string): void {
    if (this.activeTasks(id) > 0) throw new Error("Stop this project's running tasks first.");
    this.o.projects.forget(id);
    this.o.memory.removeProject(id);
  }

  getSettings(id: string): ProjectSettings {
    const rows = this.o.db.select().from(projectSettings).where(eq(projectSettings.projectId, id)).all();
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value);
      } catch {
        // ignore a corrupt value; the default applies
      }
    }
    const parsed = ProjectSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : ProjectSettingsSchema.parse({});
  }

  setSettings(id: string, patch: Partial<ProjectSettings>): ProjectSettings {
    const next = ProjectSettingsSchema.parse({ ...this.getSettings(id), ...patch });
    const now = new Date().toISOString();
    for (const key of SETTING_KEYS) {
      if (!(key in patch)) continue;
      const value = JSON.stringify(next[key]);
      this.o.db
        .insert(projectSettings)
        .values({ projectId: id, key, value, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [projectSettings.projectId, projectSettings.key],
          set: { value, updatedAt: now },
        })
        .run();
    }
    this.o.bus.emit({
      projectId: id,
      agent: "user",
      type: "settings_changed",
      text: `Project settings changed: ${Object.keys(patch).join(", ")}`,
      details: { scope: "project", keys: Object.keys(patch) },
    });
    return next;
  }

  taskCounts(id: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const t of this.o.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.projectId, id))
      .all())
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  }

  lastTestRun(id: string): { at: string; passed: boolean; text: string; taskId: string | null } | null {
    const row = this.o.db
      .select()
      .from(events)
      .where(and(eq(events.projectId, id), eq(events.type, "test_result")))
      .orderBy(desc(events.ts))
      .limit(1)
      .get();
    if (!row) return null;
    return { at: row.ts, passed: row.status === "succeeded", text: row.text, taskId: row.taskId };
  }

  recentChanges(id: string): { id: string; title: string; status: string; files: number; at: string }[] {
    return this.o.db
      .select()
      .from(changeSets)
      .where(eq(changeSets.projectId, id))
      .orderBy(desc(changeSets.updatedAt))
      .limit(5)
      .all()
      .map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        files: (JSON.parse(c.files) as unknown[]).length,
        at: c.updatedAt,
      }));
  }

  private activeTasks(id: string): number {
    const c = this.taskCounts(id);
    return (c.queued ?? 0) + (c.running ?? 0) + (c.waiting ?? 0);
  }

  private git(args: string[], cwd: string, timeoutMs: number) {
    return (this.o.git ?? runGit)(args, cwd, timeoutMs);
  }
}

async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      windowsHide: true,
    });
  } catch {
    return { code: 127, output: "git is not installed or not on PATH." };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, output: `${out}${err}` };
}

export function isGitUrl(s: string): boolean {
  return /^(https?|ssh|git):\/\/\S+$/i.test(s) || /^[\w.-]+@[\w.-]+:\S+$/.test(s);
}

export function repoName(url: string): string {
  const last =
    url
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .pop() ?? "repo";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows file names
  const name = last.replace(/\.git$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return name || "repo";
}

function existingDir(raw: string, label: string): string {
  const dir = path.resolve(raw.trim().replace(/^"(.*)"$/, "$1"));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${label} not found: ${dir}`);
  return dir;
}

function defaultExportDir(projectRoot: string): string {
  const downloads = path.join(os.homedir(), "Downloads");
  return fs.existsSync(downloads) ? downloads : path.dirname(projectRoot);
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function safeFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows file names
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "project";
}

function lastLines(text: string, n: number): string {
  return text.trim().split(/\r?\n/).slice(-n).join(" ").slice(0, 400);
}

function walkFiles(root: string, onFile: (rel: string, abs: string) => void): void {
  const walk = (dir: string, rel: string) => {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      if (it.isSymbolicLink()) continue;
      const abs = path.join(dir, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (!HEAVY_DIRS.has(it.name)) walk(abs, r);
      } else if (it.isFile()) onFile(r, abs);
    }
  };
  walk(root, "");
}

/** Copy a project folder, keeping .git but skipping installed packages, caches and build output. */
function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  walkFiles(src, (rel, abs) => {
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(abs, out);
  });
}

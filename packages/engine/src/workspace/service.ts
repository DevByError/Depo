import fs from "node:fs";
import path from "node:path";
import {
  type ChangeSet,
  ChangeSetSchema,
  type Checkpoint,
  CheckpointSchema,
  type FileChange,
  newId,
  type Project,
} from "@depo/shared";
import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { changeSets, checkpoints, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import { isBinary } from "../tools/fs-tools";
import { gitStatus, isGitRepo } from "../tools/git";
import { isWithin, resolveInside } from "../tools/paths";
import { applyHunks, computeChanges } from "./changes";
import { createShadow, hashBytes, hashFile, type Manifest, removeShadow } from "./snapshot";

export interface Workspace {
  /** Folder that holds `tree/` (the shadow copy) and `manifest.json`. */
  dir: string;
  root: string;
  manifest: Manifest;
}

/**
 * Projects, shadow workspaces, change sets and checkpoints. The real project folder is only
 * written by `applyChangeSet` and `restoreCheckpoint`, and both keep an undo trail.
 */
export class ProjectService {
  constructor(
    private readonly db: AppDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly dirs: { root: string; workspaces: string; checkpoints: string },
  ) {}

  // ---- projects --------------------------------------------------------------------------

  /** Check a folder can be a project; returns its absolute path. */
  validateFolder(rawPath: string): string {
    const root = path.resolve(rawPath.trim().replace(/^"(.*)"$/, "$1"));
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new Error(`Folder not found: ${root}`);
    }
    if (!st.isDirectory()) throw new Error(`${root} is a file. Choose a folder.`);
    if (path.parse(root).root === root) throw new Error("Choose a project folder, not a whole drive.");
    if (isWithin(this.dirs.root, root) || isWithin(root, this.dirs.root)) {
      throw new Error("That folder contains Depo's own data. Choose a project folder.");
    }
    return root;
  }

  async open(
    rawPath: string,
    meta: {
      origin?: "opened" | "created" | "imported" | "duplicated";
      description?: string;
      stack?: string;
    } = {},
  ): Promise<Project> {
    const root = this.validateFolder(rawPath);
    const now = new Date().toISOString();
    const existing = this.db.select().from(projects).where(eq(projects.rootPath, root)).get();
    let id: string;
    if (existing) {
      id = existing.id;
      // Opening an archived project brings it back.
      this.db
        .update(projects)
        .set({ lastOpenedAt: now, updatedAt: now, archivedAt: null })
        .where(eq(projects.id, id))
        .run();
    } else {
      id = newId("prj");
      this.db
        .insert(projects)
        .values({
          id,
          name: path.basename(root),
          rootPath: root,
          lastOpenedAt: now,
          description: meta.description ?? "",
          stack: meta.stack ?? "",
          origin: meta.origin ?? "opened",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const verb = { opened: "Opened", created: "Created", imported: "Imported", duplicated: "Duplicated" }[
        meta.origin ?? "opened"
      ];
      this.bus.emit({
        projectId: id,
        agent: "engine",
        type: "project_changed",
        text: `${verb} project ${path.basename(root)}`,
        details: { path: root, change: meta.origin ?? "opened" },
        status: "succeeded",
      });
    }
    return this.get(id);
  }

  async get(id: string): Promise<Project> {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new Error(`Unknown project: ${id}`);
    const exists = fs.existsSync(row.rootPath);
    const git = exists && (await isGitRepo(row.rootPath));
    let branch: string | null = null;
    if (git)
      branch = await gitStatus(row.rootPath)
        .then((s) => s.branch)
        .catch(() => null);
    return {
      id: row.id,
      name: row.name,
      rootPath: row.rootPath,
      lastOpenedAt: row.lastOpenedAt,
      createdAt: row.createdAt,
      isGit: git,
      branch,
      description: row.description,
      stack: row.stack,
      origin:
        (["opened", "created", "imported", "duplicated"] as const).find((o) => o === row.origin) ?? "opened",
      archivedAt: row.archivedAt,
      exists,
    };
  }

  async list(includeArchived = false): Promise<Project[]> {
    const rows = this.db.select().from(projects).orderBy(desc(projects.lastOpenedAt)).all();
    return Promise.all(rows.filter((r) => includeArchived || !r.archivedAt).map((r) => this.get(r.id)));
  }

  /** Remove the project from Depo with its tasks, change sets, checkpoints and workspaces. The folder stays. */
  forget(id: string): void {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return;
    const taskRows = this.db.select().from(tasks).where(eq(tasks.projectId, id)).all();
    const cps = this.db.select().from(checkpoints).where(eq(checkpoints.projectId, id)).all();
    this.db.delete(projects).where(eq(projects.id, id)).run();
    for (const t of taskRows) {
      if (t.workspacePath) this.removeWorkspaceDir(t.workspacePath);
    }
    for (const c of cps) fs.rmSync(path.join(this.dirs.checkpoints, c.id), { recursive: true, force: true });
    this.bus.emit({
      projectId: id,
      agent: "engine",
      type: "project_changed",
      text: `Removed project ${row.name} from Depo (its folder was not touched)`,
      details: { change: "deleted", path: row.rootPath },
      status: "succeeded",
    });
  }

  // ---- read-only browsing (Files tab) ------------------------------------------------------

  private rootOf(projectId: string): string {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row) throw new Error(`Unknown project: ${projectId}`);
    return row.rootPath;
  }

  listFiles(
    projectId: string,
    rel: string,
  ): { name: string; path: string; type: "file" | "dir"; size: number | null }[] {
    const root = this.rootOf(projectId);
    const { abs, rel: clean } = resolveInside(root, rel);
    const items = fs.readdirSync(abs, { withFileTypes: true });
    return items
      .filter((d) => (d.isDirectory() || d.isFile()) && !(d.isDirectory() && d.name === ".git"))
      .map((d) => {
        const p = clean === "." ? d.name : `${clean}/${d.name}`;
        const type = d.isDirectory() ? ("dir" as const) : ("file" as const);
        let size: number | null = null;
        if (type === "file") {
          try {
            size = fs.statSync(path.join(abs, d.name)).size;
          } catch {
            size = null;
          }
        }
        return { name: d.name, path: p, type, size };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  readFile(
    projectId: string,
    rel: string,
  ): { path: string; text: string | null; binary: boolean; size: number; truncated: boolean } {
    const root = this.rootOf(projectId);
    const { abs, rel: clean } = resolveInside(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`${clean} is a folder`);
    const max = 512 * 1024;
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(Math.min(st.size, max));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const binary = isBinary(buf);
    return {
      path: clean,
      text: binary ? null : buf.toString("utf8"),
      binary,
      size: st.size,
      truncated: st.size > max,
    };
  }

  // ---- workspaces ------------------------------------------------------------------------

  private readonly removalHooks: ((dir: string) => void)[] = [];

  /** Called just before a shadow workspace folder is deleted (previews running from it stop). */
  beforeWorkspaceRemoved(hook: (dir: string) => void): void {
    this.removalHooks.push(hook);
  }

  private removeWorkspaceDir(dir: string): void {
    for (const h of this.removalHooks) {
      try {
        h(dir);
      } catch (err) {
        this.logger.warn("workspace removal hook failed", { error: String(err) });
      }
    }
    removeShadow(dir);
  }

  /** Copy the project into a fresh shadow workspace for one task. */
  createWorkspace(projectRoot: string, key: string): Workspace {
    const dir = path.join(this.dirs.workspaces, key);
    if (fs.existsSync(dir)) this.removeWorkspaceDir(dir);
    const root = path.join(dir, "tree");
    const t0 = performance.now();
    const { manifest, linked, bytes } = createShadow(projectRoot, root);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    this.logger.info("shadow workspace created", {
      key,
      files: Object.keys(manifest).length,
      bytes,
      linked,
      ms: Math.round(performance.now() - t0),
    });
    return { dir, root, manifest };
  }

  loadWorkspace(dir: string): Workspace {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
    return { dir, root: path.join(dir, "tree"), manifest };
  }

  private saveManifest(ws: Workspace) {
    fs.writeFileSync(path.join(ws.dir, "manifest.json"), JSON.stringify(ws.manifest));
  }

  discardWorkspace(dir: string): void {
    if (fs.existsSync(dir)) this.removeWorkspaceDir(dir);
  }

  // ---- change sets -----------------------------------------------------------------------

  /** Diff the workspace against the project and store it as the task's pending change set. */
  collectChanges(projectId: string, taskId: string | null, ws: Workspace, title: string): ChangeSet | null {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const files = computeChanges(project.rootPath, ws.root, ws.manifest);
    const now = new Date().toISOString();
    if (taskId) {
      for (const cs of this.db.select().from(changeSets).where(eq(changeSets.taskId, taskId)).all()) {
        if (cs.status === "pending") {
          this.db
            .update(changeSets)
            .set({ status: "superseded", updatedAt: now })
            .where(eq(changeSets.id, cs.id))
            .run();
        }
      }
    }
    if (files.length === 0) return null;
    const id = newId("cs");
    this.db
      .insert(changeSets)
      .values({
        id,
        projectId,
        taskId,
        status: "pending",
        title,
        files: JSON.stringify(files),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getChangeSet(id);
  }

  getChangeSet(id: string): ChangeSet {
    const row = this.db.select().from(changeSets).where(eq(changeSets.id, id)).get();
    if (!row) throw new Error(`Unknown change set: ${id}`);
    return ChangeSetSchema.parse({ ...row, files: JSON.parse(row.files) });
  }

  listChangeSets(projectId: string): ChangeSet[] {
    return this.db
      .select()
      .from(changeSets)
      .where(eq(changeSets.projectId, projectId))
      .orderBy(desc(changeSets.createdAt))
      .limit(100)
      .all()
      .map((row) => ChangeSetSchema.parse({ ...row, files: JSON.parse(row.files) }));
  }

  discardChangeSet(id: string): ChangeSet {
    const cs = this.getChangeSet(id);
    if (cs.status !== "pending" && cs.status !== "partially_applied")
      throw new Error(`This change set is already ${cs.status}.`);
    this.db
      .update(changeSets)
      .set({ status: "discarded", updatedAt: new Date().toISOString() })
      .where(eq(changeSets.id, id))
      .run();
    this.bus.emit({
      projectId: cs.projectId,
      taskId: cs.taskId,
      agent: "user",
      type: "info",
      text: `Discarded changes: ${cs.title}`,
      details: { changeSetId: id },
      status: "cancelled",
    });
    return this.getChangeSet(id);
  }

  /**
   * Copy approved changes from the shadow workspace into the project. A checkpoint of every
   * touched file is saved first, so the whole apply can be undone.
   */
  applyChangeSet(
    id: string,
    ws: Workspace | null,
    selection?: { path: string; hunks?: number[] }[],
  ): { changeSet: ChangeSet; checkpointId: string | null; applied: string[]; conflicts: string[] } {
    const cs = this.getChangeSet(id);
    if (cs.status !== "pending" && cs.status !== "partially_applied")
      throw new Error(`This change set is already ${cs.status}.`);
    const project = this.db.select().from(projects).where(eq(projects.id, cs.projectId)).get();
    if (!project) throw new Error("The project for this change set no longer exists.");
    const want: { path: string; hunks?: number[] }[] =
      selection ?? cs.files.filter((f) => f.status === "pending").map((f) => ({ path: f.path }));

    // Work out the new content of every selected file before touching anything.
    const plan: { change: FileChange; content: Buffer | null; partial: boolean }[] = [];
    const conflicts: string[] = [];
    for (const sel of want) {
      const change = cs.files.find((f) => f.path === sel.path);
      if (!change || change.status === "applied") continue;
      const abs = path.join(project.rootPath, change.path);
      const currentHash = hashFile(abs);
      if (currentHash !== change.baseHash) {
        conflicts.push(change.path);
        continue;
      }
      const whole = !sel.hunks || change.binary || sel.hunks.length === change.hunks.length;
      if (whole) {
        if (change.kind === "deleted") plan.push({ change, content: null, partial: false });
        else {
          if (!ws) throw new Error("The task workspace is gone; this change set can no longer be applied.");
          plan.push({ change, content: fs.readFileSync(path.join(ws.root, change.path)), partial: false });
        }
      } else {
        const current = change.kind === "added" ? "" : fs.readFileSync(abs, "utf8");
        const next = applyHunks(current, change, sel.hunks ?? []);
        if (next === null) {
          conflicts.push(change.path);
          continue;
        }
        plan.push({ change, content: Buffer.from(next, "utf8"), partial: true });
      }
    }
    if (plan.length === 0) {
      return { changeSet: cs, checkpointId: null, applied: [], conflicts };
    }

    const checkpointId = this.saveCheckpoint(
      cs.projectId,
      cs.id,
      `Before applying: ${cs.title}`,
      project.rootPath,
      plan.map((p) => ({ path: p.change.path, appliedHash: p.content ? hashBytes(p.content) : null })),
    );

    const applied: string[] = [];
    for (const p of plan) {
      const abs = path.join(project.rootPath, p.change.path);
      if (p.content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, p.content);
      }
      applied.push(p.change.path);
      p.change.status = p.partial ? "partially_applied" : "applied";
      // The workspace baseline moves forward, so a later diff only shows what is still open.
      if (ws) {
        if (p.content === null) delete ws.manifest[p.change.path];
        else ws.manifest[p.change.path] = hashBytes(p.content);
      }
    }
    if (ws) this.saveManifest(ws);

    const files = cs.files;
    const status: ChangeSet["status"] = files.every((f) => f.status === "applied")
      ? "applied"
      : "partially_applied";
    const now = new Date().toISOString();
    this.db
      .update(changeSets)
      .set({ status, files: JSON.stringify(files), updatedAt: now })
      .where(eq(changeSets.id, id))
      .run();
    this.bus.emit({
      projectId: cs.projectId,
      taskId: cs.taskId,
      agent: "user",
      type: "applied_changes",
      text: `Applied ${applied.length} file${applied.length === 1 ? "" : "s"} to ${project.name}`,
      details: { changeSetId: id, checkpointId, files: applied, conflicts },
      status: "succeeded",
    });
    // Anything left (skipped hunks, files not selected) becomes a fresh pending change set.
    if (ws && status === "partially_applied") this.collectChanges(cs.projectId, cs.taskId, ws, cs.title);
    return { changeSet: this.getChangeSet(id), checkpointId, applied, conflicts };
  }

  /** The shadow workspace a change set came from, if it still exists. */
  workspaceFor(changeSetId: string): Workspace | null {
    const cs = this.db.select().from(changeSets).where(eq(changeSets.id, changeSetId)).get();
    if (!cs?.taskId) return null;
    const task = this.db.select().from(tasks).where(eq(tasks.id, cs.taskId)).get();
    if (!task?.workspacePath || !fs.existsSync(path.join(task.workspacePath, "manifest.json"))) return null;
    return this.loadWorkspace(task.workspacePath);
  }

  // ---- checkpoints -----------------------------------------------------------------------

  private saveCheckpoint(
    projectId: string,
    changeSetId: string | null,
    label: string,
    projectRoot: string,
    files: { path: string; appliedHash: string | null }[],
  ): string {
    const id = newId("chk");
    const dir = path.join(this.dirs.checkpoints, id);
    const entries: Checkpoint["files"] = [];
    for (const f of files) {
      const src = path.join(projectRoot, f.path);
      const existed = fs.existsSync(src);
      if (existed) {
        const dst = path.join(dir, "files", f.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      entries.push({ path: f.path, existed, appliedHash: f.appliedHash });
    }
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    this.db
      .insert(checkpoints)
      .values({
        id,
        projectId,
        changeSetId,
        label,
        status: "active",
        files: JSON.stringify(entries),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.bus.emit({
      projectId,
      agent: "engine",
      type: "checkpoint_created",
      text: label,
      details: { checkpointId: id, files: entries.length },
      status: "succeeded",
    });
    return id;
  }

  listCheckpoints(projectId: string): Checkpoint[] {
    return this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.projectId, projectId))
      .orderBy(desc(checkpoints.createdAt))
      .limit(200)
      .all()
      .map((r) => CheckpointSchema.parse({ ...r, files: JSON.parse(r.files) }));
  }

  /**
   * Undo: put every file back the way it was before the apply. Files the user has edited
   * since are left alone (reported as conflicts) unless `force` is set.
   */
  restoreCheckpoint(
    id: string,
    force = false,
  ): { restored: string[]; conflicts: string[]; checkpoint: Checkpoint } {
    const row = this.db.select().from(checkpoints).where(eq(checkpoints.id, id)).get();
    if (!row) throw new Error(`Unknown checkpoint: ${id}`);
    if (row.status !== "active") throw new Error("This checkpoint was already restored.");
    const project = this.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) throw new Error("The project for this checkpoint no longer exists.");
    const cp = CheckpointSchema.parse({ ...row, files: JSON.parse(row.files) });
    const conflicts = cp.files
      .filter((f) => hashFile(path.join(project.rootPath, f.path)) !== f.appliedHash)
      .map((f) => f.path);
    if (conflicts.length && !force) return { restored: [], conflicts, checkpoint: cp };
    const restored: string[] = [];
    for (const f of cp.files) {
      const dst = path.join(project.rootPath, f.path);
      if (f.existed) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(this.dirs.checkpoints, id, "files", f.path), dst);
      } else {
        fs.rmSync(dst, { force: true });
      }
      restored.push(f.path);
    }
    const now = new Date().toISOString();
    this.db
      .update(checkpoints)
      .set({ status: "restored", updatedAt: now })
      .where(eq(checkpoints.id, id))
      .run();
    if (cp.changeSetId) {
      this.db
        .update(changeSets)
        .set({ status: "reverted", updatedAt: now })
        .where(eq(changeSets.id, cp.changeSetId))
        .run();
    }
    this.bus.emit({
      projectId: cp.projectId,
      agent: "user",
      type: "info",
      text: `Undid changes: restored ${restored.length} file${restored.length === 1 ? "" : "s"}`,
      details: { checkpointId: id, files: restored },
      status: "succeeded",
    });
    return { restored, conflicts, checkpoint: { ...cp, status: "restored" } };
  }
}

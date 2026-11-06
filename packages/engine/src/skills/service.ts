import fs from "node:fs";
import path from "node:path";
import { newId } from "@depo/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../db";
import { skillAssignments, skills } from "../db/schema";
import type { EventBus } from "../events/bus";
import { type AgentTool, type ToolContext, tool } from "../tools/index";
import { ToolError } from "../tools/paths";
import { DEFAULT_GITHUB, downloadGithubZip, type GithubEndpoints, parseGithubUrl } from "../util/github";
import { extractZip, listZip } from "../util/unzip";
import { findSkillDirs, listSkillFiles, type ParsedSkill, parseSkillMd } from "./parse";
import { type VetReport, vetDirectory } from "./vet";

export interface SkillVersion {
  id: string;
  commit: string | null;
  ref: string | null;
  at: string;
}

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  sourceKind: "github" | "zip" | "folder" | "created";
  source: string;
  ref: string | null;
  commit: string | null;
  versionId: string;
  versions: SkillVersion[];
  enabled: boolean;
  vetting: VetReport;
  assignments: { scope: "global" | "project"; projectId: string | null; agent: string }[];
  files: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  path: string;
  name: string;
  description: string;
  error: string | null;
  installed: boolean;
}

export interface SkillServiceOptions {
  db: AppDb;
  bus: EventBus;
  dir: string;
  /** Where GitHub archives are fetched from (tests point this at a local server). */
  github?: GithubEndpoints;
  /** Draft a SKILL.md from a described workflow with a local model (set by the engine). */
  draft?: (workflow: string) => Promise<{ name: string; description: string; instructions: string }>;
  fetchImpl?: typeof fetch;
}

const MAX_DOWNLOAD = 150 * 1024 * 1024;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const KEEP_VERSIONS = 3;

interface Staging {
  id: string;
  dir: string;
  kind: SkillDto["sourceKind"];
  source: string;
  ref: string | null;
  commit: string | null;
  candidates: Candidate[];
  at: number;
}

/**
 * Skills: folders with a SKILL.md (compatible with Claude Agent Skills). Installed from a GitHub URL,
 * a .zip or a folder; scanned before they can be enabled; assigned to agents; pinned to a commit.
 * Agents see only each skill's name and description, and load the instructions when they need them.
 */
export class SkillService {
  private readonly staging = new Map<string, Staging>();
  private readonly fetchImpl: typeof fetch;
  private readonly gh: GithubEndpoints;

  constructor(private readonly o: SkillServiceOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.gh = o.github ?? DEFAULT_GITHUB;
    fs.mkdirSync(o.dir, { recursive: true });
    this.cleanStaging();
  }

  private get stagingRoot() {
    return path.join(this.o.dir, ".staging");
  }

  private cleanStaging() {
    try {
      fs.rmSync(this.stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // a locked file: it is removed next time
    }
  }

  // ---- reading ---------------------------------------------------------------------------

  list(): SkillDto[] {
    return this.o.db
      .select()
      .from(skills)
      .orderBy(asc(skills.name))
      .all()
      .map((r) => this.toDto(r));
  }

  get(id: string): SkillDto {
    const r = this.o.db.select().from(skills).where(eq(skills.id, id)).get();
    if (!r) throw new Error(`Unknown skill: ${id}`);
    return this.toDto(r);
  }

  /** The folder of the active version. */
  dirOf(s: Pick<SkillDto, "name" | "versionId">): string {
    return path.join(this.o.dir, s.name, s.versionId);
  }

  instructions(id: string): { skill: SkillDto; body: string; files: string[] } {
    const skill = this.get(id);
    const parsed = parseSkillMd(fs.readFileSync(path.join(this.dirOf(skill), "SKILL.md"), "utf8"));
    return { skill, body: parsed.body, files: skill.files };
  }

  private toDto(r: typeof skills.$inferSelect): SkillDto {
    const assignments = this.o.db
      .select()
      .from(skillAssignments)
      .where(eq(skillAssignments.skillId, r.id))
      .all()
      .map((a) => ({
        scope: a.scope as "global" | "project",
        projectId: a.projectId || null,
        agent: a.agent,
      }));
    const dto: SkillDto = {
      id: r.id,
      name: r.name,
      description: r.description,
      sourceKind: r.sourceKind as SkillDto["sourceKind"],
      source: r.source,
      ref: r.ref,
      commit: r.commitSha,
      versionId: r.versionId,
      versions: JSON.parse(r.versions) as SkillVersion[],
      enabled: r.enabled === 1,
      vetting: JSON.parse(r.vetting) as VetReport,
      assignments,
      files: [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    dto.files = listSkillFiles(this.dirOf(dto));
    return dto;
  }

  // ---- staging and install ---------------------------------------------------------------

  /** Fetch or copy a source into a temporary folder and list the skills in it. */
  async preview(input: {
    source: string;
    ref?: string;
  }): Promise<{ stagingId: string; kind: string; candidates: Candidate[]; commit: string | null }> {
    const source = input.source.trim();
    if (!source) throw new Error("Give a GitHub URL, a .zip file or a folder.");
    const id = newId("skl");
    const dir = path.join(this.stagingRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    let kind: SkillDto["sourceKind"];
    let commit: string | null = null;
    let ref: string | null = input.ref?.trim() || null;
    let subpath = "";
    try {
      const gh = parseGithubUrl(source);
      if (gh) {
        kind = "github";
        ref = ref ?? gh.ref;
        subpath = gh.subpath;
        const zip = path.join(dir, "..", `${id}.zip`);
        const res = await downloadGithubZip({ ...gh, ref }, zip, {
          endpoints: this.gh,
          fetchImpl: this.fetchImpl,
          maxBytes: MAX_DOWNLOAD,
        });
        commit = res.commit;
        extractZip(zip, dir, { strip: 1, maxFiles: 3000, maxTotalBytes: 200 * 1024 * 1024 });
        fs.rmSync(zip, { force: true });
      } else if (/^https?:\/\//i.test(source)) {
        throw new Error(
          "Only github.com URLs are supported. Download the skill as a .zip or folder instead.",
        );
      } else if (/\.zip$/i.test(source)) {
        kind = "zip";
        if (!fs.existsSync(source)) throw new Error(`File not found: ${source}`);
        listZip(source);
        // A zip may hold one wrapper folder (GitHub style) or SKILL.md at the top.
        extractZip(source, dir, { maxFiles: 3000 });
      } else {
        kind = "folder";
        if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
          throw new Error(`Folder not found: ${source}`);
        copyTree(source, dir, MAX_SKILL_BYTES * 5);
      }
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const found = findSkillDirs(dir, subpath);
    // A repository with a single wrapper folder: look one level down as well.
    const candidates: Candidate[] = found.map((p) => {
      try {
        const parsed = parseSkillMd(fs.readFileSync(path.join(dir, p, "SKILL.md"), "utf8"));
        return {
          path: p,
          name: parsed.name,
          description: parsed.description,
          error: null,
          installed: this.byName(parsed.name) !== null,
        };
      } catch (err) {
        return {
          path: p,
          name: path.basename(p) || "(root)",
          description: "",
          error: err instanceof Error ? err.message : String(err),
          installed: false,
        };
      }
    });
    if (candidates.length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error("No SKILL.md was found in that source.");
    }
    this.staging.set(id, { id, dir, kind, source, ref, commit, candidates, at: Date.now() });
    return { stagingId: id, kind, candidates, commit };
  }

  /** Install the chosen skills from a preview. Skills start disabled until the user enables them. */
  install(input: { stagingId: string; select?: string[] }): SkillDto[] {
    const st = this.staging.get(input.stagingId);
    if (!st) throw new Error("The preview has expired. Start the install again.");
    const picks = (
      input.select?.length ? input.select : st.candidates.length === 1 ? [st.candidates[0]?.path ?? ""] : []
    ).filter(Boolean);
    if (picks.length === 0) throw new Error("Choose which skills to install.");
    const out: SkillDto[] = [];
    try {
      for (const p of picks) {
        const c = st.candidates.find((x) => x.path === p);
        if (!c || c.error) throw new Error(c?.error ?? `Unknown skill: ${p}`);
        out.push(
          this.installFrom(path.join(st.dir, p), {
            kind: st.kind,
            source: st.source,
            ref: st.ref,
            commit: st.commit,
          }),
        );
      }
    } finally {
      this.discard(input.stagingId);
    }
    return out;
  }

  discard(stagingId: string) {
    const st = this.staging.get(stagingId);
    if (!st) return;
    this.staging.delete(stagingId);
    fs.rmSync(st.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  private byName(name: string) {
    return this.o.db.select().from(skills).where(eq(skills.name, name)).get() ?? null;
  }

  private installFrom(
    srcDir: string,
    meta: { kind: SkillDto["sourceKind"]; source: string; ref: string | null; commit: string | null },
  ): SkillDto {
    const parsed: ParsedSkill = parseSkillMd(fs.readFileSync(path.join(srcDir, "SKILL.md"), "utf8"));
    const existing = this.byName(parsed.name);
    const versions: SkillVersion[] = existing ? (JSON.parse(existing.versions) as SkillVersion[]) : [];
    const stamp = new Date().toISOString();
    const base = meta.commit ? meta.commit.slice(0, 8) : `v${versions.length + 1}`;
    let versionId = base;
    while (versions.some((v) => v.id === versionId)) versionId = `${base}-${versions.length + 1}`;
    const dest = path.join(this.o.dir, parsed.name, versionId);
    copyTree(srcDir, dest, MAX_SKILL_BYTES);
    const vetting = vetDirectory(dest);
    versions.push({ id: versionId, commit: meta.commit, ref: meta.ref, at: stamp });
    const kept = versions.slice(-KEEP_VERSIONS);
    for (const gone of versions.slice(0, -KEEP_VERSIONS)) {
      fs.rmSync(path.join(this.o.dir, parsed.name, gone.id), { recursive: true, force: true });
    }
    if (existing) {
      // An update that is worse than what was approved must be approved again.
      const before = JSON.parse(existing.vetting) as VetReport;
      const worse = rank(vetting.verdict) > rank(before.verdict);
      this.o.db
        .update(skills)
        .set({
          description: parsed.description,
          sourceKind: meta.kind,
          source: meta.source,
          ref: meta.ref,
          commitSha: meta.commit,
          versionId,
          versions: JSON.stringify(kept),
          vetting: JSON.stringify(vetting),
          enabled: worse ? 0 : existing.enabled,
          updatedAt: stamp,
        })
        .where(eq(skills.id, existing.id))
        .run();
      this.event(`Updated skill ${parsed.name} to ${versionId}`, { name: parsed.name, versionId });
      return this.get(existing.id);
    }
    const id = newId("skl");
    this.o.db
      .insert(skills)
      .values({
        id,
        name: parsed.name,
        description: parsed.description,
        sourceKind: meta.kind,
        source: meta.source,
        ref: meta.ref,
        commitSha: meta.commit,
        versionId,
        versions: JSON.stringify(kept),
        enabled: 0,
        vetting: JSON.stringify(vetting),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    this.event(`Installed skill ${parsed.name} (${vetting.verdict})`, {
      name: parsed.name,
      verdict: vetting.verdict,
    });
    return this.get(id);
  }

  // ---- enabling and assignment -----------------------------------------------------------

  /** Enabling needs the vetting report to have been seen; blocked skills need an explicit override. */
  setEnabled(id: string, enabled: boolean, force = false): SkillDto {
    const s = this.get(id);
    if (enabled && s.vetting.verdict === "blocked" && !force) {
      throw new Error(
        `The security scan found serious problems in "${s.name}" (${s.vetting.findings.filter((f) => f.severity === "high").length} high). Read the report; enable it only if you trust the source.`,
      );
    }
    this.o.db
      .update(skills)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(skills.id, id))
      .run();
    if (enabled && s.assignments.length === 0) this.assign(id, { scope: "global", agents: ["*"] });
    this.event(`${enabled ? "Enabled" : "Disabled"} skill ${s.name}`, { name: s.name, enabled });
    return this.get(id);
  }

  /** Replace the assignments of one scope: all agents (`*`) or a list, globally or for one project. */
  assign(id: string, input: { scope: "global" | "project"; projectId?: string; agents: string[] }): SkillDto {
    this.get(id);
    const project = input.scope === "project" ? (input.projectId ?? "") : "";
    if (input.scope === "project" && !project) throw new Error("Choose a project.");
    this.o.db
      .delete(skillAssignments)
      .where(
        and(
          eq(skillAssignments.skillId, id),
          eq(skillAssignments.scope, input.scope),
          eq(skillAssignments.projectId, project),
        ),
      )
      .run();
    for (const agent of new Set(input.agents.length ? input.agents : [])) {
      this.o.db
        .insert(skillAssignments)
        .values({ skillId: id, scope: input.scope, projectId: project, agent })
        .run();
    }
    return this.get(id);
  }

  remove(id: string): { ok: true } {
    const s = this.get(id);
    this.o.db.delete(skillAssignments).where(eq(skillAssignments.skillId, id)).run();
    this.o.db.delete(skills).where(eq(skills.id, id)).run();
    fs.rmSync(path.join(this.o.dir, s.name), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    this.event(`Removed skill ${s.name}`, { name: s.name });
    return { ok: true };
  }

  // ---- updates and rollback --------------------------------------------------------------

  /** Compare the pinned commit of each GitHub skill with the latest on its branch. */
  async checkUpdates(): Promise<
    { id: string; name: string; current: string | null; latest: string | null; available: boolean }[]
  > {
    const out = [];
    for (const s of this.list()) {
      if (s.sourceKind !== "github") continue;
      const gh = parseGithubUrl(s.source);
      let latest: string | null = null;
      if (gh) {
        try {
          const res = await this.fetchImpl(
            `${this.gh.api}/repos/${gh.owner}/${gh.repo}/commits/${encodeURIComponent(s.ref ?? "HEAD")}`,
            {
              headers: { Accept: "application/vnd.github.sha" },
            },
          );
          if (res.ok) latest = (await res.text()).trim().slice(0, 40);
        } catch {
          latest = null;
        }
      }
      out.push({
        id: s.id,
        name: s.name,
        current: s.commit,
        latest,
        available: !!latest && !!s.commit && latest !== s.commit,
      });
    }
    return out;
  }

  /** Install the newest version of a skill from where it came from. */
  async update(id: string): Promise<SkillDto> {
    const s = this.get(id);
    if (s.sourceKind === "created")
      throw new Error("This skill was written in Depo; there is nothing to update from.");
    const pv = await this.preview({ source: s.source, ...(s.ref ? { ref: s.ref } : {}) });
    const match = pv.candidates.find((c) => c.name === s.name);
    if (!match) {
      this.discard(pv.stagingId);
      throw new Error(`"${s.name}" is no longer in that source.`);
    }
    const [updated] = this.install({ stagingId: pv.stagingId, select: [match.path] });
    if (!updated) throw new Error("Update failed.");
    return updated;
  }

  rollback(id: string): SkillDto {
    const s = this.get(id);
    const i = s.versions.findIndex((v) => v.id === s.versionId);
    const prev = s.versions[i - 1];
    if (!prev) throw new Error("There is no earlier version to go back to.");
    const dir = path.join(this.o.dir, s.name, prev.id);
    if (!fs.existsSync(dir)) throw new Error("The earlier version is no longer on disk.");
    const vetting = vetDirectory(dir);
    this.o.db
      .update(skills)
      .set({
        versionId: prev.id,
        commitSha: prev.commit,
        ref: prev.ref,
        vetting: JSON.stringify(vetting),
        enabled:
          vetting.verdict === "blocked"
            ? 0
            : (this.o.db.select().from(skills).where(eq(skills.id, id)).get()?.enabled ?? 0),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(skills.id, id))
      .run();
    this.event(`Rolled ${s.name} back to ${prev.id}`, { name: s.name, versionId: prev.id });
    return this.get(id);
  }

  // ---- creating --------------------------------------------------------------------------

  /** The Skill Creator: turn a described workflow into a draft the user can edit and save. */
  async draft(workflow: string): Promise<{ name: string; description: string; instructions: string }> {
    if (this.o.draft) {
      try {
        return await this.o.draft(workflow);
      } catch {
        // fall through to the template
      }
    }
    const name =
      workflow
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "new-skill";
    return {
      name,
      description: `Use when the user asks for: ${workflow.trim().slice(0, 200)}`,
      instructions: `# ${name}\n\n## When to use\n${workflow.trim()}\n\n## Steps\n1. Understand the request and the project.\n2. Do the work step by step, checking each result.\n3. Report what changed.\n`,
    };
  }

  create(input: { name: string; description: string; instructions: string }): SkillDto {
    const text = `---\nname: ${input.name}\ndescription: ${input.description.replace(/\n/g, " ")}\n---\n${input.instructions}\n`;
    parseSkillMd(text); // validates
    const tmp = path.join(this.stagingRoot, newId("skl"));
    fs.mkdirSync(tmp, { recursive: true });
    try {
      fs.writeFileSync(path.join(tmp, "SKILL.md"), text);
      return this.installFrom(tmp, { kind: "created", source: "created in Depo", ref: null, commit: null });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- what agents see -------------------------------------------------------------------

  /** Enabled skills assigned to this agent in this project (global assignments and project ones). */
  forAgent(agentId: string, projectId: string): SkillDto[] {
    return this.list().filter(
      (s) =>
        s.enabled &&
        s.assignments.some(
          (a) =>
            (a.scope === "global" || a.projectId === projectId) && (a.agent === "*" || a.agent === agentId),
        ),
    );
  }

  /** Prompt text and tools for one agent run. */
  extrasFor(
    agentId: string,
    projectId: string,
  ): { prompt: string; tools: AgentTool<z.ZodType>[]; allow: string[] } {
    const mine = this.forAgent(agentId, projectId);
    if (mine.length === 0) return { prompt: "", tools: [], allow: [] };
    const prompt = [
      "# Skills",
      "These skills are installed for you. When one fits the task, load it with use_skill before you start and follow it.",
      ...mine.map((s) => `- ${s.name}: ${s.description}`),
    ].join("\n");
    const root = this.o.dir;
    const find = (name: string) => {
      const s = mine.find((x) => x.name === name);
      if (!s)
        throw new ToolError(`No skill named "${name}". Available: ${mine.map((x) => x.name).join(", ")}.`);
      return s;
    };
    const emit = (ctx: ToolContext, text: string, name: string) =>
      ctx.bus.emit({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        type: "info",
        text,
        details: { skill: name },
        status: "succeeded",
      });
    const tools: AgentTool<z.ZodType>[] = [
      tool({
        name: "use_skill",
        description: "Load the full instructions of an installed skill (and the list of its other files).",
        schema: z.object({ name: z.string().min(1).max(80) }),
        async run(a, ctx) {
          const s = find(a.name);
          const parsed = parseSkillMd(
            fs.readFileSync(path.join(root, s.name, s.versionId, "SKILL.md"), "utf8"),
          );
          emit(ctx, `Using skill ${s.name}`, s.name);
          const others = s.files.filter((f) => f !== "SKILL.md");
          return `# Skill: ${s.name} (version ${s.versionId})\n${parsed.body}${others.length ? `\n\nOther files in this skill (read with read_skill_file):\n${others.map((f) => `- ${f}`).join("\n")}` : ""}`;
        },
      }),
      tool({
        name: "read_skill_file",
        description: "Read a reference document or template that belongs to an installed skill.",
        schema: z.object({ name: z.string().min(1).max(80), path: z.string().min(1).max(300) }),
        async run(a) {
          const s = find(a.name);
          const dir = path.join(root, s.name, s.versionId);
          // Only files the skill itself lists (no symlinks, no absolute or drive paths, no "..").
          const wanted = a.path.replaceAll("\\", "/").replace(/^\.\//, "");
          if (!s.files.includes(wanted)) throw new ToolError(`No file ${a.path} in skill ${s.name}.`);
          const abs = path.join(dir, wanted);
          if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile())
            throw new ToolError(`No file ${a.path} in skill ${s.name}.`);
          if (fs.statSync(abs).size > 200_000) throw new ToolError("That file is too large to read.");
          return fs.readFileSync(abs, "utf8");
        },
      }),
    ];
    return { prompt, tools, allow: tools.map((t) => t.name) };
  }

  // ---- helpers ---------------------------------------------------------------------------

  private event(text: string, details: Record<string, string | boolean>) {
    this.o.bus.emit({ agent: "engine", type: "info", text, details, status: "succeeded" });
  }
}

const rank = (v: VetReport["verdict"]) => (v === "clean" ? 0 : v === "warnings" ? 1 : 2);

function copyTree(src: string, dest: string, maxBytes: number) {
  let total = 0;
  const walk = (s: string, d: string) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const from = path.join(s, e.name);
      const to = path.join(d, e.name);
      if (e.isDirectory()) walk(from, to);
      else {
        total += fs.statSync(from).size;
        if (total > maxBytes) throw new Error("The skill is larger than the allowed size.");
        fs.copyFileSync(from, to);
      }
    }
  };
  walk(src, dest);
}

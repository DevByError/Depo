import {
  API_FINGERPRINT,
  type ApiMethod,
  type ApiParsedParams,
  type ApiResult,
  DEPO_VERSION,
} from "@depo/shared";
import type { TaskManager } from "../agent/tasks";
import type { AgentLab } from "../agents/lab";
import { MANIFESTS } from "../agents/manifests";
import type { ApprovalCenter } from "../approvals";
import { BLOCKS } from "../blocks";
import type { CodeIndexer } from "../codeindex/indexer";
import { FONT_LIBRARY } from "../design/fonts";
import type { DesignService } from "../design/service";
import type { EventBus } from "../events/bus";
import type { OsvService } from "../knowledge/osv";
import type { KnowledgeService } from "../knowledge/service";
import type { LogService } from "../logs/service";
import type { McpManager } from "../mcp/manager";
import { readableDir } from "../memory/auto";
import type { MemoryStore } from "../memory/store";
import type { ModelManager } from "../models/manager";
import type { PreviewManager } from "../preview/manager";
import type { ProjectRegistry } from "../projects/registry";
import type { QaService } from "../qa/service";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { SecurityService } from "../security/service";
import type { SettingsRepo } from "../settings";
import type { SkillService } from "../skills/service";
import { checkForUpdate } from "../util/update";
import type { ProjectService } from "../workspace/service";

export interface HandlerContext {
  bus: EventBus;
  settings: SettingsRepo;
  models: ModelManager;
  approvals: ApprovalCenter;
  projects: ProjectService;
  tasks: TaskManager;
  registry: ProjectRegistry;
  memory: MemoryStore;
  scheduler: ModelScheduler;
  indexer: CodeIndexer;
  design: DesignService;
  skills: SkillService;
  mcp: McpManager;
  knowledge: KnowledgeService;
  osv: OsvService;
  security: SecurityService;
  lab: AgentLab;
  /** Engine logs: search, live tail, diagnostics export, model timings. */
  logs: LogService;
  previews: PreviewManager;
  /** Page checks in a headless browser (absent in engines built without it, e.g. some tests). */
  qa?: QaService;
  /** Test hook: where the release lookup goes. */
  updateApi?: string;
  info: {
    startedAt: Date;
    dataDir: string;
    dbPath: string;
    schemaVersion: number;
  };
}

async function schedulerStatus(ctx: HandlerContext) {
  const all = await ctx.projects.list(true);
  const paused = all.filter((p) => ctx.registry.getSettings(p.id).paused).map((p) => p.id);
  return ctx.scheduler.status(paused);
}

async function removeProject(id: string, ctx: HandlerContext) {
  // Running previews hold the folders open (Windows) and must not outlive their project.
  await ctx.previews.stopProject(id);
  ctx.registry.delete(id);
  ctx.indexer.forget(id);
  ctx.scheduler.refresh();
  return { ok: true as const };
}

function systemInfo(ctx: HandlerContext) {
  return {
    engineVersion: DEPO_VERSION,
    runtime: `bun ${Bun.version}`,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    startedAt: ctx.info.startedAt.toISOString(),
    dataDir: ctx.info.dataDir,
    dbPath: ctx.info.dbPath,
    schemaVersion: ctx.info.schemaVersion,
    apiFingerprint: API_FINGERPRINT,
  };
}

function needLogs(ctx: HandlerContext): LogService {
  if (!ctx.logs) throw new Error("Logs are not available in this engine.");
  return ctx.logs;
}

function needQa(ctx: HandlerContext): QaService {
  if (!ctx.qa) throw new Error("Page checks are not available in this engine.");
  return ctx.qa;
}

export type Handlers = {
  [M in ApiMethod]: (params: ApiParsedParams<M>, ctx: HandlerContext) => ApiResult<M> | Promise<ApiResult<M>>;
};

/** Engine API implementation. Pure functions of (params, context): no UI, no transport. */
export const handlers: Handlers = {
  "system.ping": () => ({ pong: true, serverTime: new Date().toISOString() }),

  "system.info": (_params, ctx) => systemInfo(ctx),

  "events.recent": (params, ctx) => ({
    events: ctx.bus.recent({
      limit: params.limit,
      ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
      ...(params.types ? { types: params.types } : {}),
      ...(params.query ? { query: params.query } : {}),
    }),
  }),

  "events.emit": (params, ctx) =>
    ctx.bus.emit({ agent: "user", type: params.type, text: params.text, details: params.details ?? null }),

  "settings.get": (params, ctx) => ({ key: params.key, value: ctx.settings.get(params.key) }),

  "settings.set": (params, ctx) => {
    const value = ctx.settings.set(params.key, params.value);
    ctx.bus.emit({
      agent: "engine",
      type: "settings_changed",
      text: `Setting ${params.key} changed`,
      details: { key: params.key, value },
    });
    return { key: params.key, value };
  },

  "settings.all": (_params, ctx) => ({ settings: ctx.settings.all() }),

  "hardware.get": (_p, ctx) => ({ profile: ctx.models.hardware() }),
  "hardware.profile": async (_p, ctx) => ({ profile: await ctx.models.profileHardware(ctx.info.dataDir) }),
  "models.providers": async (_p, ctx) => ({ providers: await ctx.models.providerStatus() }),
  "models.providers.set": (p, ctx) => ({ providers: ctx.models.setProviders(p.providers) }),
  "models.installed": async (_p, ctx) => ({ models: await ctx.models.installed() }),
  "models.catalog": (_p, ctx) => ctx.models.catalog(),
  "models.catalog.import": (p, ctx) => ctx.models.importCatalog(p.json),
  "models.plan": (p, ctx) => ({ plan: ctx.models.plan(p.mode) }),
  "models.assignments": (_p, ctx) => ctx.models.assignments(),
  "models.assign": (p, ctx) => ctx.models.assign(p.role, p.ref),
  "models.pull": (p, ctx) => ctx.models.startPull(p, ctx.info.dataDir),
  "models.pull.cancel": (p, ctx) => ({ cancelled: ctx.models.cancelPull(p.jobId) }),
  "models.pulls": (_p, ctx) => ({ jobs: ctx.models.pulls() }),
  "models.delete": async (p, ctx) => {
    await ctx.models.remove(p);
    return { deleted: true as const };
  },
  "models.benchmark": async (p, ctx) => ({ benchmark: await ctx.models.benchmark(p) }),

  "approvals.list": (_p, ctx) => ({ approvals: ctx.approvals.list() }),
  "approvals.respond": (p, ctx) => {
    const req = ctx.approvals.list().find((a) => a.id === p.id);
    const ok = ctx.approvals.respond(p.id, p.approve);
    // A decline with a reason teaches Depo a preference (memory.auto).
    if (ok && !p.approve && req && p.reason) ctx.tasks.autoMemory?.learnFromDecline(req, p.reason);
    return { ok };
  },

  "projects.list": async (p, ctx) => ({ projects: await ctx.projects.list(p.includeArchived ?? false) }),
  "projects.open": async (p, ctx) => {
    const project = await ctx.projects.open(p.path);
    ctx.indexer.ensure(project.id);
    return project;
  },
  "projects.forget": (p, ctx) => removeProject(p.id, ctx),
  "projects.create": async (p, ctx) => {
    const project = await ctx.registry.create(p);
    ctx.indexer.ensure(project.id);
    return project;
  },
  "projects.import": async (p, ctx) => {
    const project = await ctx.registry.importSource(p);
    ctx.indexer.ensure(project.id);
    return project;
  },
  "projects.update": async (p, ctx) => {
    const { id, ...patch } = p;
    const project = await ctx.registry.update(id, patch);
    if (patch.archived === true) ctx.indexer.stop(id);
    if (patch.archived === false) ctx.indexer.ensure(id);
    return project;
  },
  "projects.duplicate": async (p, ctx) => {
    const project = await ctx.registry.duplicate(p.id, p.name);
    ctx.indexer.ensure(project.id);
    return project;
  },
  "projects.export": (p, ctx) => ctx.registry.exportProject(p.id, p.destDir),
  "projects.delete": (p, ctx) => removeProject(p.id, ctx),
  "projects.settings.get": (p, ctx) => ctx.registry.getSettings(p.id),
  "projects.settings.set": (p, ctx) => {
    const next = ctx.registry.setSettings(p.id, p.patch);
    ctx.scheduler.refresh();
    if (next.indexEnabled) ctx.indexer.ensure(p.id);
    else ctx.indexer.stop(p.id);
    return next;
  },
  "projects.overview": async (p, ctx) => {
    const project = await ctx.projects.get(p.id);
    const facts = ctx.memory.list(p.id);
    return {
      project,
      taskCounts: ctx.registry.taskCounts(p.id),
      lastTestRun: ctx.registry.lastTestRun(p.id),
      recentChanges: ctx.registry.recentChanges(p.id),
      index: ctx.indexer.status(p.id),
      memory: {
        facts: facts.filter((f) => f.kind !== "lesson").length,
        lessons: facts.filter((f) => f.kind === "lesson").length,
        markdownChars: ctx.memory.getMarkdown(p.id).length,
      },
    };
  },
  "memory.get": (p, ctx) => ({
    markdown: ctx.memory.getMarkdown(p.projectId),
    facts: ctx.memory.list(p.projectId),
  }),
  "memory.setMarkdown": (p, ctx) => {
    ctx.memory.setMarkdown(p.projectId, p.markdown, "user");
    return { ok: true as const };
  },
  "memory.addFact": (p, ctx) => ctx.memory.add(p.projectId, p.kind, p.text, "user"),
  "memory.updateFact": (p, ctx) => ctx.memory.update(p.id, p.text),
  "memory.deleteFact": (p, ctx) => {
    ctx.memory.remove(p.id);
    return { ok: true as const };
  },
  "index.status": (p, ctx) => ctx.indexer.status(p.projectId),
  "index.rebuild": (p, ctx) => ctx.indexer.rebuild(p.projectId),
  "index.search": async (p, ctx) => ({ hits: await ctx.indexer.search(p.projectId, p.query, p.limit ?? 10) }),
  "scheduler.status": (_p, ctx) => schedulerStatus(ctx),
  "scheduler.pause": (p, ctx) => {
    if (p.projectId) ctx.registry.setSettings(p.projectId, { paused: true });
    ctx.scheduler.pause(p.projectId);
    return schedulerStatus(ctx);
  },
  "scheduler.resume": (p, ctx) => {
    if (p.projectId) ctx.registry.setSettings(p.projectId, { paused: false });
    ctx.scheduler.resume(p.projectId);
    return schedulerStatus(ctx);
  },
  "scheduler.configure": (p, ctx) => {
    ctx.settings.set("scheduler.max_parallel", p.maxParallel);
    ctx.scheduler.refresh();
    return schedulerStatus(ctx);
  },
  "files.list": (p, ctx) => ({ entries: ctx.projects.listFiles(p.projectId, p.path) }),
  "files.read": (p, ctx) => ctx.projects.readFile(p.projectId, p.path),
  "changes.list": (p, ctx) => ({ changeSets: ctx.projects.listChangeSets(p.projectId) }),
  "changes.get": (p, ctx) => ctx.projects.getChangeSet(p.id),
  "changes.apply": (p, ctx) => ctx.projects.applyChangeSet(p.id, ctx.projects.workspaceFor(p.id), p.files),
  "changes.discard": async (p, ctx) => {
    const cs = ctx.projects.discardChangeSet(p.id);
    // Facts read from the discarded work no longer hold; a reason becomes a preference.
    if (ctx.tasks.autoMemory?.enabled()) {
      const root = (await ctx.projects.list(true)).find((x) => x.id === cs.projectId)?.rootPath ?? null;
      ctx.tasks.autoMemory.learnFromDiscard(cs, p.reason, readableDir(root));
    }
    return cs;
  },
  "tasks.list": (p, ctx) => ({ tasks: ctx.tasks.list(p.projectId) }),
  "tasks.active": (_p, ctx) => ({ tasks: ctx.tasks.active() }),
  "tasks.get": (p, ctx) => ctx.tasks.get(p.id),
  "tasks.send": (p, ctx) => ctx.tasks.send(p.projectId, p.text, p.taskId, p.mode),
  "agents.list": (_p, ctx) => ({ agents: MANIFESTS.map((m) => ctx.lab.active(m.id)) }),
  "app.checkUpdate": async (_p, ctx) => {
    const repo = ctx.settings.get("update.repo");
    return checkForUpdate({
      current: DEPO_VERSION,
      repo: typeof repo === "string" ? repo : "",
      ...(ctx.updateApi ? { api: ctx.updateApi } : {}),
    });
  },
  "blocks.list": () => ({
    blocks: BLOCKS.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      stack: b.stack,
      tags: b.tags,
      files: b.files.map((f) => f.path),
      test: b.test,
      notes: b.notes,
    })),
  }),
  "lab.agents": (_p, ctx) => ({ agents: ctx.lab.list() }),
  "lab.versions": (p, ctx) => ({
    versions: ctx.lab.versions(p.agentId),
    history: ctx.lab.history(p.agentId),
  }),
  "lab.createVersion": (p, ctx) => ctx.lab.createVersion(p.agentId, p.patch, p.note),
  "lab.deleteVersion": (p, ctx) => {
    ctx.lab.deleteVersion(p.agentId, p.versionId);
    return { ok: true as const };
  },
  "lab.promote": (p, ctx) => ({
    versions: ctx.lab.promote(p.agentId, p.versionId, p.force ? { force: true } : {}),
  }),
  "lab.rollback": (p, ctx) => ({ versions: ctx.lab.rollback(p.agentId) }),
  "lab.suites": (p, ctx) => ({ suites: ctx.lab.suites(p.agentId) }),
  "lab.saveSuite": (p, ctx) => ctx.lab.saveSuite(p.agentId, p.name, p.cases),
  "lab.deleteSuite": (p, ctx) => {
    ctx.lab.deleteSuite(p.agentId, p.suiteId);
    return { ok: true as const };
  },
  "lab.runEval": (p, ctx) => ctx.lab.runEval(p.agentId, p.versionId, p.suiteId),
  "lab.runs": (p, ctx) => ({ runs: ctx.lab.runs(p.agentId) }),
  "lab.compare": (p, ctx) => ctx.lab.compare(p.agentId, p.a, p.b, p.suiteId),
  "lab.playground": (p, ctx) => ctx.lab.playground(p.agentId, p.versionId, p.messages),
  "lab.export": (p, ctx) => ({ json: JSON.stringify(ctx.lab.exportBundle(p.agentId, p.versionId), null, 2) }),
  "lab.import": (p, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.json);
    } catch {
      throw new Error("This is not valid JSON.");
    }
    return ctx.lab.importBundle(parsed);
  },
  "team.get": (p, ctx) => ctx.tasks.teamState(p.taskId),
  "preview.targets": (p, ctx) => ({ targets: ctx.previews.targets(p.projectId) }),
  "preview.detect": (p, ctx) => ctx.previews.detect(p.projectId, p.taskId),
  "preview.start": (p, ctx) =>
    ctx.previews.start({
      projectId: p.projectId,
      taskId: p.taskId ?? null,
      ...(p.recipe ? { recipe: p.recipe } : {}),
      install: p.install ?? false,
    }),
  "preview.stop": async (p, ctx) => ({ stopped: await ctx.previews.stop(p.id) }),
  "preview.restart": async (p, ctx) => ({ preview: await ctx.previews.restart(p.id) }),
  "preview.list": (p, ctx) => ({ previews: ctx.previews.list(p.projectId) }),
  "preview.logs": (p, ctx) => ctx.previews.logs(p.id, p.since ?? 0),
  "team.timeline": (p, ctx) => ctx.tasks.teamTimeline(p.taskId),
  "skills.list": (_p, ctx) => ({ skills: ctx.skills.list() }),
  "skills.get": (p, ctx) => {
    const i = ctx.skills.instructions(p.id);
    return { skill: i.skill, body: i.body };
  },
  "skills.preview": (p, ctx) => ctx.skills.preview({ source: p.source, ...(p.ref ? { ref: p.ref } : {}) }),
  "skills.install": (p, ctx) => ({
    skills: ctx.skills.install({ stagingId: p.stagingId, ...(p.select ? { select: p.select } : {}) }),
  }),
  "skills.discard": (p, ctx) => {
    ctx.skills.discard(p.stagingId);
    return { ok: true as const };
  },
  "skills.setEnabled": (p, ctx) => ctx.skills.setEnabled(p.id, p.enabled, p.force === true),
  "skills.assign": (p, ctx) =>
    ctx.skills.assign(p.id, {
      scope: p.scope,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      agents: p.agents,
    }),
  "skills.remove": (p, ctx) => ctx.skills.remove(p.id),
  "skills.checkUpdates": async (_p, ctx) => ({ updates: await ctx.skills.checkUpdates() }),
  "skills.update": (p, ctx) => ctx.skills.update(p.id),
  "skills.rollback": (p, ctx) => ctx.skills.rollback(p.id),
  "skills.draft": (p, ctx) => ctx.skills.draft(p.workflow),
  "skills.create": (p, ctx) => ctx.skills.create(p),
  "mcp.list": (_p, ctx) => ({ servers: ctx.mcp.list() }),
  "mcp.add": (p, ctx) =>
    ctx.mcp.add({
      name: p.name,
      transport: p.transport,
      ...(p.command ? { command: p.command } : {}),
      ...(p.args ? { args: p.args } : {}),
      ...(p.env ? { env: p.env } : {}),
      ...(p.url ? { url: p.url } : {}),
    }),
  "mcp.test": (p, ctx) => ctx.mcp.test(p.id),
  "mcp.setEnabled": (p, ctx) => ctx.mcp.setEnabled(p.id, p.enabled, p.force === true),
  "mcp.setAutoApprove": (p, ctx) => ctx.mcp.setAutoApprove(p.id, p.autoApprove),
  "mcp.remove": (p, ctx) => ctx.mcp.remove(p.id),
  "knowledge.list": (_p, ctx) => ({ packs: ctx.knowledge.list() }),
  "knowledge.catalog": (_p, ctx) => ({ entries: ctx.knowledge.catalog() }),
  "knowledge.import": (p, ctx) =>
    ctx.knowledge.importPath({
      name: p.name,
      path: p.path,
      ...(p.version ? { version: p.version } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
    }),
  "knowledge.install": (p, ctx) => ctx.knowledge.installFromCatalog(p.id),
  "knowledge.setEnabled": (p, ctx) => ctx.knowledge.setEnabled(p.id, p.enabled),
  "knowledge.remove": (p, ctx) => ctx.knowledge.remove(p.id),
  "knowledge.search": (p, ctx) => ({
    hits: ctx.knowledge.search(p.query, {
      ...(p.limit ? { limit: p.limit } : {}),
      ...(p.pack ? { pack: p.pack } : {}),
    }),
  }),
  "osv.status": (_p, ctx) => ({ status: ctx.osv.status() }),
  "osv.import": (p, ctx) =>
    ctx.osv.import({
      ecosystem: p.ecosystem,
      ...(p.zipPath ? { zipPath: p.zipPath } : {}),
      ...(p.packages ? { packages: p.packages } : {}),
    }),
  "blackboard.list": (p, ctx) => ({ entries: ctx.tasks.blackboard.list(p.projectId) }),
  "diagrams.list": async (p, ctx) => ({ diagrams: await ctx.design.listDiagrams(p.projectId, p.taskId) }),
  "diagrams.save": (p, ctx) => ctx.design.saveDiagram(p.projectId, p.path, p.content),
  "decks.list": async (p, ctx) => ({ decks: await ctx.design.listDecks(p.projectId, p.taskId) }),
  "decks.html": async (p, ctx) => ({ html: await ctx.design.deckHtml(p.projectId, p.taskId, p.dir) }),
  "decks.export": (p, ctx) => ctx.design.exportDeck(p.projectId, p.taskId, p.dir, p.format, p.destDir),
  "design.fonts": () => ({ fonts: FONT_LIBRARY }),
  "scores.get": (p, ctx) => {
    const read = (section: string) => {
      const e = ctx.tasks.blackboard.read(p.projectId, section);
      if (!e) return null;
      try {
        const j = JSON.parse(e.content) as {
          overall: number;
          grade: string;
          blocksRelease: boolean;
          at: string;
        };
        return { overall: j.overall, grade: j.grade, blocksRelease: j.blocksRelease === true, at: j.at };
      } catch {
        return null;
      }
    };
    return { ux: read("scores/ux.json"), security: read("scores/security.json") };
  },
  "security.status": (_p, ctx) => ({
    scanners: ctx.security.scanners().map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      purpose: s.purpose,
      install: s.install,
      installed: s.installed,
    })),
    runtimes: ctx.security
      .runtimes()
      .map((r) => ({ id: r.id, name: r.name, install: r.install, installed: r.installed })),
  }),
  "security.scan": async (p, ctx) => {
    const project = await ctx.projects.get(p.projectId);
    return ctx.security.scan(project.rootPath, { projectId: p.projectId });
  },
  "security.last": (p, ctx) => ({ report: ctx.security.lastReport(p.projectId) }),
  "tasks.cancel": (p, ctx) => ({ cancelled: ctx.tasks.cancel(p.id) }),
  "checkpoints.list": (p, ctx) => ({ checkpoints: ctx.projects.listCheckpoints(p.projectId) }),
  "checkpoints.restore": (p, ctx) => ctx.projects.restoreCheckpoint(p.id, p.force),
  "logs.query": (p, ctx) => needLogs(ctx).query(p),
  "logs.tail": (p, ctx) => needLogs(ctx).tail(p.cursor, p),
  "logs.components": async (_p, ctx) => ({ components: await needLogs(ctx).components() }),
  "logs.info": (_p, ctx) => needLogs(ctx).info(),
  "logs.export": (p, ctx) =>
    needLogs(ctx).export(
      {
        systemInfo: () => systemInfo(ctx),
        hardware: () => ctx.models.hardware(),
        settings: () => ctx.settings.all(),
        events: () => ctx.bus.recent({ limit: 1000 }),
        // A runtime that is not running must not hold up the export.
        models: () =>
          Promise.race([
            ctx.models.installed(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), 8000).unref()),
          ]),
        scheduler: () => schedulerStatus(ctx),
      },
      p.destDir,
    ),
  "logs.openFolder": (_p, ctx) => needLogs(ctx).openFolder(),
  "models.stats": (p, ctx) => ({
    calls: needLogs(ctx).stats.recent(p.limit),
    models: needLogs(ctx).stats.summary(),
  }),
  "qa.check": async (p, ctx) => ({
    check: await needQa(ctx).check({
      projectId: p.projectId,
      taskId: p.taskId ?? null,
      url: p.url,
      widths: p.widths,
      expectText: p.expectText,
      by: "user",
    }),
  }),
  "qa.get": (p, ctx) => ({ check: needQa(ctx).get(p.projectId, p.taskId ?? null, p.id) }),
  "qa.list": (p, ctx) => ({ checks: needQa(ctx).list(p.projectId, p.taskId ?? null, p.limit ?? 10) }),
  "qa.screenshot": (p, ctx) => needQa(ctx).screenshot(p.projectId, p.taskId ?? null, p.path),
  "preview.pin": (p, ctx) => ({ preview: ctx.previews.setPinned(p.id, p.pinned) }),
};

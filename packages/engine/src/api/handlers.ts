import {
  API_FINGERPRINT,
  type ApiMethod,
  type ApiParsedParams,
  type ApiResult,
  DEPO_VERSION,
} from "@depo/shared";
import type { TaskManager } from "../agent/tasks";
import { MANIFESTS } from "../agents/manifests";
import type { ApprovalCenter } from "../approvals";
import type { CodeIndexer } from "../codeindex/indexer";
import type { EventBus } from "../events/bus";
import type { MemoryStore } from "../memory/store";
import type { ModelManager } from "../models/manager";
import type { ProjectRegistry } from "../projects/registry";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { SettingsRepo } from "../settings";
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

function removeProject(id: string, ctx: HandlerContext) {
  ctx.registry.delete(id);
  ctx.indexer.forget(id);
  ctx.scheduler.refresh();
  return { ok: true as const };
}

export type Handlers = {
  [M in ApiMethod]: (params: ApiParsedParams<M>, ctx: HandlerContext) => ApiResult<M> | Promise<ApiResult<M>>;
};

/** Engine API implementation. Pure functions of (params, context): no UI, no transport. */
export const handlers: Handlers = {
  "system.ping": () => ({ pong: true, serverTime: new Date().toISOString() }),

  "system.info": (_params, ctx) => ({
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
  }),

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
  "approvals.respond": (p, ctx) => ({ ok: ctx.approvals.respond(p.id, p.approve) }),

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
  "changes.discard": (p, ctx) => ctx.projects.discardChangeSet(p.id),
  "tasks.list": (p, ctx) => ({ tasks: ctx.tasks.list(p.projectId) }),
  "tasks.active": (_p, ctx) => ({ tasks: ctx.tasks.active() }),
  "tasks.get": (p, ctx) => ctx.tasks.get(p.id),
  "tasks.send": (p, ctx) => ctx.tasks.send(p.projectId, p.text, p.taskId, p.mode),
  "agents.list": () => ({ agents: MANIFESTS }),
  "team.get": (p, ctx) => ctx.tasks.teamState(p.taskId),
  "blackboard.list": (p, ctx) => ({ entries: ctx.tasks.blackboard.list(p.projectId) }),
  "tasks.cancel": (p, ctx) => ({ cancelled: ctx.tasks.cancel(p.id) }),
  "checkpoints.list": (p, ctx) => ({ checkpoints: ctx.projects.listCheckpoints(p.projectId) }),
  "checkpoints.restore": (p, ctx) => ctx.projects.restoreCheckpoint(p.id, p.force),
};

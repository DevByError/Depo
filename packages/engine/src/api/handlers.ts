import {
  API_FINGERPRINT,
  type ApiMethod,
  type ApiParsedParams,
  type ApiResult,
  DEPO_VERSION,
} from "@depo/shared";
import type { TaskManager } from "../agent/tasks";
import type { ApprovalCenter } from "../approvals";
import type { EventBus } from "../events/bus";
import type { ModelManager } from "../models/manager";
import type { SettingsRepo } from "../settings";
import type { ProjectService } from "../workspace/service";

export interface HandlerContext {
  bus: EventBus;
  settings: SettingsRepo;
  models: ModelManager;
  approvals: ApprovalCenter;
  projects: ProjectService;
  tasks: TaskManager;
  info: {
    startedAt: Date;
    dataDir: string;
    dbPath: string;
    schemaVersion: number;
  };
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

  "projects.list": async (_p, ctx) => ({ projects: await ctx.projects.list() }),
  "projects.open": (p, ctx) => ctx.projects.open(p.path),
  "projects.forget": (p, ctx) => {
    ctx.projects.forget(p.id);
    return { ok: true as const };
  },
  "files.list": (p, ctx) => ({ entries: ctx.projects.listFiles(p.projectId, p.path) }),
  "files.read": (p, ctx) => ctx.projects.readFile(p.projectId, p.path),
  "changes.list": (p, ctx) => ({ changeSets: ctx.projects.listChangeSets(p.projectId) }),
  "changes.get": (p, ctx) => ctx.projects.getChangeSet(p.id),
  "changes.apply": (p, ctx) => ctx.projects.applyChangeSet(p.id, ctx.projects.workspaceFor(p.id), p.files),
  "changes.discard": (p, ctx) => ctx.projects.discardChangeSet(p.id),
  "tasks.list": (p, ctx) => ({ tasks: ctx.tasks.list(p.projectId) }),
  "tasks.get": (p, ctx) => ctx.tasks.get(p.id),
  "tasks.send": (p, ctx) => ctx.tasks.send(p.projectId, p.text, p.taskId),
  "tasks.cancel": (p, ctx) => ({ cancelled: ctx.tasks.cancel(p.id) }),
  "checkpoints.list": (p, ctx) => ({ checkpoints: ctx.projects.listCheckpoints(p.projectId) }),
  "checkpoints.restore": (p, ctx) => ctx.projects.restoreCheckpoint(p.id, p.force),
};

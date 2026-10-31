import { type ApiMethod, type ApiParsedParams, type ApiResult, DEPO_VERSION } from "@depo/shared";
import type { EventBus } from "../events/bus";
import type { SettingsRepo } from "../settings";

export interface HandlerContext {
  bus: EventBus;
  settings: SettingsRepo;
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
};

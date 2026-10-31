import { z } from "zod";
import { DepoEventSchema, EventTypeSchema, JsonValueSchema } from "./events";

/** JSON-RPC 2.0 envelopes used on the UI <-> engine WebSocket. */
export const RpcIdSchema = z.union([z.string(), z.number().int()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcIdSchema.nullable(), error: RpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Server -> client push messages (no id). */
export const RpcNotificationSchema = z.discriminatedUnion("method", [
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("event"), params: DepoEventSchema }),
]);
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application errors start at -32000. */
  NotFound: -32004,
} as const;

/** Setting keys are dotted lowercase identifiers, e.g. `ui.theme`. */
export const SettingKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
  .max(128);

/**
 * The engine's public API. Every method has a Zod schema for params and result.
 * The engine validates params; the client validates results. Add methods here first.
 */
export const ApiSchema = {
  "system.ping": {
    params: z.object({}).strict(),
    result: z.object({ pong: z.literal(true), serverTime: z.string() }),
  },
  "system.info": {
    params: z.object({}).strict(),
    result: z.object({
      engineVersion: z.string(),
      runtime: z.string(),
      platform: z.string(),
      arch: z.string(),
      pid: z.number().int(),
      startedAt: z.string(),
      dataDir: z.string(),
      dbPath: z.string(),
      schemaVersion: z.number().int(),
    }),
  },
  "events.recent": {
    params: z
      .object({
        limit: z.number().int().min(1).max(1000).default(200),
        projectId: z.string().nullable().optional(),
        types: z.array(EventTypeSchema).optional(),
        query: z.string().max(200).optional(),
      })
      .strict(),
    result: z.object({ events: z.array(DepoEventSchema) }),
  },
  "events.emit": {
    // Lets the UI record user-facing actions (e.g. "info") in the audit log.
    params: z
      .object({
        type: z.enum(["info", "warning"]),
        text: z.string().min(1).max(2000),
        details: z.record(z.string(), JsonValueSchema).optional(),
      })
      .strict(),
    result: DepoEventSchema,
  },
  "settings.get": {
    params: z.object({ key: SettingKeySchema }).strict(),
    result: z.object({ key: z.string(), value: JsonValueSchema.nullable() }),
  },
  "settings.set": {
    params: z.object({ key: SettingKeySchema, value: JsonValueSchema }).strict(),
    result: z.object({ key: z.string(), value: JsonValueSchema }),
  },
  "settings.all": {
    params: z.object({}).strict(),
    result: z.object({ settings: z.record(z.string(), JsonValueSchema) }),
  },
} as const;

export type ApiMethod = keyof typeof ApiSchema;
export type ApiParams<M extends ApiMethod> = z.input<(typeof ApiSchema)[M]["params"]>;
export type ApiParsedParams<M extends ApiMethod> = z.output<(typeof ApiSchema)[M]["params"]>;
export type ApiResult<M extends ApiMethod> = z.output<(typeof ApiSchema)[M]["result"]>;

export function isApiMethod(method: string): method is ApiMethod {
  return Object.hasOwn(ApiSchema, method);
}

/** Line the engine prints on stdout once its server is listening. Tauri parses it. */
export const ENGINE_READY_PREFIX = "DEPO_ENGINE_READY ";
export const EngineReadySchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  version: z.string(),
});
export type EngineReady = z.infer<typeof EngineReadySchema>;

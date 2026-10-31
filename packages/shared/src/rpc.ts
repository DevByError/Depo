import {
  AutoFitPlanSchema,
  BenchmarkSchema,
  HardwareProfileSchema,
  ModelCatalogSchema,
  QualityModeSchema,
  RoleSchema,
} from "@depo/model-gateway";
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

/** A local model runtime Depo talks to (Ollama, llama.cpp server, LM Studio). */
export const ProviderConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: z.enum(["ollama", "llamacpp", "lmstudio"]),
  baseUrl: z.string().url().max(200),
  enabled: z.boolean(),
});
export type ProviderConfigDto = z.infer<typeof ProviderConfigSchema>;

export const ProviderStatusSchema = ProviderConfigSchema.extend({
  ok: z.boolean(),
  version: z.string().nullable(),
  message: z.string().nullable(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const InstalledModelSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  sizeBytes: z.number().nullable(),
  family: z.string().nullable(),
  parameterSize: z.string().nullable(),
  quantization: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  /** Matching catalog entry, when the tag is one the catalog knows. */
  catalogId: z.string().nullable(),
});
export type InstalledModel = z.infer<typeof InstalledModelSchema>;

export const ModelRefSchema = z.object({ providerId: z.string(), model: z.string().min(1).max(200) });
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const AssignmentsSchema = z.partialRecord(RoleSchema, ModelRefSchema);
export type Assignments = z.infer<typeof AssignmentsSchema>;

export const PullJobSchema = z.object({
  jobId: z.string(),
  providerId: z.string(),
  model: z.string(),
  status: z.string(),
  completedBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  error: z.string().nullable(),
});
export type PullJob = z.infer<typeof PullJobSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  lastOpenedAt: z.string(),
  createdAt: z.string(),
  isGit: z.boolean(),
  branch: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const HunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Unified diff lines, each starting with " ", "+", "-" or "\\". */
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "modified", "deleted"]),
  binary: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  hunks: z.array(HunkSchema),
  /** Hash of the project file when the workspace was created (null = did not exist). */
  baseHash: z.string().nullable(),
  /** The project file changed since the workspace was made: applying needs care. */
  conflict: z.boolean(),
  status: z.enum(["pending", "applied", "partially_applied", "skipped"]),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const ChangeSetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable(),
  status: z.enum(["pending", "applied", "partially_applied", "discarded", "superseded", "reverted"]),
  title: z.string(),
  files: z.array(FileChangeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  changeSetId: z.string().nullable(),
  label: z.string(),
  status: z.enum(["active", "restored"]),
  files: z.array(z.object({ path: z.string(), existed: z.boolean(), appliedHash: z.string().nullable() })),
  createdAt: z.string(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  prompt: z.string(),
  status: TaskStatusSchema,
  model: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

/** A chat transcript entry, flattened for display. */
export const ChatItemSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  toolName: z.string().nullable(),
  isError: z.boolean(),
  createdAt: z.string(),
});
export type ChatItem = z.infer<typeof ChatItemSchema>;

const TaskMethods = {
  "tasks.list": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ tasks: z.array(TaskSchema) }),
  },
  "tasks.get": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ task: TaskSchema, messages: z.array(ChatItemSchema) }),
  },
  "tasks.send": {
    params: z
      .object({ projectId: z.string(), text: z.string().min(1).max(20_000), taskId: z.string().optional() })
      .strict(),
    result: TaskSchema,
  },
  "tasks.cancel": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ cancelled: z.boolean() }),
  },
} as const;

const ProjectMethods = {
  "projects.list": {
    params: z.object({}).strict(),
    result: z.object({ projects: z.array(ProjectSchema) }),
  },
  "projects.open": {
    params: z.object({ path: z.string().min(1).max(1000) }).strict(),
    result: ProjectSchema,
  },
  "projects.forget": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "files.list": {
    params: z.object({ projectId: z.string(), path: z.string().max(1000).default(".") }).strict(),
    result: z.object({
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          type: z.enum(["file", "dir"]),
          size: z.number().nullable(),
        }),
      ),
    }),
  },
  "files.read": {
    params: z.object({ projectId: z.string(), path: z.string().min(1).max(1000) }).strict(),
    result: z.object({
      path: z.string(),
      text: z.string().nullable(),
      binary: z.boolean(),
      size: z.number(),
      truncated: z.boolean(),
    }),
  },
  "changes.list": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ changeSets: z.array(ChangeSetSchema) }),
  },
  "changes.get": {
    params: z.object({ id: z.string() }).strict(),
    result: ChangeSetSchema,
  },
  "changes.apply": {
    params: z
      .object({
        id: z.string(),
        /** Files to apply; omitted = all pending files. `hunks` = indexes to apply (omitted = whole file). */
        files: z
          .array(z.object({ path: z.string(), hunks: z.array(z.number().int().min(0)).optional() }))
          .optional(),
      })
      .strict(),
    result: z.object({
      changeSet: ChangeSetSchema,
      checkpointId: z.string().nullable(),
      applied: z.array(z.string()),
      conflicts: z.array(z.string()),
    }),
  },
  "changes.discard": {
    params: z.object({ id: z.string() }).strict(),
    result: ChangeSetSchema,
  },
  "checkpoints.list": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ checkpoints: z.array(CheckpointSchema) }),
  },
  "checkpoints.restore": {
    params: z.object({ id: z.string(), force: z.boolean().default(false) }).strict(),
    result: z.object({
      restored: z.array(z.string()),
      conflicts: z.array(z.string()),
      checkpoint: CheckpointSchema,
    }),
  },
} as const;

export const PendingApprovalSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  agent: z.string(),
  kind: z.enum(["command", "apply", "other"]),
  title: z.string(),
  reason: z.string(),
  details: z.record(z.string(), JsonValueSchema).optional(),
});
export type PendingApprovalDto = z.infer<typeof PendingApprovalSchema>;

const ApprovalMethods = {
  "approvals.list": {
    params: z.object({}).strict(),
    result: z.object({ approvals: z.array(PendingApprovalSchema) }),
  },
  "approvals.respond": {
    params: z.object({ id: z.string(), approve: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean() }),
  },
} as const;

const ModelMethods = {
  "hardware.get": {
    params: z.object({}).strict(),
    result: z.object({ profile: HardwareProfileSchema.nullable() }),
  },
  "hardware.profile": {
    params: z.object({}).strict(),
    result: z.object({ profile: HardwareProfileSchema }),
  },
  "models.providers": {
    params: z.object({}).strict(),
    result: z.object({ providers: z.array(ProviderStatusSchema) }),
  },
  "models.providers.set": {
    params: z.object({ providers: z.array(ProviderConfigSchema).min(1).max(16) }).strict(),
    result: z.object({ providers: z.array(ProviderConfigSchema) }),
  },
  "models.installed": {
    params: z.object({}).strict(),
    result: z.object({ models: z.array(InstalledModelSchema) }),
  },
  "models.catalog": {
    params: z.object({}).strict(),
    result: z.object({ catalog: ModelCatalogSchema, custom: z.boolean() }),
  },
  "models.catalog.import": {
    // A replacement catalog, as JSON text (from a file the user picked) or `null` to restore the default.
    params: z.object({ json: z.string().max(2_000_000).nullable() }).strict(),
    result: z.object({ catalog: ModelCatalogSchema, custom: z.boolean() }),
  },
  "models.plan": {
    params: z.object({ mode: QualityModeSchema.optional() }).strict(),
    result: z.object({ plan: AutoFitPlanSchema.nullable() }),
  },
  "models.assignments": {
    params: z.object({}).strict(),
    result: z.object({ assignments: AssignmentsSchema, effective: AssignmentsSchema }),
  },
  "models.assign": {
    params: z.object({ role: RoleSchema, ref: ModelRefSchema.nullable() }).strict(),
    result: z.object({ assignments: AssignmentsSchema, effective: AssignmentsSchema }),
  },
  "models.pull": {
    params: ModelRefSchema.strict(),
    result: PullJobSchema,
  },
  "models.pull.cancel": {
    params: z.object({ jobId: z.string() }).strict(),
    result: z.object({ cancelled: z.boolean() }),
  },
  "models.pulls": {
    params: z.object({}).strict(),
    result: z.object({ jobs: z.array(PullJobSchema) }),
  },
  "models.delete": {
    params: ModelRefSchema.strict(),
    result: z.object({ deleted: z.literal(true) }),
  },
  "models.benchmark": {
    params: ModelRefSchema.strict(),
    result: z.object({ benchmark: BenchmarkSchema }),
  },
} as const;

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
  ...ModelMethods,
  ...ApprovalMethods,
  ...ProjectMethods,
  ...TaskMethods,
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

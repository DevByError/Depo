import {
  AutoFitPlanSchema,
  BenchmarkSchema,
  HardwareProfileSchema,
  ModelCatalogSchema,
  QualityModeSchema,
  RoleSchema,
} from "@depo/model-gateway/contracts";
import { z } from "zod";
import {
  AgentIdSchema,
  AgentManifestSchema,
  AgentMessageSchema,
  AgentStatusSchema,
  BlackboardEntrySchema,
  EvalCaseSchema,
  EvalRunSchema,
  EvalSuiteSchema,
  LabAgentSchema,
  LabVersionSchema,
  ManifestPatchSchema,
  PlanSchema,
  WorkModeSchema,
} from "./agents";
import { DepoEventSchema, EventTypeSchema, JsonValueSchema } from "./events";
import {
  KnowledgeCatalogEntrySchema,
  KnowledgeHitSchema,
  KnowledgePackSchema,
  McpServerSchema,
  OsvStatusSchema,
  ScoreSchema,
  SecurityReportSchema,
  SkillCandidateSchema,
  SkillSchema,
} from "./extensions";
import { LogMethods } from "./logs";
import { PreviewMethods } from "./preview";

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
  description: z.string(),
  /** Stack preferences in the user's words; "" lets the agents decide. */
  stack: z.string(),
  origin: z.enum(["opened", "created", "imported", "duplicated"]),
  archivedAt: z.string().nullable(),
  /** False when the folder was moved or deleted outside Depo. */
  exists: z.boolean(),
});
export type Project = z.infer<typeof ProjectSchema>;

const CommandPatternSchema = z.string().min(1).max(200);
export const ProjectSettingsSchema = z.object({
  /** Keep a code index (symbols + embeddings) for this project. */
  indexEnabled: z.boolean().default(true),
  /** How many of this project's tasks may run at the same time. */
  maxParallel: z.number().int().min(1).max(8).default(1),
  /** Paused projects keep their queue but start no new model work. */
  paused: z.boolean().default(false),
  /** Extra commands to run without asking (a command prefix such as "npm run lint"). Never overrides a deny. */
  commandAllow: z.array(CommandPatternSchema).max(50).default([]),
  /** Extra commands to refuse (prefix match). */
  commandDeny: z.array(CommandPatternSchema).max(50).default([]),
  /** Most model steps a task may take before it stops and hands over. */
  maxSteps: z.number().int().min(5).max(200).default(40),
  /** The owner's own start command for previews ("" = let Depo detect it). `{port}` is the chosen port. */
  previewCommand: z.string().max(2000).default(""),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const MemoryKindSchema = z.enum(["fact", "preference", "decision", "lesson"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export const MemoryFactSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  kind: MemoryKindSchema,
  text: z.string(),
  signature: z.string().nullable(),
  source: z.enum(["user", "agent", "system"]),
  uses: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const IndexStatusSchema = z.object({
  projectId: z.string(),
  state: z.enum(["idle", "indexing", "disabled", "error"]),
  files: z.number().int(),
  symbols: z.number().int(),
  chunks: z.number().int(),
  /** Model used for embeddings, or null when no embedding model is available (symbols only). */
  embeddingModel: z.string().nullable(),
  progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  lastIndexedAt: z.string().nullable(),
  watching: z.boolean(),
  error: z.string().nullable(),
});
export type IndexStatus = z.infer<typeof IndexStatusSchema>;

export const SearchHitSchema = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  score: z.number(),
  kind: z.enum(["symbol", "semantic", "text"]),
  title: z.string(),
  preview: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SchedulerPrioritySchema = z.enum(["chat", "task", "background"]);
export type SchedulerPriority = z.infer<typeof SchedulerPrioritySchema>;
export const SchedulerJobSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  model: z.string(),
  priority: SchedulerPrioritySchema,
  label: z.string(),
  since: z.string(),
});
export type SchedulerJob = z.infer<typeof SchedulerJobSchema>;
export const SchedulerStatusSchema = z.object({
  maxParallel: z.number().int(),
  pausedAll: z.boolean(),
  pausedProjects: z.array(z.string()),
  running: z.array(SchedulerJobSchema),
  queued: z.array(SchedulerJobSchema),
  /** Model most recently used, kept warm to avoid reloading. */
  residentModel: z.string().nullable(),
});
export type SchedulerStatus = z.infer<typeof SchedulerStatusSchema>;

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
  mode: WorkModeSchema.default("single"),
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
  /** `backend@1.0.0` when the message comes from a team agent. */
  agent: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * Tool items only: the arguments the agent passed to the tool (long strings clipped), so the chat
   * can say "Ran python -m pytest -q" or show an edit as a diff. Untrusted data: display it as text.
   */
  args: z.record(z.string(), JsonValueSchema).optional(),
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
      .object({
        projectId: z.string(),
        text: z.string().min(1).max(20_000),
        taskId: z.string().optional(),
        /** How to work: "single" (one coding agent, the default) or a team mode. */
        mode: WorkModeSchema.optional(),
      })
      .strict(),
    result: TaskSchema,
  },
  "tasks.active": {
    params: z.object({}).strict(),
    result: z.object({ tasks: z.array(TaskSchema) }),
  },
  "tasks.cancel": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ cancelled: z.boolean() }),
  },
  "agents.list": {
    params: z.object({}).strict(),
    result: z.object({ agents: z.array(AgentManifestSchema) }),
  },
  "lab.agents": {
    params: z.object({}).strict(),
    result: z.object({ agents: z.array(LabAgentSchema) }),
  },
  "lab.versions": {
    params: z.object({ agentId: AgentIdSchema }).strict(),
    result: z.object({
      versions: z.array(LabVersionSchema),
      history: z.array(z.object({ at: z.string(), version: z.string(), reason: z.string() })),
    }),
  },
  "lab.createVersion": {
    params: z
      .object({ agentId: AgentIdSchema, patch: ManifestPatchSchema, note: z.string().max(500) })
      .strict(),
    result: LabVersionSchema,
  },
  "lab.deleteVersion": {
    params: z.object({ agentId: AgentIdSchema, versionId: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "lab.promote": {
    params: z
      .object({ agentId: AgentIdSchema, versionId: z.string().nullable(), force: z.boolean().optional() })
      .strict(),
    result: z.object({ versions: z.array(LabVersionSchema) }),
  },
  "lab.rollback": {
    params: z.object({ agentId: AgentIdSchema }).strict(),
    result: z.object({ versions: z.array(LabVersionSchema) }),
  },
  "lab.suites": {
    params: z.object({ agentId: AgentIdSchema }).strict(),
    result: z.object({ suites: z.array(EvalSuiteSchema) }),
  },
  "lab.saveSuite": {
    params: z
      .object({
        agentId: AgentIdSchema,
        name: z.string().min(1).max(80),
        cases: z.array(EvalCaseSchema).min(1).max(50),
      })
      .strict(),
    result: EvalSuiteSchema,
  },
  "lab.deleteSuite": {
    params: z.object({ agentId: AgentIdSchema, suiteId: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "lab.runEval": {
    params: z
      .object({ agentId: AgentIdSchema, versionId: z.string().nullable(), suiteId: z.string() })
      .strict(),
    result: EvalRunSchema,
  },
  "lab.runs": {
    params: z.object({ agentId: AgentIdSchema }).strict(),
    result: z.object({ runs: z.array(EvalRunSchema) }),
  },
  "lab.compare": {
    params: z
      .object({
        agentId: AgentIdSchema,
        a: z.string().nullable(),
        b: z.string().nullable(),
        suiteId: z.string(),
      })
      .strict(),
    result: z.object({
      a: EvalRunSchema,
      b: EvalRunSchema,
      winner: z.enum(["a", "b", "tie"]),
      cases: z.array(z.object({ caseId: z.string(), a: z.boolean(), b: z.boolean() })),
    }),
  },
  "lab.playground": {
    params: z
      .object({
        agentId: AgentIdSchema,
        versionId: z.string().nullable(),
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
          .min(1)
          .max(20),
      })
      .strict(),
    result: z.object({ reply: z.string(), model: z.string() }),
  },
  "lab.export": {
    params: z.object({ agentId: AgentIdSchema, versionId: z.string().nullable() }).strict(),
    result: z.object({ json: z.string() }),
  },
  "lab.import": {
    params: z.object({ json: z.string().min(2).max(300_000) }).strict(),
    result: LabVersionSchema,
  },
  "blocks.list": {
    params: z.object({}).strict(),
    result: z.object({
      blocks: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          stack: z.enum(["ts", "py", "react", "docker"]),
          tags: z.array(z.string()),
          files: z.array(z.string()),
          test: z.string(),
          notes: z.array(z.string()),
        }),
      ),
    }),
  },
  "app.checkUpdate": {
    params: z.object({}).strict(),
    result: z.object({
      status: z.enum(["unconfigured", "up_to_date", "available", "error"]),
      current: z.string(),
      latest: z.string().nullable(),
      url: z.string().nullable(),
      notes: z.string(),
      message: z.string(),
    }),
  },
  "team.get": {
    params: z.object({ taskId: z.string() }).strict(),
    result: z.object({
      mode: WorkModeSchema,
      plan: PlanSchema.nullable(),
      agents: z.array(AgentStatusSchema),
      messages: z.array(AgentMessageSchema),
    }),
  },
  "diagrams.list": {
    params: z.object({ projectId: z.string(), taskId: z.string().optional() }).strict(),
    result: z.object({
      diagrams: z.array(
        z.object({ path: z.string(), content: z.string(), source: z.enum(["project", "workspace"]) }),
      ),
    }),
  },
  "diagrams.save": {
    params: z
      .object({ projectId: z.string(), path: z.string().max(200), content: z.string().max(80_000) })
      .strict(),
    result: z.object({ path: z.string() }),
  },
  "decks.list": {
    params: z.object({ projectId: z.string(), taskId: z.string().optional() }).strict(),
    result: z.object({
      decks: z.array(
        z.object({
          dir: z.string(),
          title: z.string(),
          kind: z.enum(["pitch", "progress"]),
          slides: z.number().int(),
          files: z.array(z.string()),
          source: z.enum(["project", "workspace"]),
        }),
      ),
    }),
  },
  "decks.html": {
    params: z.object({ projectId: z.string(), taskId: z.string().optional(), dir: z.string() }).strict(),
    result: z.object({ html: z.string() }),
  },
  "decks.export": {
    params: z
      .object({
        projectId: z.string(),
        taskId: z.string().optional(),
        dir: z.string(),
        format: z.enum(["pptx", "pdf", "html"]),
        destDir: z.string().optional(),
      })
      .strict(),
    result: z.object({ path: z.string(), bytes: z.number().int() }),
  },
  "design.fonts": {
    params: z.object({}).strict(),
    result: z.object({
      fonts: z.array(
        z.object({
          family: z.string(),
          category: z.string(),
          license: z.string(),
          fontsource: z.string(),
          weights: z.array(z.number()),
          scripts: z.array(z.string()),
          tags: z.array(z.string()),
        }),
      ),
    }),
  },
  "scores.get": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({
      ux: ScoreSchema.nullable(),
      security: ScoreSchema.nullable(),
    }),
  },
  "security.status": {
    params: z.object({}).strict(),
    result: z.object({
      scanners: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          purpose: z.string(),
          install: z.string(),
          installed: z.boolean(),
        }),
      ),
      runtimes: z.array(
        z.object({ id: z.string(), name: z.string(), install: z.string(), installed: z.boolean() }),
      ),
    }),
  },
  "security.scan": {
    params: z.object({ projectId: z.string() }).strict(),
    result: SecurityReportSchema,
  },
  "security.last": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ report: SecurityReportSchema.nullable() }),
  },
  "skills.list": {
    params: z.object({}).strict(),
    result: z.object({ skills: z.array(SkillSchema) }),
  },
  "skills.get": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ skill: SkillSchema, body: z.string() }),
  },
  "skills.preview": {
    params: z.object({ source: z.string().min(1).max(1000), ref: z.string().max(200).optional() }).strict(),
    result: z.object({
      stagingId: z.string(),
      kind: z.string(),
      commit: z.string().nullable(),
      candidates: z.array(SkillCandidateSchema),
    }),
  },
  "skills.install": {
    params: z.object({ stagingId: z.string(), select: z.array(z.string()).max(100).optional() }).strict(),
    result: z.object({ skills: z.array(SkillSchema) }),
  },
  "skills.discard": {
    params: z.object({ stagingId: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "skills.setEnabled": {
    params: z.object({ id: z.string(), enabled: z.boolean(), force: z.boolean().optional() }).strict(),
    result: SkillSchema,
  },
  "skills.assign": {
    params: z
      .object({
        id: z.string(),
        scope: z.enum(["global", "project"]),
        projectId: z.string().optional(),
        agents: z.array(z.string().max(60)).max(30),
      })
      .strict(),
    result: SkillSchema,
  },
  "skills.remove": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "skills.checkUpdates": {
    params: z.object({}).strict(),
    result: z.object({
      updates: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          current: z.string().nullable(),
          latest: z.string().nullable(),
          available: z.boolean(),
        }),
      ),
    }),
  },
  "skills.update": {
    params: z.object({ id: z.string() }).strict(),
    result: SkillSchema,
  },
  "skills.rollback": {
    params: z.object({ id: z.string() }).strict(),
    result: SkillSchema,
  },
  "skills.draft": {
    params: z.object({ workflow: z.string().min(3).max(4000) }).strict(),
    result: z.object({ name: z.string(), description: z.string(), instructions: z.string() }),
  },
  "skills.create": {
    params: z
      .object({
        name: z.string().max(64),
        description: z.string().min(1).max(1024),
        instructions: z.string().min(1).max(60_000),
      })
      .strict(),
    result: SkillSchema,
  },
  "mcp.list": {
    params: z.object({}).strict(),
    result: z.object({ servers: z.array(McpServerSchema) }),
  },
  "mcp.add": {
    params: z
      .object({
        name: z.string().max(40),
        transport: z.enum(["stdio", "http"]),
        command: z.string().max(500).optional(),
        args: z.array(z.string().max(500)).max(40).optional(),
        env: z.record(z.string().max(100), z.string().max(2000)).optional(),
        url: z.string().max(500).optional(),
      })
      .strict(),
    result: McpServerSchema,
  },
  "mcp.test": {
    params: z.object({ id: z.string() }).strict(),
    result: McpServerSchema,
  },
  "mcp.setEnabled": {
    params: z.object({ id: z.string(), enabled: z.boolean(), force: z.boolean().optional() }).strict(),
    result: McpServerSchema,
  },
  "mcp.setAutoApprove": {
    params: z.object({ id: z.string(), autoApprove: z.boolean() }).strict(),
    result: McpServerSchema,
  },
  "mcp.remove": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "knowledge.list": {
    params: z.object({}).strict(),
    result: z.object({ packs: z.array(KnowledgePackSchema) }),
  },
  "knowledge.catalog": {
    params: z.object({}).strict(),
    result: z.object({ entries: z.array(KnowledgeCatalogEntrySchema) }),
  },
  "knowledge.import": {
    params: z
      .object({
        name: z.string().min(1).max(80),
        path: z.string().min(1).max(1000),
        version: z.string().max(40).optional(),
        description: z.string().max(500).optional(),
        kind: z.enum(["docs", "security", "ux", "custom"]).optional(),
      })
      .strict(),
    result: KnowledgePackSchema,
  },
  "knowledge.install": {
    params: z.object({ id: z.string() }).strict(),
    result: KnowledgePackSchema,
  },
  "knowledge.setEnabled": {
    params: z.object({ id: z.string(), enabled: z.boolean() }).strict(),
    result: KnowledgePackSchema,
  },
  "knowledge.remove": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "knowledge.search": {
    params: z
      .object({
        query: z.string().min(2).max(300),
        pack: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    result: z.object({ hits: z.array(KnowledgeHitSchema) }),
  },
  "osv.status": {
    params: z.object({}).strict(),
    result: z.object({ status: z.array(OsvStatusSchema) }),
  },
  "osv.import": {
    params: z
      .object({
        ecosystem: z.string().max(30),
        zipPath: z.string().max(1000).optional(),
        packages: z.array(z.string().max(200)).max(5000).optional(),
      })
      .strict(),
    result: OsvStatusSchema,
  },
  "blackboard.list": {
    params: z.object({ projectId: z.string() }).strict(),
    result: z.object({ entries: z.array(BlackboardEntrySchema) }),
  },
} as const;

const ProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in Windows file names
  .regex(/^[^<>:"/\\|?*\x00-\x1f]+$/, 'A project name cannot contain < > : " / \\ | ? *')
  .refine((n) => !/[. ]$/.test(n), "A project name cannot end with a dot or a space");

const ProjectMethods = {
  "projects.list": {
    params: z.object({ includeArchived: z.boolean().optional() }).strict(),
    result: z.object({ projects: z.array(ProjectSchema) }),
  },
  "projects.create": {
    params: z
      .object({
        name: ProjectNameSchema,
        parentDir: z.string().min(1).max(1000),
        description: z.string().max(2000).optional(),
        stack: z.string().max(500).optional(),
        initGit: z.boolean().optional(),
      })
      .strict(),
    result: ProjectSchema,
  },
  "projects.import": {
    params: z
      .object({
        /** A local folder, or a git URL (https://, ssh or git@host:path). */
        source: z.string().min(1).max(1000),
        /** Where a cloned repo goes; the folder name comes from the URL. Ignored for local folders. */
        parentDir: z.string().max(1000).optional(),
      })
      .strict(),
    result: ProjectSchema,
  },
  "projects.update": {
    params: z
      .object({
        id: z.string(),
        name: ProjectNameSchema.optional(),
        description: z.string().max(2000).optional(),
        stack: z.string().max(500).optional(),
        archived: z.boolean().optional(),
      })
      .strict(),
    result: ProjectSchema,
  },
  "projects.duplicate": {
    params: z.object({ id: z.string(), name: ProjectNameSchema.optional() }).strict(),
    result: ProjectSchema,
  },
  "projects.export": {
    params: z.object({ id: z.string(), destDir: z.string().max(1000).optional() }).strict(),
    result: z.object({ path: z.string(), bytes: z.number().int(), files: z.number().int() }),
  },
  "projects.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "projects.settings.get": {
    params: z.object({ id: z.string() }).strict(),
    result: ProjectSettingsSchema,
  },
  "projects.settings.set": {
    params: z.object({ id: z.string(), patch: ProjectSettingsSchema.partial() }).strict(),
    result: ProjectSettingsSchema,
  },
  "projects.overview": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({
      project: ProjectSchema,
      taskCounts: z.record(z.string(), z.number().int()),
      lastTestRun: z
        .object({ at: z.string(), passed: z.boolean(), text: z.string(), taskId: z.string().nullable() })
        .nullable(),
      recentChanges: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          files: z.number().int(),
          at: z.string(),
        }),
      ),
      index: IndexStatusSchema,
      memory: z.object({
        facts: z.number().int(),
        lessons: z.number().int(),
        markdownChars: z.number().int(),
      }),
    }),
  },
  "memory.get": {
    params: z.object({ projectId: z.string().nullable() }).strict(),
    result: z.object({ markdown: z.string(), facts: z.array(MemoryFactSchema) }),
  },
  "memory.setMarkdown": {
    params: z.object({ projectId: z.string().nullable(), markdown: z.string().max(100_000) }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "memory.addFact": {
    params: z
      .object({
        projectId: z.string().nullable(),
        kind: MemoryKindSchema,
        text: z.string().trim().min(1).max(2000),
      })
      .strict(),
    result: MemoryFactSchema,
  },
  "memory.updateFact": {
    params: z.object({ id: z.string(), text: z.string().trim().min(1).max(2000) }).strict(),
    result: MemoryFactSchema,
  },
  "memory.deleteFact": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "index.status": {
    params: z.object({ projectId: z.string() }).strict(),
    result: IndexStatusSchema,
  },
  "index.rebuild": {
    params: z.object({ projectId: z.string() }).strict(),
    result: IndexStatusSchema,
  },
  "index.search": {
    params: z
      .object({
        projectId: z.string(),
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    result: z.object({ hits: z.array(SearchHitSchema) }),
  },
  "scheduler.status": {
    params: z.object({}).strict(),
    result: SchedulerStatusSchema,
  },
  "scheduler.pause": {
    params: z.object({ projectId: z.string().optional() }).strict(),
    result: SchedulerStatusSchema,
  },
  "scheduler.resume": {
    params: z.object({ projectId: z.string().optional() }).strict(),
    result: SchedulerStatusSchema,
  },
  "scheduler.configure": {
    params: z.object({ maxParallel: z.number().int().min(1).max(8) }).strict(),
    result: SchedulerStatusSchema,
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
      /** Fingerprint of the engine's method list; missing on engines older than Phase 1. */
      apiFingerprint: z.string().optional(),
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
  ...LogMethods,
  ...PreviewMethods,
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

/**
 * A short fingerprint of the API method names. The UI compares its own with the engine's to
 * notice an engine left over from an older install (same version number, fewer methods).
 */
export const API_FINGERPRINT: string = (() => {
  const text = Object.keys(ApiSchema).sort().join(",");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${Object.keys(ApiSchema).length}-${h.toString(16)}`;
})();

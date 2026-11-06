import { z } from "zod";

/** The fifteen specialist agents (system description, Section 4). */
export const AGENT_IDS = [
  "manager",
  "thinking",
  "reasoning",
  "project-management",
  "ui-ux-design",
  "diagram",
  "backend",
  "frontend",
  "database",
  "integration",
  "ai-integration",
  "testing",
  "security",
  "enhancement",
  "devops-docs",
] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentGroupSchema = z.enum(["leadership", "design", "builders", "quality", "delivery"]);
export type AgentGroup = z.infer<typeof AgentGroupSchema>;

/** A manifest describes one agent: mission, tools, model role, reviewers, limits and outputs. */
export const AgentManifestSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  group: AgentGroupSchema,
  /** Which model role the agent uses (the Auto-Fit roles). */
  role: z.enum(["coder", "reasoning", "vision", "fast"]),
  mission: z.string(),
  /** The system prompt body. */
  prompt: z.string(),
  tools: z.array(z.string()),
  /** Agents that review this agent's work, in order of preference. */
  reviewers: z.array(AgentIdSchema),
  /** Blackboard sections this agent may write (a trailing `/` means a folder). */
  writes: z.array(z.string()),
  /** Skills assigned to this agent (Phase 5). */
  skills: z.array(z.string()).default([]),
  maxSteps: z.number().int().min(1).max(200),
  outputs: z.string(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const WorkModeSchema = z.enum([
  "single",
  "full",
  "backend",
  "frontend",
  "ai",
  "import",
  "fix",
  "refactor",
  "ask",
  "business",
]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const AgentMessageTypeSchema = z.enum([
  "handoff",
  "request",
  "review",
  "question",
  "result",
  "blocker",
]);
export type AgentMessageType = z.infer<typeof AgentMessageTypeSchema>;

/** Typed message between agents. Validated before it is accepted. */
export const AgentMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** `backend@1.0.0` */
  from: z.string(),
  to: z.string(),
  type: AgentMessageTypeSchema,
  summary: z.string().min(1).max(2000),
  artifacts: z.array(z.string()).max(50),
  criteria: z.array(z.string()).max(30),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const PlanNodeStatusSchema = z.enum(["todo", "doing", "review", "done", "blocked", "failed"]);
export type PlanNodeStatus = z.infer<typeof PlanNodeStatusSchema>;

export const ReviewGradeSchema = z.enum(["blocking", "should_fix", "nice_to_have"]);
export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "changes"]),
  findings: z
    .array(
      z.object({
        grade: ReviewGradeSchema,
        file: z.string().optional(),
        line: z.number().int().optional(),
        text: z.string(),
      }),
    )
    .default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type Review = z.infer<typeof ReviewSchema>;

export const PlanNodeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  title: z.string().min(1).max(200),
  owner: AgentIdSchema,
  deps: z.array(z.string()).default([]),
  criteria: z.array(z.string()).default([]),
  /** Another agent must review this node's output before it counts as done. */
  review: z.boolean().default(false),
  status: PlanNodeStatusSchema.default("todo"),
  attempts: z.number().int().default(0),
  reviewer: AgentIdSchema.optional(),
  /** Short result or reason for blocking. */
  note: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const PlanSchema = z.object({
  mode: WorkModeSchema,
  summary: z.string().default(""),
  nodes: z.array(PlanNodeSchema).min(1).max(40),
  /** Questions the Manager has for the user (asked in one batch). */
  questions: z.array(z.string()).default([]),
  version: z.number().int().default(1),
  approved: z.boolean().default(false),
});
export type Plan = z.infer<typeof PlanSchema>;

export const AgentStateSchema = z.enum(["idle", "thinking", "working", "waiting", "blocked"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentStatusSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  version: z.string(),
  state: AgentStateSchema,
  nodeId: z.string().nullable(),
  text: z.string(),
  done: z.number().int(),
  total: z.number().int(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const BlackboardEntrySchema = z.object({
  section: z.string(),
  owner: z.string(),
  version: z.number().int(),
  updatedAt: z.string(),
  content: z.string(),
});
export type BlackboardEntry = z.infer<typeof BlackboardEntrySchema>;

// ---- Agent Lab (Phase 7) ----------------------------------------------------------------

/** The parts of a manifest a person may change in the lab. */
export const ManifestPatchSchema = z
  .object({
    mission: z.string().min(1).max(600),
    prompt: z.string().min(1).max(12_000),
    tools: z.array(z.string().min(1).max(60)).max(60),
    reviewers: z.array(AgentIdSchema).max(4),
    maxSteps: z.number().int().min(1).max(200),
    role: z.enum(["coder", "reasoning", "vision", "fast"]),
  })
  .partial()
  .strict();
export type ManifestPatch = z.infer<typeof ManifestPatchSchema>;

export const LabVersionSchema = z.object({
  /** null for the built-in version that ships with Depo. */
  id: z.string().nullable(),
  version: z.string(),
  note: z.string(),
  source: z.enum(["builtin", "user", "import"]),
  createdAt: z.string(),
  active: z.boolean(),
  lastScore: z.number().nullable(),
  manifest: AgentManifestSchema,
});
export type LabVersion = z.infer<typeof LabVersionSchema>;

export const EvalCheckSchema = z.object({
  type: z.enum(["contains", "not_contains", "regex", "json", "max_chars", "judge"]),
  value: z.string().max(500).default(""),
});
export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(40),
  prompt: z.string().min(1).max(4000),
  checks: z.array(EvalCheckSchema).min(1).max(8),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSchema = z.object({
  id: z.string(),
  agentId: AgentIdSchema,
  name: z.string(),
  cases: z.array(EvalCaseSchema),
  builtin: z.boolean(),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const EvalCaseResultSchema = z.object({
  caseId: z.string(),
  passed: z.boolean(),
  checks: z.array(z.object({ type: z.string(), value: z.string(), passed: z.boolean(), detail: z.string() })),
  reply: z.string(),
});
export const EvalRunSchema = z.object({
  id: z.string(),
  agentId: AgentIdSchema,
  versionId: z.string().nullable(),
  version: z.string(),
  suiteId: z.string(),
  score: z.number(),
  model: z.string(),
  createdAt: z.string(),
  results: z.array(EvalCaseResultSchema),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const AgentBundleSchema = z.object({
  format: z.literal("depo-agent"),
  formatVersion: z.literal(1),
  agent: AgentIdSchema,
  version: z.string(),
  note: z.string().max(500).default(""),
  manifest: ManifestPatchSchema,
  suites: z
    .array(z.object({ name: z.string().max(80), cases: z.array(EvalCaseSchema).max(50) }))
    .max(10)
    .default([]),
});
export type AgentBundle = z.infer<typeof AgentBundleSchema>;

export const LabAgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  group: AgentGroupSchema,
  activeVersion: z.string(),
  versions: z.number().int(),
  lastScore: z.number().nullable(),
});

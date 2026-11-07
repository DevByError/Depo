import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * App database tables (Drizzle). Phase 0 only creates what Phase 0 uses;
 * later phases add the rest of the Section 18 data model through new migrations.
 */
const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON-encoded value. */
  value: text("value").notNull(),
  ...timestamps,
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    seq: integer("seq").notNull(),
    ts: text("ts").notNull(),
    projectId: text("project_id"),
    taskId: text("task_id"),
    agent: text("agent").notNull(),
    type: text("type").notNull(),
    text: text("text").notNull(),
    /** JSON-encoded object or NULL. */
    details: text("details"),
    durationMs: integer("duration_ms"),
    status: text("status").notNull(),
    ...timestamps,
  },
  (t) => [index("events_project_ts").on(t.projectId, t.ts), index("events_type_ts").on(t.type, t.ts)],
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  lastOpenedAt: text("last_opened_at").notNull(),
  description: text("description").notNull().default(""),
  /** Stack preferences in the user's words, or "" to let the agents decide. */
  stack: text("stack").notNull().default(""),
  /** opened | created | imported | duplicated */
  origin: text("origin").notNull().default("opened"),
  archivedAt: text("archived_at"),
  ...timestamps,
});

export const projectSettings = sqliteTable(
  "project_settings",
  {
    projectId: text("project_id").notNull(),
    key: text("key").notNull(),
    /** JSON-encoded value. */
    value: text("value").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.key] })],
);

export const memoryFacts = sqliteTable("memory_facts", {
  id: text("id").primaryKey(),
  /** NULL = global memory (applies to every project). */
  projectId: text("project_id"),
  /** fact | preference | decision | lesson */
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  /** For lessons: normalised error signature used to find the lesson again. */
  signature: text("signature"),
  /** user | agent | system */
  source: text("source").notNull(),
  uses: integer("uses").notNull().default(0),
  ...timestamps,
});

export const codeFiles = sqliteTable(
  "code_files",
  {
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    lang: text("lang"),
    size: integer("size").notNull(),
    lines: integer("lines").notNull(),
    /** Code map (migration 9): a simple branch count (if, loops, case, catch, && and ||). */
    branches: integer("branches").notNull().default(0),
    /** Why this file looks like an entry point ("__main__ block", "FastAPI app"), or null. */
    entry: text("entry"),
    /** Version of the import extractor that analysed the file (re-analysed when it is older). */
    mapVersion: integer("map_version").notNull().default(0),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

/** Imports between files (code map). `target` is the project file the import resolves to, or null. */
export const codeImports = sqliteTable("code_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  path: text("path").notNull(),
  /** The module as written: `./util`, `@/lib/cn`, `..models`, `app.db`. */
  spec: text("spec").notNull(),
  /** Python `from x import name`: the imported name (it may be a submodule), else "". */
  name: text("name").notNull().default(""),
  /** import | export | require | dynamic | from | include | use | mod */
  kind: text("kind").notNull(),
  line: integer("line").notNull(),
  target: text("target"),
});

export const codeSymbols = sqliteTable("code_symbols", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  path: text("path").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  parent: text("parent"),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  signature: text("signature").notNull(),
});

export const embeddings = sqliteTable("embeddings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  path: text("path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  textHash: text("text_hash").notNull(),
  model: text("model").notNull(),
  dim: integer("dim").notNull(),
  vector: blob("vector", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  /** queued | running | waiting | review | done | failed | cancelled */
  status: text("status").notNull(),
  workspacePath: text("workspace_path"),
  model: text("model"),
  summary: text("summary"),
  error: text("error"),
  /** single | full | backend | frontend | ai | import | fix | refactor | ask | business */
  mode: text("mode").notNull().default("single"),
  /** JSON-encoded Plan (team modes) */
  plan: text("plan"),
  ...timestamps,
});

export const blackboard = sqliteTable(
  "blackboard",
  {
    projectId: text("project_id").notNull(),
    section: text("section").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull(),
    owner: text("owner").notNull(),
    taskId: text("task_id"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.section] })],
);

export const blackboardHistory = sqliteTable("blackboard_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull(),
  section: text("section").notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  owner: text("owner").notNull(),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
});

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fromAgent: text("from_agent").notNull(),
  toAgent: text("to_agent").notNull(),
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  artifacts: text("artifacts").notNull(),
  criteria: text("criteria").notNull(),
  confidence: real("confidence").notNull(),
  ...timestamps,
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  /** user | assistant | tool | system; content is a JSON-encoded ChatMessage */
  role: text("role").notNull(),
  content: text("content").notNull(),
  ...timestamps,
});

export const changeSets = sqliteTable("change_sets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id"),
  /** pending | applied | partially_applied | discarded | superseded | reverted */
  status: text("status").notNull(),
  title: text("title").notNull(),
  /** JSON-encoded FileChange[] */
  files: text("files").notNull(),
  ...timestamps,
});

export const checkpoints = sqliteTable("checkpoints", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  changeSetId: text("change_set_id"),
  label: text("label").notNull(),
  /** active | restored */
  status: text("status").notNull(),
  /** JSON-encoded CheckpointFile[] */
  files: text("files").notNull(),
  ...timestamps,
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** github | zip | folder | created */
  sourceKind: text("source_kind").notNull(),
  source: text("source").notNull(),
  ref: text("ref"),
  commitSha: text("commit_sha"),
  versionId: text("version_id").notNull(),
  /** JSON-encoded SkillVersion[] */
  versions: text("versions").notNull(),
  enabled: integer("enabled").notNull().default(0),
  /** JSON-encoded VetReport */
  vetting: text("vetting").notNull(),
  ...timestamps,
});

export const skillAssignments = sqliteTable(
  "skill_assignments",
  {
    skillId: text("skill_id").notNull(),
    /** global | project */
    scope: text("scope").notNull(),
    projectId: text("project_id").notNull().default(""),
    /** an agent id, `coder`, or `*` for all */
    agent: text("agent").notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.scope, t.projectId, t.agent] })],
);

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** stdio | http */
  transport: text("transport").notNull(),
  command: text("command"),
  args: text("args").notNull(),
  env: text("env").notNull(),
  url: text("url"),
  enabled: integer("enabled").notNull().default(0),
  autoApprove: integer("auto_approve").notNull().default(0),
  vetting: text("vetting"),
  tools: text("tools").notNull().default("[]"),
  ...timestamps,
});

export const knowledgePacks = sqliteTable("knowledge_packs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  /** docs | security | ux | custom */
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  description: text("description").notNull(),
  docCount: integer("doc_count").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  enabled: integer("enabled").notNull().default(1),
  ...timestamps,
});

/** Line comments on a change set in Diff Review (migration 8). */
export const reviewComments = sqliteTable("review_comments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id"),
  changeSetId: text("change_set_id").notNull(),
  path: text("path").notNull(),
  /** new | old */
  side: text("side").notNull(),
  line: integer("line").notNull(),
  endSide: text("end_side").notNull(),
  endLine: integer("end_line").notNull(),
  quote: text("quote").notNull(),
  body: text("body").notNull(),
  /** open | addressed | outdated */
  status: text("status").notNull(),
  /** changed | agent | owner */
  addressedBy: text("addressed_by"),
  addressedIn: text("addressed_in"),
  sentAt: text("sent_at"),
  ref: integer("ref"),
  ...timestamps,
});

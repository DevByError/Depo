import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

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

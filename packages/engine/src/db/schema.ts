import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  ...timestamps,
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

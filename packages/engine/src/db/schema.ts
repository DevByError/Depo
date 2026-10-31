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

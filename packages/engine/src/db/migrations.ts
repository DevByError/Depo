/**
 * Versioned migrations, embedded in code so the compiled sidecar needs no files on disk.
 * Rules: never edit a released migration; add a new one with the next version number.
 * Each migration runs in its own transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "settings_and_events",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        details TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX events_project_ts ON events (project_id, ts);
      CREATE INDEX events_type_ts ON events (type, ts);
    `,
  },
  {
    version: 2,
    name: "projects_tasks_changes_checkpoints",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX projects_root ON projects (root_path);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        model TEXT,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project ON tasks (project_id, created_at);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX messages_task ON messages (task_id, created_at);
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX change_sets_project ON change_sets (project_id, created_at);
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        change_set_id TEXT,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX checkpoints_project ON checkpoints (project_id, created_at);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

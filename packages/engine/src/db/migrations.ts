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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

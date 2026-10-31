import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Logger } from "../logger";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations";
import * as schema from "./schema";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenedDatabase {
  sqlite: Database;
  db: AppDb;
  path: string;
  schemaVersion: number;
  backupPath: string | null;
  close(): void;
}

export interface OpenDatabaseOptions {
  file: string;
  backupsDir: string;
  logger?: Logger;
  migrations?: readonly Migration[];
}

/**
 * Open (or create) the app database in WAL mode and bring it to the latest schema.
 * If the database already exists and has pending migrations, a consistent backup is
 * taken first with `VACUUM INTO`, so a failed upgrade can be rolled back by the user.
 */
export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  const migrations = opts.migrations ?? MIGRATIONS;
  mkdirSync(path.dirname(opts.file), { recursive: true });
  const existed = existsSync(opts.file);
  const sqlite = new Database(opts.file, { create: true, strict: true });

  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  // Windows Defender and indexers can briefly lock files; wait instead of failing.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    sqlite
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  let backupPath: string | null = null;
  if (existed && applied.size > 0 && pending.length > 0) {
    mkdirSync(opts.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(
      opts.backupsDir,
      `${path.basename(opts.file, ".db")}-v${Math.max(...applied)}-${stamp}.db`,
    );
    sqlite.query("VACUUM INTO ?").run(backupPath);
    opts.logger?.info("database backup taken before migration", { backupPath });
  }

  for (const m of pending) {
    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, new Date().toISOString());
    });
    tx();
    opts.logger?.info("migration applied", { version: m.version, name: m.name });
  }

  const row = sqlite.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
  const schemaVersion = row?.v ?? 0;

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    path: opts.file,
    schemaVersion,
    backupPath,
    close: () => sqlite.close(),
  };
}

export { LATEST_SCHEMA_VERSION, schema };

import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { tempDir } from "./helpers";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test("creates the database in WAL mode at the latest schema", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const db = openDatabase({
    file: path.join(t.dir, "db", "depo.db"),
    backupsDir: path.join(t.dir, "backups"),
  });
  const mode = db.sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(mode?.journal_mode).toBe("wal");
  expect(db.schemaVersion).toBe(1);
  expect(db.backupPath).toBeNull();
  db.close();
});

test("re-opening is idempotent; new migrations run after a backup", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const file = path.join(t.dir, "depo.db");
  const backupsDir = path.join(t.dir, "backups");
  openDatabase({ file, backupsDir }).close();

  const again = openDatabase({ file, backupsDir });
  expect(again.backupPath).toBeNull();
  again.close();

  const next = [
    ...MIGRATIONS,
    { version: 2, name: "add_example", sql: "CREATE TABLE example (id TEXT PRIMARY KEY);" },
  ];
  const upgraded = openDatabase({ file, backupsDir, migrations: next });
  expect(upgraded.schemaVersion).toBe(2);
  expect(upgraded.backupPath).not.toBeNull();
  expect(existsSync(upgraded.backupPath ?? "")).toBe(true);
  expect(readdirSync(backupsDir)).toHaveLength(1);
  upgraded.close();
});

test("a failing migration rolls back and leaves the schema unchanged", () => {
  const t = tempDir();
  cleanup = t.cleanup;
  const file = path.join(t.dir, "depo.db");
  const backupsDir = path.join(t.dir, "backups");
  openDatabase({ file, backupsDir }).close();
  const broken = [
    ...MIGRATIONS,
    { version: 2, name: "broken", sql: "CREATE TABLE ok_table (id TEXT); THIS IS NOT SQL;" },
  ];
  expect(() => openDatabase({ file, backupsDir, migrations: broken })).toThrow();
  const db = openDatabase({ file, backupsDir });
  expect(db.schemaVersion).toBe(1);
  const tbl = db.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get();
  expect(tbl).toBeNull();
  db.close();
});

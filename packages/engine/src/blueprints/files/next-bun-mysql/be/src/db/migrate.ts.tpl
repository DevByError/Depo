import mysql from "mysql2/promise";
import schema from "./schema.sql" with { type: "text" };

/**
 * Create the database named in DATABASE_URL when it is missing, then apply schema.sql.
 * Safe to run again: every statement is CREATE ... IF NOT EXISTS.
 */
export async function migrate(url: string): Promise<string[]> {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(database))
    throw new Error("DATABASE_URL must end with a database name of letters, digits, _ or -.");
  u.pathname = "/";
  const server = await mysql.createConnection({ uri: u.toString(), multipleStatements: false });
  try {
    await server.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await server.end();
  }
  const db = await mysql.createConnection({ uri: url });
  const applied: string[] = [];
  try {
    for (const statement of statements(schema)) {
      await db.query(statement);
      applied.push(statement.split("\n")[0] ?? statement);
    }
  } finally {
    await db.end();
  }
  return applied;
}

/** SQL statements in a file, without comments. */
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("Set DATABASE_URL in be/.env first, e.g. mysql://app:app@127.0.0.1:3306/__DEPO_SLUG__");
    process.exit(1);
  }
  const done = await migrate(url);
  console.log(`Database ready: ${done.length} statement(s) applied.`);
}

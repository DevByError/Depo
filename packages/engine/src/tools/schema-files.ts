import fs from "node:fs";
import path from "node:path";

/** Folders that never hold the project's own schema. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  ".data",
  "dist",
  "build",
  "out",
  ".depo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
]);

/**
 * The project's SQL schema files (files ending in .sql that hold a CREATE TABLE), relative to the
 * root with forward slashes: files named like a schema first, then the shallowest.
 */
export function findSchemaFiles(root: string, limit = 2000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs, depth + 1);
      } else if (/\.sql$/i.test(e.name)) {
        try {
          if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
          if (/\bCREATE\s+TABLE\b/i.test(fs.readFileSync(abs, "utf8")))
            found.push(path.relative(root, abs).replace(/\\/g, "/"));
        } catch {
          // unreadable: skip
        }
      }
    }
  };
  walk(root, 0);
  const rank = (p: string) => (/(^|\/)schema\.sql$/i.test(p) ? 0 : /schema/i.test(p) ? 1 : 2);
  return found.sort(
    (a, b) => rank(a) - rank(b) || a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
  );
}

/** The main schema file, or null. */
export function mainSchemaFile(root: string): string | null {
  return findSchemaFiles(root)[0] ?? null;
}

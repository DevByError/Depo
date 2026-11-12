import { createTables, longIdentifiers, matchForeignKeyTypes } from "../tools/sqlcheck";

/**
 * A table step written by Depo itself, with no model call. The plan gives the table's name and its
 * column names; the types follow from the names and from the tables that already exist, the way a
 * careful person would type them. This is the fastest code Depo can write (a millisecond instead of
 * a minute on a small GPU) and the one most small models get wrong (foreign key types, names that
 * are too long, repeated tables). It only runs when the schema file is MySQL or MariaDB style (the
 * dialect of Depo's own blueprints), and the result is checked like any model's work: when the
 * check fails, the step is given to the model instead.
 */

/** A column named in the request with its type spelled out ("name VARCHAR(80)"): kept as written. */
const TYPED =
  /^[A-Za-z_]\w*\s+(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|TIME|YEAR|CHAR|VARCHAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|JSON|ENUM|BLOB)\b/i;

/** True when the schema's statements use MySQL / MariaDB syntax (or it has no tables yet and no other dialect). */
export function isMysqlDialect(schema: string): boolean {
  if (
    /\b(SERIAL|BIGSERIAL|AUTOINCREMENT|PRAGMA|WITHOUT ROWID|RETURNING|UUID DEFAULT gen_random_uuid)\b/i.test(
      schema,
    )
  )
    return false;
  return /\b(AUTO_INCREMENT|UNSIGNED|ENGINE\s*=|CHARSET|COLLATE|TINYINT\(1\))\b/i.test(schema);
}

function singular(s: string): string {
  if (/ies$/.test(s)) return `${s.slice(0, -3)}y`;
  if (/(ss|us)$/.test(s)) return s;
  return s.replace(/s$/, "");
}

/** The existing table a column like `skill_id` points to (skill, skills, skill_items...), or null. */
function referenced(column: string, tables: string[], self: string): string | null {
  const base = column.replace(/_id$/, "");
  if (!base || base === column) return null;
  const candidates = [base, `${base}s`, `${base}es`, base.replace(/y$/, "ies")];
  const found = tables.find((t) => t !== self && candidates.includes(t.toLowerCase()));
  if (found) return found;
  // "owner_id", "author_id": the role in front of the table's name ("user").
  return tables.find((t) => t !== self && singular(t.toLowerCase()) === base.split("_").at(-1)) ?? null;
}

/** The column definition for a name, by convention. */
function typeFor(name: string): string {
  const n = name.toLowerCase();
  if (n === "id") return "BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY";
  if (/_id$/.test(n)) return "BIGINT UNSIGNED NOT NULL";
  if (n === "created_at") return "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP";
  if (n === "updated_at") return "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP";
  if (/(_at|_on)$/.test(n) || /^(date|day|when)$/.test(n)) return "DATETIME NULL";
  if (/^(is|has|can|enabled|active|public|verified|deleted|archived)(_|$)|(_enabled|_active|_flag)$/.test(n))
    return "TINYINT(1) NOT NULL DEFAULT 0";
  if (/^e?mail$|_email$|^email/.test(n)) return "VARCHAR(255) NOT NULL";
  if (/(password|hash|token|secret|salt)/.test(n)) return "VARCHAR(255) NOT NULL";
  if (/^(url|link|path|avatar|image|photo|website|homepage|repo|source_url)$|_url$/.test(n))
    return "VARCHAR(500) NULL";
  if (/^(description|body|content|notes?|text|message|summary|bio|details?|readme|comment|reason)$/.test(n))
    return "TEXT NULL";
  if (/(^|_)(json|data|meta|metadata|payload|settings|config|options|extra)$/.test(n)) return "JSON NULL";
  if (/(price|amount|total|balance|cost|rate|fee)$/.test(n)) return "DECIMAL(12,2) NOT NULL DEFAULT 0";
  if (
    /(count|score|size|rank|position|order|level|age|year|quantity|qty|stars|votes|views|likes|version|duration|length|number|num)$/.test(
      n,
    )
  )
    return "INT NOT NULL DEFAULT 0";
  if (
    /^(kind|type|status|state|role|category|lang|language|locale|mode|visibility|source|provider|level)$/.test(
      n,
    )
  )
    return "VARCHAR(50) NOT NULL";
  if (/^(slug|code|sku|key|handle|username)$/.test(n)) return "VARCHAR(120) NOT NULL";
  if (/(^|_)(name|title|label|heading|subject)$/.test(n)) return "VARCHAR(200) NOT NULL";
  return "VARCHAR(255) NULL";
}

export interface GeneratedTable {
  sql: string;
  /** What Depo decided, for the activity feed ("skill_id: BIGINT UNSIGNED, like skills.id"). */
  notes: string[];
}

/**
 * The CREATE TABLE statement for a plan step, or null when Depo should not write it itself (not a
 * MySQL-style schema, the table already exists, a name that is too long, no sensible columns).
 * `columns` are the names (or "name TYPE" text) the plan took from the request.
 */
export function generateTable(existing: string, name: string, columns: string[]): GeneratedTable | null {
  if (!isMysqlDialect(existing)) return null;
  if (!/^[A-Za-z_]\w*$/.test(name) || columns.length === 0 || columns.length > 40) return null;
  const tables = createTables(existing).map((t) => t.name);
  if (tables.some((t) => t.toLowerCase() === name.toLowerCase())) return null;
  const notes: string[] = [];
  const defs: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of columns) {
    const text = raw.trim();
    const col = /^`?([A-Za-z_]\w*)`?/.exec(text)?.[1]?.toLowerCase();
    if (!col || seen.has(col)) continue;
    seen.add(col);
    if (TYPED.test(text)) {
      defs.push(`  ${text}`);
      continue;
    }
    const type = typeFor(col);
    defs.push(`  ${col} ${type}`);
    const ref = referenced(col, tables, name);
    if (ref) {
      keys.push(
        `  CONSTRAINT fk_${name}_${col} FOREIGN KEY (${col}) REFERENCES ${ref} (id) ON DELETE CASCADE`,
      );
      notes.push(`${col}: points to ${ref}.id`);
    }
  }
  if (!defs.length) return null;
  // A table of only references and a date (favorites, memberships) has no id: its key is the pair.
  const idLess = !seen.has("id");
  const refCols = [...seen].filter((c) => /_id$/.test(c));
  if (idLess && refCols.length >= 2 && refCols.length <= 3)
    keys.unshift(`  PRIMARY KEY (${refCols.join(", ")})`);
  const body = [...defs, ...keys].join(",\n");
  let sql = `CREATE TABLE IF NOT EXISTS ${name} (\n${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  // A reference points at its table's real id type.
  sql = matchForeignKeyTypes(existing, sql).sql;
  if (longIdentifiers(sql).length) return null;
  return { sql, notes };
}

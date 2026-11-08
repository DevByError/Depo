/**
 * Foreign keys MySQL will refuse, found in a schema file before any migration runs. MySQL needs
 * a foreign key column and the column it references to have the same integer type and sign
 * (`user_id INT` cannot reference `users.id BIGINT UNSIGNED`: error 3780), and the same kind of
 * type. Small models guess these types instead of reading the existing tables.
 */

interface Column {
  base: string;
  unsigned: boolean;
  raw: string;
}

const INTS = new Set(["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT", "SERIAL"]);
const STRINGS = new Set([
  "CHAR",
  "VARCHAR",
  "BINARY",
  "VARBINARY",
  "TEXT",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
]);
const NOT_COLUMNS = /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK)\b/i;

/** The text between a `(` at `open` and its matching `)`, or null. */
function inside(sql: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { body: sql.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Split on commas that are not inside brackets or quotes. */
function topLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.replace(/--[^\n]*/g, "").trim()).filter(Boolean);
}

const name = (s: string) => s.replace(/[`"]/g, "").toLowerCase();

interface ForeignKey {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

interface Schema {
  tables: Map<string, Map<string, Column>>;
  fks: ForeignKey[];
}

const CREATE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?[\w$]+[`"]?)\s*\(/gi;

function parseSchema(sql: string): Schema {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  const tables = new Map<string, Map<string, Column>>();
  const fks: ForeignKey[] = [];
  const create = new RegExp(CREATE.source, "gi");
  for (let m = create.exec(text); m; m = create.exec(text)) {
    const table = name(m[1] ?? "");
    const block = inside(text, m.index + m[0].length - 1);
    if (!block) continue;
    create.lastIndex = block.end;
    const cols = new Map<string, Column>();
    for (const part of topLevel(block.body)) {
      const fk =
        /FOREIGN\s+KEY\s*\(\s*([`"]?[\w$]+[`"]?)\s*\)\s*REFERENCES\s+([`"]?[\w$]+[`"]?)\s*\(\s*([`"]?[\w$]+[`"]?)\s*\)/i.exec(
          part,
        );
      if (fk) {
        fks.push({
          table,
          column: name(fk[1] ?? ""),
          refTable: name(fk[2] ?? ""),
          refColumn: name(fk[3] ?? ""),
        });
        continue;
      }
      if (NOT_COLUMNS.test(part)) continue;
      const col = /^([`"]?[\w$]+[`"]?)\s+([A-Za-z]+)(\s*\([^)]*\))?(.*)$/s.exec(part);
      if (!col) continue;
      const base = (col[2] ?? "").toUpperCase();
      const rest = col[4] ?? "";
      const unsigned = /\bUNSIGNED\b/i.test(rest) || base === "SERIAL";
      cols.set(name(col[1] ?? ""), {
        base: base === "INTEGER" ? "INT" : base === "SERIAL" ? "BIGINT" : base,
        unsigned,
        raw:
          base === "SERIAL"
            ? "BIGINT UNSIGNED"
            : `${base}${col[3] ?? ""}${unsigned ? " UNSIGNED" : ""}`.replace(/\s+/g, " "),
      });
      const inline = /\bREFERENCES\s+([`"]?[\w$]+[`"]?)\s*\(\s*([`"]?[\w$]+[`"]?)\s*\)/i.exec(rest);
      if (inline)
        fks.push({
          table,
          column: name(col[1] ?? ""),
          refTable: name(inline[1] ?? ""),
          refColumn: name(inline[2] ?? ""),
        });
    }
    tables.set(table, cols);
  }
  return { tables, fks };
}

/** Foreign keys whose column type does not match the column they reference. */
function mismatches(schema: Schema): { fk: ForeignKey; a: Column; b: Column; ints: boolean }[] {
  const out: { fk: ForeignKey; a: Column; b: Column; ints: boolean }[] = [];
  for (const fk of schema.fks) {
    const a = schema.tables.get(fk.table)?.get(fk.column);
    const b = schema.tables.get(fk.refTable)?.get(fk.refColumn);
    if (!a || !b) continue;
    const ints = INTS.has(a.base) && INTS.has(b.base);
    const bothStrings = STRINGS.has(a.base) && STRINGS.has(b.base);
    const wrong = ints ? a.base !== b.base || a.unsigned !== b.unsigned : !bothStrings && a.base !== b.base;
    if (wrong) out.push({ fk, a, b, ints });
  }
  return out;
}

const target = (b: Column) => b.raw.replace(/\s*AUTO_INCREMENT/i, "");

/** Plain sentences about foreign keys whose columns do not match, for the model to fix. */
export function foreignKeyProblems(sql: string): string[] {
  return mismatches(parseSchema(sql)).map(
    ({ fk, a, b }) =>
      `${fk.table}.${fk.column} is ${a.raw} but it references ${fk.refTable}.${fk.refColumn}, which is ${b.raw}: MySQL refuses this foreign key (error 3780). Declare ${fk.table}.${fk.column} as ${target(b)}.`,
  );
}

export interface CreateTable {
  name: string;
  start: number;
  end: number;
  /** The statement, ending with ";". */
  text: string;
  /** False when the statement has no ";" after it (it may have been cut off). */
  complete: boolean;
}

/** The CREATE TABLE statements of a SQL text, in order. */
export function createTables(sql: string): CreateTable[] {
  const out: CreateTable[] = [];
  const create = new RegExp(CREATE.source, "gi");
  for (let m = create.exec(sql); m; m = create.exec(sql)) {
    const block = inside(sql, m.index + m[0].length - 1);
    if (!block) break;
    // Table options and the ";" after the closing bracket belong to the statement.
    const after = sql.slice(block.end + 1);
    const semi = /^[^;]*?;/.exec(after);
    const options = semi && !/\bCREATE\b/i.test(semi[0]) ? semi[0] : null;
    const end = options
      ? block.end + 1 + options.length
      : block.end + 1 + (/^[^\n]*/.exec(after)?.[0].replace(/\s+$/, "").length ?? 0);
    const text = sql.slice(m.index, end).replace(/\s+$/, "");
    out.push({
      name: name(m[1] ?? ""),
      start: m.index,
      end,
      text: options ? text : `${text};`,
      complete: !!options,
    });
    create.lastIndex = end;
  }
  return out;
}

/**
 * The CREATE TABLE statements of `added` for tables that `existing` does not have, joined by a
 * blank line. With `complete`, statements with no ";" after them (cut off) are left out.
 */
export function newTables(
  existing: string,
  added: string,
  opts: { complete?: boolean } = {},
): { sql: string; tables: string[] } {
  const have = new Set(createTables(existing).map((t) => t.name));
  const kept: CreateTable[] = [];
  for (const t of createTables(added)) {
    if (have.has(t.name) || (opts.complete && !t.complete)) continue;
    have.add(t.name);
    kept.push(t);
  }
  return { sql: kept.map((t) => t.text).join("\n\n"), tables: kept.map((t) => t.name) };
}

/** `added` without the CREATE TABLE statements for tables that `existing` already has. */
export function withoutExistingTables(existing: string, added: string): { sql: string; skipped: string[] } {
  const have = new Set(createTables(existing).map((t) => t.name));
  const skipped: string[] = [];
  let sql = added;
  for (const t of createTables(added).reverse()) {
    if (!have.has(t.name)) continue;
    skipped.unshift(t.name);
    sql = `${sql.slice(0, t.start)}${sql.slice(t.end).replace(/^[ \t]*\r?\n/, "")}`;
  }
  return { sql: skipped.length ? sql.replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/, "") : added, skipped };
}

/**
 * `added` with its integer foreign key columns typed like the columns they reference (in
 * `existing` or in `added`): `user_id INT` becomes `user_id BIGINT UNSIGNED` when users.id is
 * BIGINT UNSIGNED. Only tables created in `added` change.
 */
export function matchForeignKeyTypes(existing: string, added: string): { sql: string; changes: string[] } {
  const mine = createTables(added);
  const fixes = mismatches(parseSchema(`${existing}\n${added}`)).filter(
    (m) => m.ints && mine.some((t) => t.name === m.fk.table),
  );
  if (!fixes.length) return { sql: added, changes: [] };
  const changes: string[] = [];
  let sql = added;
  for (const t of [...mine].reverse()) {
    let text = sql.slice(t.start, t.end);
    for (const { fk, a, b } of fixes.filter((f) => f.fk.table === t.name)) {
      const col = fk.column.replace(/[$]/g, "\\$&");
      const re = new RegExp(
        String.raw`((?:^|[(,])\s*[\`"]?${col}[\`"]?\s+)(?:TINYINT|SMALLINT|MEDIUMINT|INTEGER|INT|BIGINT)\b(?:\s*\(\s*\d+\s*\))?(?:\s+(?:UNSIGNED|SIGNED)\b)?`,
        "i",
      );
      const next = text.replace(re, `$1${target(b)}`);
      if (next !== text) {
        text = next;
        changes.unshift(
          `${fk.table}.${fk.column} ${a.raw} → ${target(b)} (like ${fk.refTable}.${fk.refColumn})`,
        );
      }
    }
    sql = `${sql.slice(0, t.start)}${text}${sql.slice(t.end)}`;
  }
  return { sql, changes };
}

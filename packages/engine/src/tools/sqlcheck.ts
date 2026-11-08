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

/** Plain sentences about foreign keys whose columns do not match, for the model to fix. */
export function foreignKeyProblems(sql: string): string[] {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  const tables = new Map<string, Map<string, Column>>();
  const fks: { table: string; column: string; refTable: string; refColumn: string }[] = [];
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?[\w$]+[`"]?)\s*\(/gi;
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
      cols.set(name(col[1] ?? ""), {
        base: base === "INTEGER" ? "INT" : base === "SERIAL" ? "BIGINT" : base,
        unsigned: /\bUNSIGNED\b/i.test(rest) || base === "SERIAL",
        raw: `${base}${col[3] ?? ""}${/\bUNSIGNED\b/i.test(rest) ? " UNSIGNED" : ""}`.replace(/\s+/g, " "),
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
  const problems: string[] = [];
  for (const fk of fks) {
    const a = tables.get(fk.table)?.get(fk.column);
    const b = tables.get(fk.refTable)?.get(fk.refColumn);
    if (!a || !b) continue;
    const bothInts = INTS.has(a.base) && INTS.has(b.base);
    const bothStrings = STRINGS.has(a.base) && STRINGS.has(b.base);
    const wrong = bothInts
      ? a.base !== b.base || a.unsigned !== b.unsigned
      : !bothStrings && a.base !== b.base;
    if (wrong)
      problems.push(
        `${fk.table}.${fk.column} is ${a.raw} but it references ${fk.refTable}.${fk.refColumn}, which is ${b.raw}: MySQL refuses this foreign key (error 3780). Declare ${fk.table}.${fk.column} as ${b.raw.replace(/\s*AUTO_INCREMENT/i, "")}.`,
      );
  }
  return problems;
}

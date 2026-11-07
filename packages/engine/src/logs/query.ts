import fs from "node:fs";
import path from "node:path";
import type { JsonValue, LogCounts, LogLevel, LogLine } from "@depo/shared";
import { LEVEL_RANK, type LogRecord } from "../logger";

export interface LogFilter {
  level?: LogLevel | undefined;
  levels?: LogLevel[] | undefined;
  component?: string | undefined;
  text?: string | undefined;
  taskId?: string | undefined;
  projectId?: string | undefined;
}

export interface LogQuery extends LogFilter {
  since?: string | undefined;
  until?: string | undefined;
  limit: number;
  before?: string | undefined;
  maxBytes?: number | undefined;
  /** Read the current file (engine.log) only up to this size: newer lines come from the live tail. */
  headBytes?: number | undefined;
}

export interface LogQueryResult {
  lines: LogLine[];
  next: string | null;
  scannedBytes: number;
  truncated: boolean;
  counts: LogCounts;
}

const CHUNK = 64 * 1024;
export const DEFAULT_SCAN_BYTES = 8 * 1024 * 1024;
const FIXED = new Set([
  "ts",
  "level",
  "component",
  "msg",
  "projectId",
  "taskId",
  "agent",
  "durationMs",
  "err",
]);

/**
 * The log files, newest first: engine.log, engine.1.log, engine.2.log, …
 * Only names the rotation produces are listed.
 */
export function logFiles(dir: string, baseName = "engine"): { name: string; file: string; index: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(\\d+))?\\.log$`);
  return names
    .map((name) => {
      const m = re.exec(name);
      return m ? { name, file: path.join(dir, name), index: m[1] ? Number(m[1]) : 0 } : null;
    })
    .filter((x): x is { name: string; file: string; index: number } => x !== null)
    .sort((a, b) => a.index - b.index);
}

/** Paging cursor: "skip every line newer than the `n`-th line (counting back) stamped `ts`". */
export function encodeCursor(ts: string, n: number): string {
  return `${ts}|${n}`;
}

export function decodeCursor(c: string | undefined): { ts: string; n: number } | null {
  if (!c) return null;
  const i = c.lastIndexOf("|");
  if (i <= 0) return null;
  const n = Number(c.slice(i + 1));
  return Number.isInteger(n) && n >= 0 ? { ts: c.slice(0, i), n } : null;
}

/**
 * Read lines from the end of each file backwards, without loading whole files. The byte count read
 * is fixed when the file is opened, so lines written meanwhile are left for the live tail.
 */
async function* reverseLines(file: string, upTo?: number): AsyncGenerator<{ line: string; bytes: number }> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    let pos = upTo !== undefined ? Math.min(size, upTo) : size;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const { bytesRead } = await handle.read(buf, 0, len, pos);
      let data: Buffer = Buffer.concat([buf.subarray(0, bytesRead), carry]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        if (i + 1 < end) {
          const raw = data.subarray(i + 1, end);
          yield { line: raw.toString("utf8").replace(/\r$/, ""), bytes: raw.length + 1 };
        }
        end = i;
      }
      data = data.subarray(0, end);
      carry = Buffer.from(data);
    }
    if (carry.length > 0) yield { line: carry.toString("utf8").replace(/\r$/, ""), bytes: carry.length };
  } finally {
    await handle.close();
  }
}

/** Cheap checks on the raw text before parsing JSON. */
function rawMatch(line: string, f: LogFilter, textLower: string[] | null): boolean {
  if (textLower) {
    const lower = line.toLowerCase();
    if (!textLower.some((t) => lower.includes(t))) return false;
  }
  if (f.taskId && !line.includes(f.taskId)) return false;
  if (f.projectId && !line.includes(f.projectId)) return false;
  return true;
}

export function levelAllowed(level: LogLevel, f: LogFilter): boolean {
  if (f.levels && f.levels.length > 0) return f.levels.includes(level);
  if (f.level) return LEVEL_RANK[level] >= LEVEL_RANK[f.level];
  return true;
}

/** Everything but the level: component, task, project and text. */
export function otherFiltersMatch(r: LogRecord, f: LogFilter, textLower: string[] | null): boolean {
  if (f.component && r.component !== f.component) return false;
  if (f.taskId && r.taskId !== f.taskId) return false;
  if (f.projectId && r.projectId !== f.projectId) return false;
  if (textLower) {
    const hay = JSON.stringify(r).toLowerCase();
    if (!textLower.some((t) => hay.includes(t))) return false;
  }
  return true;
}

/** The search text and its JSON-escaped form (so `C:\Users` finds `C:\\Users`). */
export function textNeedles(text: string | undefined): string[] | null {
  const t = text?.trim().toLowerCase();
  if (!t) return null;
  const escaped = JSON.stringify(t).slice(1, -1);
  return escaped === t ? [t] : [t, escaped];
}

const LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

export function parseRecord(line: string): LogRecord | null {
  if (!line.startsWith("{")) return null;
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r.ts !== "string" || typeof r.msg !== "string" || !LEVELS.has(String(r.level))) return null;
    if (typeof r.component !== "string" || !r.component) r.component = "engine";
    return r as LogRecord;
  } catch {
    return null;
  }
}

/** The API shape of a line: fixed fields plus everything else under `data`. */
export function toLogLine(r: LogRecord, id: string): LogLine {
  const data: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(r)) if (!FIXED.has(k) && v !== undefined) data[k] = v as JsonValue;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  let err: LogLine["err"] = null;
  if (r.err && typeof r.err === "object") {
    const e = r.err as Record<string, unknown>;
    err = { name: str(e.name), message: String(e.message ?? ""), stack: str(e.stack) };
  } else if (typeof r.err === "string") {
    err = { name: null, message: r.err, stack: null };
  }
  return {
    id,
    ts: r.ts,
    level: r.level,
    component: r.component,
    msg: r.msg,
    projectId: str(r.projectId),
    taskId: str(r.taskId),
    agent: str(r.agent),
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    err,
    data,
  };
}

/**
 * Search the current and rotated log files from the newest line backwards. Stops when `limit`
 * lines match, when `since` is passed, or after `maxBytes` bytes. Returns lines oldest first and a
 * `next` cursor for the page before.
 */
export async function queryLogs(dir: string, q: LogQuery, baseName = "engine"): Promise<LogQueryResult> {
  const maxBytes = q.maxBytes ?? DEFAULT_SCAN_BYTES;
  const needles = textNeedles(q.text);
  const before = decodeCursor(q.before);
  const counts: LogCounts = { debug: 0, info: 0, warn: 0, error: 0 };
  const out: LogLine[] = [];
  let scanned = 0;
  let truncated = false;
  let exhausted = true;
  // Position of the last line read, for the `next` cursor.
  let posTs: string | null = null;
  let posN = 0;
  let skipLeft = before?.n ?? 0;

  outer: for (const f of logFiles(dir, baseName)) {
    for await (const { line, bytes } of reverseLines(f.file, f.index === 0 ? q.headBytes : undefined)) {
      // The timestamp is the first field; read it without parsing the whole line.
      const ts = /^\{"ts":"([^"]+)"/.exec(line)?.[1] ?? parseRecord(line)?.ts;
      if (!ts) continue;
      // Lines the previous pages already covered are passed over quickly and not counted.
      if (before) {
        if (ts > before.ts) continue;
        if (ts === before.ts && skipLeft > 0) {
          skipLeft--;
          continue;
        }
      }
      if (scanned >= maxBytes) {
        truncated = true;
        exhausted = false;
        break outer;
      }
      scanned += bytes;
      if (q.since && ts < q.since) break outer;
      if (posTs === ts) posN++;
      else {
        posTs = ts;
        posN = before && ts === before.ts ? before.n + 1 : 1;
      }
      if (q.until && ts >= q.until) continue;
      if (!rawMatch(line, q, needles)) continue;
      const r = parseRecord(line);
      if (!r || !otherFiltersMatch(r, q, needles)) continue;
      counts[r.level]++;
      if (!levelAllowed(r.level, q)) continue;
      out.push(toLogLine(r, `${ts}#${posN}`));
      if (out.length >= q.limit) {
        exhausted = false;
        break outer;
      }
    }
  }
  out.reverse();
  return {
    lines: out,
    next: exhausted || posTs === null ? null : encodeCursor(posTs, posN),
    scannedBytes: scanned,
    truncated,
    counts,
  };
}

/** Components seen in the newest part of the logs. */
export async function recentComponents(dir: string, maxBytes = 2 * 1024 * 1024): Promise<string[]> {
  const seen = new Set<string>();
  let scanned = 0;
  outer: for (const f of logFiles(dir)) {
    for await (const { line, bytes } of reverseLines(f.file)) {
      scanned += bytes;
      if (scanned > maxBytes) break outer;
      const m = /"component":"([a-z0-9_.-]{1,64})"/i.exec(line);
      if (m?.[1]) seen.add(m[1]);
    }
  }
  return [...seen];
}

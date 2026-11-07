import type { LogCounts, LogLevel, LogLine } from "@depo/shared";

/** Highest first, the order the chips show them in. */
export const LEVEL_ORDER: LogLevel[] = ["error", "warn", "info", "debug"];

export const LEVEL_LABEL: Record<LogLevel, string> = {
  error: "Errors",
  warn: "Warnings",
  info: "Info",
  debug: "Debug",
};

/** Short badge text in a row. */
export const LEVEL_BADGE: Record<LogLevel, string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
  debug: "DEBUG",
};

/** Literal class names, so Tailwind sees each one. */
export const LEVEL_TONE: Record<LogLevel, string> = {
  error: "bg-danger/12 text-danger",
  warn: "bg-warning/12 text-warning",
  info: "bg-info/12 text-info",
  debug: "bg-raised text-subtle",
};

export const LEVEL_DOT: Record<LogLevel, string> = {
  error: "bg-danger",
  warn: "bg-warning",
  info: "bg-info",
  debug: "bg-subtle",
};

export const EMPTY_COUNTS: LogCounts = { debug: 0, info: 0, warn: 0, error: 0 };

/** Lines kept in the view; older ones are dropped as live lines arrive. */
export const MAX_VIEW_LINES = 5000;

export interface LogFilters {
  /** Chips that are on. Empty means every level. */
  levels: LogLevel[];
  component: string | null;
  text: string;
  taskId: string | null;
}

/** The `levels` param for the engine: nothing when every level (or none) is selected. */
export function levelsParam(levels: LogLevel[]): LogLevel[] | undefined {
  const unique = [...new Set(levels)];
  return unique.length === 0 || unique.length === LEVEL_ORDER.length ? undefined : unique;
}

/** Params shared by `logs.query` and `logs.tail`, without empty values. */
export function filterParams(f: LogFilters, withLevels = true) {
  const levels = withLevels ? levelsParam(f.levels) : undefined;
  const text = f.text.trim();
  return {
    ...(levels ? { levels } : {}),
    ...(f.component ? { component: f.component } : {}),
    ...(text ? { text: text.slice(0, 200) } : {}),
    ...(f.taskId ? { taskId: f.taskId } : {}),
  };
}

export function levelSelected(level: LogLevel, levels: LogLevel[]): boolean {
  return levels.length === 0 || levels.includes(level);
}

/** Turn one chip on or off. Turning off the last chip shows every level again. */
export function toggleLevel(levels: LogLevel[], level: LogLevel): LogLevel[] {
  return levels.includes(level) ? levels.filter((l) => l !== level) : [...levels, level];
}

export interface LogView {
  lines: LogLine[];
  counts: LogCounts;
  /** Cursor for older lines (`logs.query` `before`); null when there are none, or they were dropped. */
  next: string | null;
  /** Live tail cursor. */
  cursor: number;
  /** Older lines were dropped from the view to keep it fast. */
  trimmed: boolean;
}

export const EMPTY_VIEW: LogView = { lines: [], counts: EMPTY_COUNTS, next: null, cursor: 0, trimmed: false };

/**
 * Add live lines. The tail is asked for every level (so the chip counts stay right); only lines
 * whose level is selected are shown. Lines already in the view are skipped.
 */
export function mergeTail(
  view: LogView,
  tail: LogLine[],
  cursor: number,
  levels: LogLevel[],
  max = MAX_VIEW_LINES,
): LogView {
  if (tail.length === 0) return cursor === view.cursor ? view : { ...view, cursor };
  const counts = { ...view.counts };
  const seen = new Set(view.lines.slice(-tail.length * 2).map((l) => l.id));
  const add: LogLine[] = [];
  for (const line of tail) {
    if (seen.has(line.id)) continue;
    counts[line.level]++;
    if (levelSelected(line.level, levels)) add.push(line);
  }
  let lines = add.length ? [...view.lines, ...add] : view.lines;
  let { next, trimmed } = view;
  if (lines.length > max) {
    lines = lines.slice(lines.length - max);
    next = null;
    trimmed = true;
  }
  return { lines, counts, next, cursor, trimmed };
}

/** Older lines from "Load older", put in front. */
export function prependOlder(
  view: LogView,
  older: LogLine[],
  next: string | null,
  counts: LogCounts,
): LogView {
  const ids = new Set(view.lines.map((l) => l.id));
  const fresh = older.filter((l) => !ids.has(l.id));
  return {
    ...view,
    lines: [...fresh, ...view.lines],
    next,
    counts: {
      debug: view.counts.debug + counts.debug,
      info: view.counts.info + counts.info,
      warn: view.counts.warn + counts.warn,
      error: view.counts.error + counts.error,
    },
  };
}

/** `HH:MM:SS.mmm` in local time. */
export function logClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One line of plain text for the clipboard. */
export function formatLogLine(line: LogLine): string {
  const parts = [line.ts, LEVEL_BADGE[line.level], `[${line.component}]`, line.msg];
  const extra: Record<string, unknown> = { ...line.data };
  if (line.taskId) extra.taskId = line.taskId;
  if (line.projectId) extra.projectId = line.projectId;
  if (line.agent) extra.agent = line.agent;
  if (line.durationMs !== null) extra.durationMs = line.durationMs;
  if (line.err) extra.err = line.err.message;
  if (Object.keys(extra).length) parts.push(JSON.stringify(extra));
  return parts.join(" ");
}

/** Everything about a line, for the expanded view (the stack is shown separately). */
export function lineDetails(line: LogLine): Record<string, unknown> {
  const out: Record<string, unknown> = { ts: line.ts, level: line.level, component: line.component };
  if (line.projectId) out.projectId = line.projectId;
  if (line.taskId) out.taskId = line.taskId;
  if (line.agent) out.agent = line.agent;
  if (line.durationMs !== null) out.durationMs = line.durationMs;
  Object.assign(out, line.data);
  if (line.err) out.err = { name: line.err.name, message: line.err.message };
  return out;
}

/** A short task label for a chip: the title when known, else the end of the id. */
export function taskChip(taskId: string, titles: Map<string, string>): string {
  const title = titles.get(taskId);
  if (title) return title.length > 28 ? `${title.slice(0, 27)}…` : title;
  return `task ${taskId.slice(-6)}`;
}

/** "1.2 s", "340 ms". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

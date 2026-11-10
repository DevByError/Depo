import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
export const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

/** Who and what a line is about. Every field is optional; `component` defaults to "engine". */
export interface LogContext {
  component?: string;
  projectId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  [key: string]: unknown;
}

/** One line in the log file, after redaction. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  projectId?: string;
  taskId?: string;
  agent?: string;
  durationMs?: number;
  err?: { name?: string; message: string; stack?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TailEntry {
  seq: number;
  record: LogRecord;
}

export interface LoggerOptions {
  dir: string;
  fileName?: string;
  level?: LogLevel;
  /** Rotate when the file would grow past this many bytes (default 5 MB). */
  maxBytes?: number;
  /** Rotated files kept: engine.1.log … engine.<maxFiles>.log (default 5). */
  maxFiles?: number;
  /** Also write to stderr (dev). Stdout is reserved for the ready handshake. */
  stderr?: boolean;
  /**
   * Lines are batched and written at most this often, so a burst of debug lines costs one write.
   * Errors are written at once. 0 writes every line straight away. Default 50 ms.
   */
  flushMs?: number;
  /** Newest lines kept in memory for the live tail (default 2000). */
  ringSize?: number;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: LogContext): Logger;
  /** Is a line at this level written? Use it to skip building expensive fields. */
  enabled(level: LogLevel): boolean;
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
  /** Write buffered lines now (before reading the file, on exit). */
  flush(): void;
  /** Lines written after `cursor` (a seq), newest last, from the in-memory ring. */
  tail(cursor: number, max?: number): { entries: TailEntry[]; cursor: number; reset: boolean };
  /** Delete the old log files and empty the current one (the owner's "Clear logs"). */
  clear(): { removed: number; bytes: number };
  /** Components written to during this run. */
  components(): string[];
  /** Seq of the newest line (the live tail continues after it). */
  readonly cursor: number;
  readonly file: string;
  readonly dir: string;
  readonly maxFiles: number;
}

// ---- per-call context (task, project, agent) ---------------------------------------------------

const contextStore = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with extra fields (taskId, projectId, agent…) added to every line logged inside it,
 * including lines from code that does not know about the task (model calls, the scheduler).
 * Nested calls merge with the outer context.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const outer = contextStore.getStore();
  return contextStore.run({ ...outer, ...stripEmpty(ctx) }, fn);
}

export function currentLogContext(): LogContext | undefined {
  return contextStore.getStore();
}

function stripEmpty(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

// ---- errors ------------------------------------------------------------------------------------

/** Error objects have no enumerable fields, so turn them into plain data before redaction. */
export function serializeError(err: unknown): LogRecord["err"] {
  if (err instanceof Error) {
    const out: NonNullable<LogRecord["err"]> = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    // Typed errors carry useful extras (ModelGatewayError: kind, status, detail; Node: code).
    const extra = err as unknown as Record<string, unknown>;
    for (const key of ["kind", "status", "code", "detail"]) {
      const v = extra[key];
      if (typeof v === "string" || typeof v === "number") out[key] = v;
    }
    if (err.cause !== undefined)
      out.cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
    return out;
  }
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

function plain(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) out[k] = serializeError(v);
    else if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

// ---- the sink: one per log file ----------------------------------------------------------------

const sinks = new Set<LogSink>();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous writes only: nothing else runs during "exit".
  process.on("exit", () => {
    for (const s of sinks) s.flush();
  });
}

class LogSink {
  readonly file: string;
  readonly base: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  min: number;
  private readonly flushMs: number;
  private readonly ringSize: number;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private size = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly ring: TailEntry[] = [];
  private seq = 0;
  private readonly seen = new Set<string>();
  private failures = 0;
  /** After a failed rotation (a file held open elsewhere), keep appending for a while instead. */
  private rotateBlockedUntil = 0;

  constructor(private readonly opts: LoggerOptions) {
    this.file = path.join(opts.dir, opts.fileName ?? "engine.log");
    this.base = this.file.replace(/\.log$/, "");
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, opts.maxFiles ?? 5);
    this.min = LEVEL_RANK[opts.level ?? "info"];
    this.flushMs = Math.max(0, opts.flushMs ?? 50);
    this.ringSize = Math.max(10, opts.ringSize ?? 2000);
    try {
      mkdirSync(opts.dir, { recursive: true });
    } catch {
      // The first write reports nothing either; logging must never stop the engine.
    }
    sinks.add(this);
    installExitHook();
  }

  get level(): LogLevel {
    return LOG_LEVELS.find((l) => LEVEL_RANK[l] === this.min) ?? "info";
  }

  write(record: LogRecord) {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: record.ts, level: record.level, component: record.component, msg: record.msg, note: "fields could not be serialised" })}\n`;
    }
    this.seq++;
    this.ring.push({ seq: this.seq, record });
    // Trim in steps, not on every line, so a full ring costs nothing per write.
    if (this.ring.length > this.ringSize * 1.25) this.ring.splice(0, this.ring.length - this.ringSize);
    this.seen.add(record.component);
    if (this.opts.stderr) process.stderr.write(line);
    this.buffer.push(line);
    this.bufferBytes += Buffer.byteLength(line);
    if (record.level === "error" || this.flushMs === 0 || this.bufferBytes >= 256 * 1024) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
      // A pending flush must not keep the process alive; the exit hook writes what is left.
      this.timer.unref?.();
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    let written = 0;
    try {
      if (this.size < 0) this.size = existsSync(this.file) ? statSync(this.file).size : 0;
      // Write in chunks that fit the size limit, rotating between them.
      while (written < lines.length) {
        let chunk = "";
        let bytes = 0;
        let n = written;
        const limit = Date.now() < this.rotateBlockedUntil ? Number.POSITIVE_INFINITY : this.maxBytes;
        while (n < lines.length) {
          const l = lines[n] as string;
          const b = Buffer.byteLength(l);
          if (bytes > 0 && this.size + bytes + b > limit) break;
          chunk += l;
          bytes += b;
          n++;
        }
        if (this.size > 0 && this.size + bytes > this.maxBytes && Date.now() >= this.rotateBlockedUntil) {
          try {
            this.rotate();
            continue;
          } catch {
            // Losing lines is worse than a file over the limit: write here and retry later.
            this.rotateBlockedUntil = Date.now() + 30_000;
          }
        }
        appendFileSync(this.file, chunk, "utf8");
        this.size += bytes;
        written = n;
      }
      this.failures = 0;
    } catch {
      // Windows: Defender or an editor can lock the file for a moment. Keep the lines and retry on
      // the next write, but never hold more than ~1 MB.
      this.failures++;
      this.size = -1;
    }
    this.buffer = lines.slice(written);
    this.bufferBytes = this.buffer.reduce((n, l) => n + Buffer.byteLength(l), 0);
    while (this.bufferBytes > 1024 * 1024 && this.buffer.length > 0) {
      this.bufferBytes -= Buffer.byteLength(this.buffer.shift() as string);
    }
    if (this.buffer.length > 0 && !this.timer && this.failures < 50) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, 250);
      this.timer.unref?.();
    }
  }

  /** engine.log -> engine.1.log -> … -> engine.<maxFiles>.log (the oldest is deleted). */
  private rotate() {
    const oldest = `${this.base}.${this.maxFiles}.log`;
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.base}.${i}.log`;
      if (existsSync(from)) renameSync(from, `${this.base}.${i + 1}.log`);
    }
    if (existsSync(this.file)) renameSync(this.file, `${this.base}.1.log`);
    this.size = 0;
  }

  /** The rotated files go and the current file starts empty; lines written from now on are kept. */
  clear(): { removed: number; bytes: number } {
    this.flush();
    let removed = 0;
    let bytes = 0;
    const drop = (file: string, truncate: boolean) => {
      try {
        if (!existsSync(file)) return;
        const size = statSync(file).size;
        if (truncate) writeFileSync(file, "", "utf8");
        else rmSync(file, { force: true });
        bytes += size;
        removed++;
      } catch {
        // A file held open elsewhere stays; the next clear tries again.
      }
    };
    for (let i = 1; i <= this.maxFiles + 5; i++) drop(`${this.base}.${i}.log`, false);
    drop(this.file, true);
    this.size = 0;
    this.ring.length = 0;
    return { removed, bytes };
  }

  tail(cursor: number, max: number): { entries: TailEntry[]; cursor: number; reset: boolean } {
    const first = this.ring[0]?.seq ?? this.seq + 1;
    // A cursor from an older engine run (seq restarted) or one that fell out of the ring.
    const reset = cursor > this.seq || (cursor > 0 && cursor < first - 1);
    const from = reset ? 0 : cursor;
    const entries: TailEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const e = this.ring[i] as TailEntry;
      if (e.seq <= from) break;
      entries.push(e);
    }
    entries.reverse();
    return { entries: entries.slice(-max), cursor: this.seq, reset };
  }

  components(): string[] {
    return [...this.seen].sort();
  }

  get currentSeq(): number {
    return this.seq;
  }
}

// ---- loggers -----------------------------------------------------------------------------------

/**
 * Structured JSON-lines logger. Each line has `ts`, `level`, `component`, `msg` and optional
 * `projectId`, `taskId`, `agent`, `durationMs` and `err` ({ name, message, stack }), plus any other
 * fields. Secrets are redacted before anything is written. Size-based rotation keeps
 * engine.log plus engine.1.log … engine.<maxFiles>.log. Writes are batched (see `flushMs`) and
 * synchronous, so a crash loses at most the last few milliseconds and errors are never lost.
 */
export function createLogger(opts: LoggerOptions, bindings: LogContext = {}): Logger {
  return makeLogger(new LogSink(opts), bindings);
}

function makeLogger(sink: LogSink, bindings: LogContext): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[level] < sink.min) return;
    const ctx = contextStore.getStore();
    const merged: Record<string, unknown> = plain({ ...ctx, ...bindings, ...fields });
    const ts = new Date().toISOString();
    const component = typeof merged.component === "string" && merged.component ? merged.component : "engine";
    // Fixed fields first so the file reads well; fields cannot overwrite them.
    for (const key of ["ts", "level", "component", "msg"]) delete merged[key];
    const record = redact({ ts, level, component, msg, ...stripEmpty(merged) }) as LogRecord;
    sink.write(record);
  };
  const logger: Logger = {
    get file() {
      return sink.file;
    },
    get dir() {
      return path.dirname(sink.file);
    },
    get maxFiles() {
      return sink.maxFiles;
    },
    get cursor() {
      return sink.currentSeq;
    },
    get level() {
      return sink.level;
    },
    setLevel: (level) => {
      if (isLogLevel(level)) sink.min = LEVEL_RANK[level];
    },
    enabled: (level) => LEVEL_RANK[level] >= sink.min,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => makeLogger(sink, { ...bindings, ...b }),
    flush: () => sink.flush(),
    tail: (cursor, max = 1000) => sink.tail(cursor, max),
    clear: () => sink.clear(),
    components: () => sink.components(),
  };
  return logger;
}

// ---- the engine's logger, for code that is not handed one ---------------------------------------

let defaultLogger: Logger | null = null;

/** The engine sets its root logger here so shared code (tool loop, tools) can log without wiring. */
export function setDefaultLogger(logger: Logger | null): void {
  defaultLogger = logger;
}

export function getDefaultLogger(): Logger | null {
  return defaultLogger;
}

/**
 * A logger for a component that writes through whatever logger the engine set as default, looked
 * up on every call (so it can be created at module load). Lines are dropped when there is none.
 */
export function getLogger(bindings: LogContext): Logger {
  const target = () => defaultLogger?.child(bindings) ?? null;
  return {
    get file() {
      return defaultLogger?.file ?? "";
    },
    get dir() {
      return defaultLogger?.dir ?? "";
    },
    get maxFiles() {
      return defaultLogger?.maxFiles ?? 0;
    },
    get cursor() {
      return defaultLogger?.cursor ?? 0;
    },
    get level() {
      return defaultLogger?.level ?? "info";
    },
    setLevel: (l) => defaultLogger?.setLevel(l),
    enabled: (l) => defaultLogger?.enabled(l) ?? false,
    debug: (m, f) => target()?.debug(m, f),
    info: (m, f) => target()?.info(m, f),
    warn: (m, f) => target()?.warn(m, f),
    error: (m, f) => target()?.error(m, f),
    child: (b) => getLogger({ ...bindings, ...b }),
    flush: () => defaultLogger?.flush(),
    tail: (cursor, max) => defaultLogger?.tail(cursor, max) ?? { entries: [], cursor: 0, reset: false },
    clear: () => defaultLogger?.clear() ?? { removed: 0, bytes: 0 },
    components: () => defaultLogger?.components() ?? [],
  };
}

/** Elapsed milliseconds since `start` (from `performance.now()`), rounded. */
export function since(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

/** The first line of a text, trimmed and capped (tool results, command output). */
export function firstLine(text: string, max = 160): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

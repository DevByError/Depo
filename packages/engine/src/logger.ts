import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  dir: string;
  fileName?: string;
  level?: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
  /** Also write to stderr (dev). Stdout is reserved for the ready handshake. */
  stderr?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
  readonly file: string;
}

/**
 * Structured JSON-lines logger with size-based rotation:
 * engine.log -> engine.1.log -> … -> engine.<maxFiles>.log (oldest deleted).
 * Writes are synchronous so nothing is lost on crash. Secrets are redacted.
 */
export function createLogger(opts: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const file = path.join(opts.dir, opts.fileName ?? "engine.log");
  const minLevel = LEVELS[opts.level ?? "info"];
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 5;

  const rotateIfNeeded = () => {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    const base = file.replace(/\.log$/, "");
    const oldest = `${base}.${maxFiles}.log`;
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${base}.${i}.log`;
      if (existsSync(from)) renameSync(from, `${base}.${i + 1}.log`);
    }
    renameSync(file, `${base}.1.log`);
  };

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < minLevel) return;
    const record = redact({ ts: new Date().toISOString(), level, msg, ...bindings, ...fields });
    const line = `${JSON.stringify(record, errorReplacer)}\n`;
    try {
      rotateIfNeeded();
      appendFileSync(file, line, "utf8");
    } catch {
      // Logging must never crash the engine (e.g. Defender briefly locking the file).
    }
    if (opts.stderr) process.stderr.write(line);
  };

  return {
    file,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => createLogger(opts, { ...bindings, ...b }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

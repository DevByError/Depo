import fs from "node:fs";
import path from "node:path";

/**
 * A small file that says whether the engine is running and when it last showed a sign of life.
 * A run that ends cleanly marks it stopped; a run that was killed, crashed or froze leaves it
 * "running", so the next start can say when and how the last run ended. Without it a frozen or
 * killed engine just leaves a log that stops, and nobody can tell why.
 */

export interface RunMark {
  pid: number;
  startedAt: string;
  /** The last time the engine was alive (written every few seconds). */
  aliveAt: string;
  /** What it was doing at that time. */
  doing: string;
  clean: boolean;
  /** Why it stopped, when it stopped cleanly. */
  reason?: string;
}

export interface LastRun {
  pid: number;
  startedAt: string;
  aliveAt: string;
  doing: string;
  /** How long it ran before its last sign of life. */
  uptimeMs: number;
}

const FILE = "run.json";

function read(file: string): RunMark | null {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunMark>;
    if (typeof m.pid !== "number" || typeof m.startedAt !== "string" || typeof m.aliveAt !== "string")
      return null;
    return {
      pid: m.pid,
      startedAt: m.startedAt,
      aliveAt: m.aliveAt,
      doing: typeof m.doing === "string" ? m.doing : "",
      clean: m.clean === true,
      ...(typeof m.reason === "string" ? { reason: m.reason } : {}),
    };
  } catch {
    return null;
  }
}

function write(file: string, mark: RunMark): void {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mark));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only or full disk must not stop the engine.
  }
}

export interface RunMarker {
  /** The previous run, when it did not stop cleanly (null otherwise or on the first start). */
  readonly lastRun: LastRun | null;
  /** Record a sign of life and what the engine is doing. */
  alive(doing: string): void;
  /** Mark this run as stopped cleanly. */
  stopped(reason: string): void;
}

export function startRunMark(dir: string, now: () => Date = () => new Date()): RunMarker {
  const file = path.join(dir, FILE);
  const prev = read(file);
  const lastRun: LastRun | null =
    prev && !prev.clean
      ? {
          pid: prev.pid,
          startedAt: prev.startedAt,
          aliveAt: prev.aliveAt,
          doing: prev.doing,
          uptimeMs: Math.max(0, Date.parse(prev.aliveAt) - Date.parse(prev.startedAt)),
        }
      : null;
  const startedAt = now().toISOString();
  let doing = "starting";
  write(file, { pid: process.pid, startedAt, aliveAt: startedAt, doing, clean: false });
  return {
    lastRun,
    alive(d) {
      doing = d;
      write(file, { pid: process.pid, startedAt, aliveAt: now().toISOString(), doing, clean: false });
    },
    stopped(reason) {
      write(file, { pid: process.pid, startedAt, aliveAt: now().toISOString(), doing, clean: true, reason });
    },
  };
}

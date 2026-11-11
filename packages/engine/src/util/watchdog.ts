import { Worker } from "node:worker_threads";
import type { Logger } from "../logger";

/**
 * Notices when the engine stops answering. Two parts:
 * - A stall meter on the engine's own thread: a timer that should tick every `tickMs` measures how
 *   late it fires. A delay of `stallMs` or more is logged with what the engine was doing, and the
 *   heartbeat reports the worst delay since the last beat.
 * - A watcher on its own thread, for a freeze that never ends: the engine thread writes a time and
 *   a line about what it is doing into shared memory on every tick; when the time stops moving for
 *   `blockedMs`, the watcher writes "the engine is not responding" (and what it was doing) straight
 *   into the log file, again every 30 s, and "responding again" when it recovers. A stuck engine
 *   cannot log for itself, so this is how a freeze leaves a trace.
 */

export interface WatchdogOptions {
  logger: Logger;
  /** The engine log file the watcher appends to; null = no watcher thread (tests, no log dir). */
  logFile: string | null;
  /** What the engine is doing right now: calls in progress, running tasks, the latest event. */
  activity: () => string;
  tickMs?: number;
  stallMs?: number;
  blockedMs?: number;
}

export interface Watchdog {
  /** Worst timer delay since the last call, in ms (the heartbeat reports it). */
  takeLag(): number;
  /** Record what the engine is starting now (written at once, before it may block). */
  note(activity: string): void;
  stop(): void;
}

const ACTIVITY_BYTES = 600;

/** The watcher's code: plain JavaScript run as an eval'd worker (works in the compiled engine too). */
const WATCHER = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new BigInt64Array(workerData.beat);
const len = new Int32Array(workerData.len);
const text = new Uint8Array(workerData.text);
const decoder = new TextDecoder();
let since = 0;
let lastWrite = 0;
const doing = () => decoder.decode(text.slice(0, Math.min(Atomics.load(len, 0), text.length)));
const write = (level, msg, blockedMs) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component: "watchdog", msg, blockedMs, doing: doing() });
  try { fs.appendFileSync(workerData.file, line + "\\n", "utf8"); } catch {}
};
setInterval(() => {
  const last = Number(Atomics.load(beat, 0));
  const now = Date.now();
  const quiet = now - last;
  if (quiet >= workerData.blockedMs) {
    if (!since) { since = last; lastWrite = now; write("error", "the engine is not responding", quiet); }
    else if (now - lastWrite >= 30000) { lastWrite = now; write("error", "the engine is still not responding", quiet); }
  } else if (since) {
    write("warn", "the engine is responding again", last - since);
    since = 0;
  }
}, Math.max(200, Math.floor(workerData.blockedMs / 5)));
`;

export function startWatchdog(o: WatchdogOptions): Watchdog {
  const tickMs = Math.max(20, o.tickMs ?? 250);
  const stallMs = Math.max(tickMs, o.stallMs ?? 1000);
  const blockedMs = Math.max(500, o.blockedMs ?? 5000);
  const log = o.logger.child({ component: "watchdog" });
  const beat = new BigInt64Array(new SharedArrayBuffer(8));
  const len = new Int32Array(new SharedArrayBuffer(4));
  const text = new Uint8Array(new SharedArrayBuffer(ACTIVITY_BYTES));
  const encoder = new TextEncoder();
  let current = "";
  const note = (activity: string) => {
    current = activity;
    const { written } = encoder.encodeInto(activity, text);
    Atomics.store(len, 0, written);
  };
  const stamp = () => Atomics.store(beat, 0, BigInt(Date.now()));
  stamp();

  let worker: Worker | null = null;
  if (o.logFile) {
    try {
      worker = new Worker(WATCHER, {
        eval: true,
        workerData: {
          beat: beat.buffer,
          len: len.buffer,
          text: text.buffer,
          file: o.logFile,
          blockedMs,
        },
      });
      worker.unref();
      worker.on("error", (err) => log.warn("the freeze watcher stopped", { err }));
    } catch (err) {
      log.warn("could not start the freeze watcher", { err });
      worker = null;
    }
  }

  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = Math.max(0, now - last - tickMs);
    last = now;
    if (late > worst) worst = late;
    if (late >= stallMs) {
      // What it was doing when it blocked: the activity noted before this late tick.
      log.warn("the engine was blocked", { blockedMs: Math.round(late), doing: current });
    }
    note(o.activity());
    stamp();
  }, tickMs);
  timer.unref?.();

  return {
    takeLag() {
      const w = Math.round(worst);
      worst = 0;
      return w;
    },
    note(activity) {
      note(activity);
      stamp();
    },
    stop() {
      clearInterval(timer);
      void worker?.terminate();
      worker = null;
    },
  };
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachJob, type JobHandle } from "./winjob";

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra environment variables. Depo's own secrets are always removed. */
  env?: Record<string, string>;
  /** Called with output chunks as they arrive (stdout and stderr interleaved). */
  onOutput?: (chunk: string) => void;
  /** Cap for the kept output; the middle is dropped beyond it. */
  maxOutputBytes?: number;
  /** Windows: memory cap for the whole process tree. */
  memoryLimitBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** How the process tree was contained: `job` (Windows Job Object), `group` (POSIX), or `none`. */
  containment: "job" | "group" | "none";
}

const HIDDEN_ENV = /^(DEPO_ENGINE_TOKEN|DEPO_.*SECRET.*|.*_TOKEN|.*_SECRET|.*_PASSWORD|.*API_KEY.*)$/i;

let shimDir: string | null | undefined;

/**
 * When Bun is not installed, Depo's engine (a compiled Bun) stands in for it: small `bun` and
 * `bunx` launchers that run the engine with BUN_BE_BUN=1, in a folder put first on PATH. So
 * `bun install`, `bun run dev` and `bunx` work on a PC that only has Depo. Null when a real Bun is
 * on PATH (or the engine is not a compiled Bun).
 */
export function bunShimDir(): string | null {
  if (shimDir !== undefined && (shimDir === null || fs.existsSync(shimDir))) return shimDir;
  const exe = process.execPath;
  const isBun = /[\\/]bun(-[a-z0-9-]+)?(\.exe)?$/i.test(exe);
  if (Bun.which("bun")) shimDir = null;
  else if (isBun)
    shimDir = path.dirname(exe); // a real Bun that is not on PATH (tests, dev)
  else if (!/depo-engine/i.test(path.basename(exe))) shimDir = null;
  else {
    const dir = path.join(
      os.tmpdir(),
      `depo-bun-${createHash("sha256").update(exe).digest("hex").slice(0, 10)}`,
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(dir, "bun.cmd"), `@echo off\r\nset BUN_BE_BUN=1\r\n"${exe}" %*\r\n`);
        fs.writeFileSync(path.join(dir, "bunx.cmd"), `@echo off\r\nset BUN_BE_BUN=1\r\n"${exe}" x %*\r\n`);
      } else {
        const q = exe.replace(/'/g, "'\\''");
        fs.writeFileSync(path.join(dir, "bun"), `#!/bin/sh\nBUN_BE_BUN=1 exec '${q}' "$@"\n`, {
          mode: 0o755,
        });
        fs.writeFileSync(path.join(dir, "bunx"), `#!/bin/sh\nBUN_BE_BUN=1 exec '${q}' x "$@"\n`, {
          mode: 0o755,
        });
      }
      shimDir = dir;
    } catch {
      shimDir = null;
    }
  }
  return shimDir;
}

/** The environment with the Bun launchers' folder first on PATH (when they are needed). */
function withBun(env: Record<string, string>): Record<string, string> {
  const dir = bunShimDir();
  if (!dir) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = (env[key] ?? "").split(sep);
  if (parts.includes(dir)) return env;
  return { ...env, [key]: [dir, ...parts].filter(Boolean).join(sep) };
}

export function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(withBun(process.env as Record<string, string>)))
    if (v !== undefined && !HIDDEN_ENV.test(k)) env[k] = v;
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/** Keep the head and tail of long output; the middle is usually the least useful part. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private readonly max: number) {}
  push(s: string) {
    if (this.head.length < this.max / 2) {
      const room = this.max / 2 - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.tail += s;
    if (this.tail.length > this.max / 2) {
      const cut = this.tail.length - this.max / 2;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }
  text(): { output: string; truncated: boolean } {
    if (!this.dropped) return { output: this.head + this.tail, truncated: false };
    return {
      output: `${this.head}\n… [${this.dropped} characters omitted] …\n${this.tail}`,
      truncated: true,
    };
  }
}

/**
 * Run a shell command (cmd.exe on Windows, /bin/sh elsewhere) with a timeout, cancellation,
 * and whole-tree kill. stdin is closed so nothing can wait for keyboard input.
 */
export async function runShell(o: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const { proc, job, containment, killTree } = await spawnContained(o);

  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, o.timeoutMs ?? 120_000);
  const onAbort = () => {
    cancelled = true;
    killTree();
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });

  const buf = new OutputBuffer(o.maxOutputBytes ?? 200_000);
  const onChunk = (s: string) => {
    buf.push(s);
    o.onOutput?.(s);
  };
  // Output pipes stay open while grandchildren hold them; once the shell exits and the tree is
  // gone they close. Wait for exit first, then give the pipes a moment to drain.
  const pumps = Promise.all([pump(proc.stdout, onChunk), pump(proc.stderr, onChunk)]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  // Anything the command left running in the background is stopped with it.
  killTree();
  job?.close();
  await Promise.race([pumps, Bun.sleep(2000)]);
  const { output, truncated } = buf.text();
  return {
    exitCode: timedOut || cancelled ? null : exitCode,
    output: output.replace(/\r\n/g, "\n"),
    truncated,
    timedOut,
    cancelled,
    durationMs: Math.round(performance.now() - started),
    containment,
  };
}

type Spawned = {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  job: JobHandle | null;
  containment: RunResult["containment"];
  /** Kill the whole process tree. Synchronous, safe to call more than once. */
  killTree: () => void;
};

/**
 * The shell command line for `command`: cmd.exe on Windows, /bin/sh elsewhere. With `/s /c` and
 * verbatim arguments, cmd.exe strips exactly the outer quotes added here, so quoted paths with
 * spaces inside the command (`"C:\My Tools\x.exe" --flag`) stay intact.
 */
export function shellArgv(command: string, win = process.platform === "win32"): string[] {
  return win ? ["cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["/bin/sh", "-c", command];
}

/** Start `command` in a shell with its own Job Object (Windows) or process group (elsewhere). */
async function spawnContained(o: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  memoryLimitBytes?: number;
}): Promise<Spawned> {
  const win = process.platform === "win32";
  const argv = shellArgv(o.command, win);
  const proc = Bun.spawn(argv, {
    cwd: o.cwd,
    env: commandEnv(o.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    windowsVerbatimArguments: win,
    detached: !win,
  });

  let job: JobHandle | null = null;
  let containment: RunResult["containment"] = win ? "none" : "group";
  if (win) {
    job = await attachJob(proc.pid, o.memoryLimitBytes);
    if (job) containment = "job";
  }
  const killTree = () => {
    if (job) job.terminate(1);
    else if (win) Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { windowsHide: true });
    else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  };
  return { proc, job, containment, killTree };
}

async function pump(stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      const s = decoder.decode(chunk, { stream: true });
      if (s) onChunk(s);
    }
  } catch {
    // the pipe broke when the tree was killed
  }
  const rest = decoder.decode();
  if (rest) onChunk(rest);
}

export interface ShellProcess {
  pid: number;
  containment: RunResult["containment"];
  /** Resolves with the exit code once the shell has exited and its tree is gone (null when killed). */
  exited: Promise<number | null>;
  /** Kill the whole process tree now. Synchronous; safe to call more than once. */
  kill(): void;
}

/**
 * Start a long-running command (a dev server) without waiting for it: same shell, environment
 * and containment as `runShell`, with stdout and stderr delivered separately. The caller must
 * call `kill()` when done; anything the command leaves behind is killed when it exits.
 */
export async function startShell(o: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  memoryLimitBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<ShellProcess> {
  const { proc, job, containment, killTree } = await spawnContained(o);
  let killed = false;
  const kill = () => {
    killed = true;
    killTree();
  };
  const pumps = Promise.all([
    pump(proc.stdout, (s) => o.onStdout?.(s.replace(/\r\n/g, "\n"))),
    pump(proc.stderr, (s) => o.onStderr?.(s.replace(/\r\n/g, "\n"))),
  ]);
  const exited = (async () => {
    const code = await proc.exited;
    killTree();
    job?.close();
    await Promise.race([pumps, Bun.sleep(2000)]);
    return killed ? null : code;
  })();
  return { pid: proc.pid, containment, exited, kill };
}

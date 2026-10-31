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

export function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HIDDEN_ENV.test(k)) env[k] = v;
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
  const win = process.platform === "win32";
  const argv = win ? ["cmd.exe", "/d", "/s", "/c", `"${o.command}"`] : ["/bin/sh", "-c", o.command];
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

  let timedOut = false;
  let cancelled = false;
  const killTree = () => {
    if (job) job.terminate(1);
    else if (win) Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { windowsHide: true });
    else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  };
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
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const s = decoder.decode(chunk, { stream: true });
      if (!s) continue;
      buf.push(s);
      o.onOutput?.(s);
    }
    const rest = decoder.decode();
    if (rest) {
      buf.push(rest);
      o.onOutput?.(rest);
    }
  };
  // Output pipes stay open while grandchildren hold them; once the shell exits and the tree is
  // gone they close. Wait for exit first, then give the pipes a moment to drain.
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
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

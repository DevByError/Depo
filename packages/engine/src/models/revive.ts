import { ModelGatewayError, type ModelProvider } from "@depo/model-gateway";
import { getLogger } from "../logger";

/**
 * When the local model runtime falls over mid-task. A refused connection means nothing listens
 * (Ollama is not running: Depo starts `ollama serve` once, when it is installed); a dropped one
 * means it crashed or ran out of memory while answering (on a 4 GB GPU, usually a context too big
 * for the card). A crashed or hung model process (Ollama still answers, its runner does not) is
 * unloaded so the next call starts a fresh one. Depo waits for the runtime to answer again and,
 * after a second crash, asks for a smaller context so the next try fits.
 */

const log = getLogger({ component: "models" });

export type Fall = "refused" | "dropped" | "crashed" | null;

/** What kind of fall a model call error is (null: not a runtime failure). */
export function fallOf(err: unknown): Fall {
  if (!(err instanceof ModelGatewayError)) return null;
  const text = `${err.message} ${err.detail ?? ""}`;
  if (err.kind === "unreachable") {
    if (/ECONNREFUSED|ConnectionRefused|refused|not running/i.test(text)) return "refused";
    if (/ENETUNREACH|EHOSTUNREACH/i.test(text)) return null;
    // Includes a connection that timed out: the runtime is there but stuck or swamped.
    return "dropped";
  }
  if (err.kind === "http" && (err.status ?? 0) >= 500) return RUNNER_DOWN.test(text) ? "crashed" : null;
  return null;
}

/**
 * Ollama answering 500 because its model process died or hangs: out of memory, or the server
 * cannot reach the runner any more (`Post "http://127.0.0.1:50574/tokenize": dial tcp …:
 * connectex: … did not properly respond`, `…/completion": EOF`, `wsarecv: … forcibly closed`).
 */
const RUNNER_DOWN =
  /runner process (has )?terminated|out of memory|CUDA error|cudaMalloc|failed to allocate|exit status|signal: killed|dial tcp|connectex|wsarecv|forcibly closed|did not properly respond|connection reset|\/(tokenize|detokenize|completion|embedding|health)"?: |": EOF/i;

/** A context about half as big (never below 4096 tokens), rounded to 1024. */
export function smallerContext(n: number): number {
  return Math.max(4096, Math.floor((n * 0.5) / 1024) * 1024);
}

function isLocal(baseUrl: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

let lastStart = 0;

/** Start `ollama serve` in the background (at most once every five minutes). */
export function startOllama(): boolean {
  if (Date.now() - lastStart < 5 * 60_000) return false;
  const exe = Bun.which("ollama");
  if (!exe) return false;
  lastStart = Date.now();
  try {
    const proc = Bun.spawn([exe, "serve"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    proc.unref();
    log.info("started ollama serve", { exe });
    return true;
  } catch (err) {
    log.warn("could not start ollama serve", { err });
    return false;
  }
}

/**
 * Wait until the runtime answers its health check again (true), or the time runs out or the task
 * is stopped (false). A local Ollama that refuses connections is started first.
 */
export async function waitForRuntime(
  provider: Pick<ModelProvider, "health" | "kind" | "baseUrl">,
  o: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number; start?: () => boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  let started = false;
  while (Date.now() < deadline) {
    if (o.signal?.aborted) return false;
    try {
      const h = await provider.health(AbortSignal.timeout(5000));
      if (h.ok) return true;
    } catch {
      // not up yet
    }
    if (!started && provider.kind === "ollama" && isLocal(provider.baseUrl)) {
      started = true;
      (o.start ?? startOllama)();
    }
    await Bun.sleep(o.pollMs ?? 2000);
  }
  return false;
}

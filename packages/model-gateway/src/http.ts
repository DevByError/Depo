import { ModelGatewayError, providerLabel } from "./errors";

export interface FetchOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  kind: string;
}

/** fetch with JSON body, a timeout, and errors turned into friendly ModelGatewayErrors. */
export async function request(url: string, opts: FetchOptions): Promise<Response> {
  // The timeout covers waiting for response headers only. A streamed body can legitimately run
  // for many minutes; idle gaps in the body are policed separately by readLines.
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new DOMException("timed out", "TimeoutError")),
    opts.timeoutMs ?? 30_000,
  );
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (err) {
    throw toGatewayError(err, opts.kind, opts.signal);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ModelGatewayError(
      "http",
      `${providerLabel(opts.kind)} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      res.status,
      text,
    );
  }
  return res;
}

export function toGatewayError(err: unknown, kind: string, userSignal?: AbortSignal): ModelGatewayError {
  if (err instanceof ModelGatewayError) return err;
  if (userSignal?.aborted) return new ModelGatewayError("cancelled", "Cancelled");
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ModelGatewayError("timeout", `${providerLabel(kind)} did not respond in time.`);
  }
  const cause = describeCause(err);
  // A refused connection means nothing is listening; anything else (reset, closed socket) means
  // the runtime was there but dropped the request, usually because it crashed or ran out of memory.
  const refused = /ECONNREFUSED|ConnectionRefused|refused/i.test(cause);
  return new ModelGatewayError(
    "unreachable",
    refused
      ? `${providerLabel(kind)} is not running or not reachable. Start it and try again.`
      : `${providerLabel(kind)} dropped the connection (${cause}). It may have run out of memory or restarted; check its log, or try a smaller model.`,
    undefined,
    cause,
  );
}

function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const parts = [typeof code === "string" ? code : "", err.message].filter(Boolean);
  return parts.join(": ").slice(0, 200) || err.name;
}

/**
 * Read a streaming body line by line. Each chunk read resets an idle timer, so slow model
 * loading is fine but a stalled stream fails. Handles CRLF and partial UTF-8 sequences.
 */
export async function* readLines(
  res: Response,
  opts: { signal?: AbortSignal; idleTimeoutMs: number; kind: string },
): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const next = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ModelGatewayError("timeout", `${providerLabel(opts.kind)} stopped responding.`)),
          opts.idleTimeoutMs,
        );
      });
      const aborted = new Promise<never>((_, reject) => {
        if (!opts.signal) return;
        if (opts.signal.aborted) reject(new ModelGatewayError("cancelled", "Cancelled"));
        opts.signal.addEventListener("abort", () => reject(new ModelGatewayError("cancelled", "Cancelled")), {
          once: true,
        });
      });
      let r: Awaited<typeof next>;
      try {
        r = await Promise.race([next, idle, aborted]);
      } finally {
        clearTimeout(timer);
      }
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.length > 0) yield line;
        idx = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf.trim().length > 0) yield buf.trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function parseJsonArgs(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

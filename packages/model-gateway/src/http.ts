import http from "node:http";
import { Readable } from "node:stream";
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
      // No connection reuse: a runtime that closed an idle kept-alive socket would otherwise make
      // the next request fail as "dropped". Local requests are cheap to open.
      keepalive: false,
    });
  } catch (err) {
    clearTimeout(timer);
    const first = toGatewayError(err, opts.kind, opts.signal);
    if (!isConnectFailure(first)) throw first;
    // fetch could not open a connection. Some Windows PCs (security software, loopback filters)
    // block one HTTP stack but not another, so try once more over node:http before giving up.
    try {
      res = await nodeRequest(url, opts);
    } catch (err2) {
      const second = toGatewayError(err2, opts.kind, opts.signal);
      if (second.kind === "cancelled") throw second;
      const alive = await probe(url);
      throw new ModelGatewayError(
        first.kind,
        `${first.message} ${
          alive
            ? `${providerLabel(opts.kind)} did answer a quick check just now, so the connection from Depo is being blocked or dropped; check firewall or antivirus rules for depo-engine.exe.`
            : `${providerLabel(opts.kind)} did not answer a quick check either.`
        }`,
        first.status,
        first.detail,
      );
    }
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

function isConnectFailure(e: ModelGatewayError): boolean {
  const d = e.detail ?? "";
  return (
    e.kind === "unreachable" &&
    !/ECONNREFUSED|ConnectionRefused|refused/i.test(d) &&
    /Unable to connect|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNRESET/i.test(d)
  );
}

/** The same request over node:http, returned as a fetch Response (body streamed). */
export function nodeRequest(url: string, opts: FetchOptions): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      url,
      {
        method: opts.method ?? (body === undefined ? "GET" : "POST"),
        headers:
          body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        agent: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (msg) => {
        clearTimeout(timer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(msg.headers)) if (typeof v === "string") headers.set(k, v);
        resolve(
          new Response(Readable.toWeb(msg) as unknown as ReadableStream<Uint8Array>, {
            status: msg.statusCode ?? 500,
            headers,
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new DOMException("timed out", "TimeoutError")),
      opts.timeoutMs ?? 30_000,
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Does anything answer at this URL's origin within 3 seconds? */
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/", url), { signal: AbortSignal.timeout(3000), keepalive: false });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
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
  const noConnect = /Unable to connect|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(cause);
  return new ModelGatewayError(
    "unreachable",
    refused
      ? `${providerLabel(kind)} is not running or not reachable. Start it and try again.`
      : noConnect
        ? `Could not connect to ${providerLabel(kind)} in time (${cause}). It may be busy loading a model or stuck; check that it is running, or restart it.`
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

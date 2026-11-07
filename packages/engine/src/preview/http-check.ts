/**
 * HTTP smoke checks against the app a preview runs. Only loopback addresses are allowed: an
 * agent must never use this to reach the internet or the local network.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/** The parsed URL when it points at this computer (127.0.0.0/8, ::1 or localhost), else null. */
export function loopbackUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  // The URL parser has already normalised forms such as 127.1, 0x7f.0.0.1 and 2130706433.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return u;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((p) => Number(p) <= 255)) return u;
  return null;
}

export interface HttpCheckRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Sent as JSON (Content-Type: application/json unless a header says otherwise). */
  json?: unknown;
  timeoutMs?: number;
}

export interface HttpCheckResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The start of the body (text), at most `maxBody` characters. */
  body: string;
  bodyTruncated: boolean;
  durationMs: number;
}

const SHOWN_HEADERS = [
  "content-type",
  "content-length",
  "location",
  "cache-control",
  "access-control-allow-origin",
  "www-authenticate",
  "allow",
];

export class HttpCheckError extends Error {}

/** One request to a loopback URL. Redirects are reported, never followed. */
export async function httpCheck(req: HttpCheckRequest, maxBody = 4000): Promise<HttpCheckResult> {
  const u = loopbackUrl(req.url);
  if (!u)
    throw new HttpCheckError(
      `Refused: ${req.url} is not a local address. Only http://127.0.0.1, http://localhost and http://[::1] can be checked.`,
    );
  const method = req.method ?? "GET";
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.json !== undefined && method !== "GET" && method !== "HEAD") {
    body = JSON.stringify(req.json);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/json";
  }
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(u, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(req.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpCheckError(
      /abort|timeout/i.test(msg)
        ? `No answer from ${u.origin} within ${Math.round((req.timeoutMs ?? 10_000) / 1000)}s.`
        : `Could not connect to ${u.origin}: ${msg}. Is the app running? Start it with start_preview.`,
    );
  }
  const shown: Record<string, string> = {};
  for (const h of SHOWN_HEADERS) {
    const v = res.headers.get(h);
    if (v) shown[h] = v.slice(0, 300);
  }
  let text = "";
  let truncated = false;
  if (method !== "HEAD" && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const limit = maxBody * 4;
    try {
      while (text.length < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      if (text.length >= limit) truncated = true;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (text.length > maxBody) {
    text = text.slice(0, maxBody);
    truncated = true;
  }
  return {
    ok: res.status < 400,
    status: res.status,
    statusText: res.statusText,
    headers: shown,
    body: text,
    bodyTruncated: truncated,
    durationMs: Math.round(performance.now() - t0),
  };
}

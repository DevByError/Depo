/** Small helpers for JSON APIs: one error format everywhere, and a body size limit. */

export interface ApiError {
  error: { code: string; message: string; fields?: Record<string, string> };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}

export function fail(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): Response {
  const body: ApiError = { error: { code, message, ...(fields ? { fields } : {}) } };
  return json(status, body);
}

export class BadRequest extends Error {}

/** The request's JSON body (at most 16 KB). */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new BadRequest("Send JSON (content-type: application/json).");
  const text = await req.text();
  if (text.length > maxBytes) throw new BadRequest("The request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("The request body is not valid JSON.");
  }
}

/** The caller's address, for rate limits (the dev proxy and Bun set these). */
export function clientKey(req: Request, server?: { requestIP(r: Request): { address: string } | null }): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || server?.requestIP(req)?.address || "local";
}

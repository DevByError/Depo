/** Calls to the API through the web app's /api proxy (same origin, so the cookie is sent). */

export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "offline", "The server cannot be reached. Is the API running?");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error: { code: string; message: string; fields?: Record<string, string> } }
    | null;
  if (!res.ok || !data || data.error) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? "Something went wrong.", e?.fields ?? {});
  }
  return data as T;
}

export const api = {
  register: (input: { name: string; email: string; password: string }) =>
    request<{ user: User }>("POST", "/auth/register", input).then((r) => r.user),
  login: (input: { email: string; password: string }) =>
    request<{ user: User }>("POST", "/auth/login", input).then((r) => r.user),
  logout: () => request<void>("POST", "/auth/logout"),
  /** The signed-in user, or null when signed out. */
  me: () => request<{ user: User | null }>("GET", "/auth/me").then((r) => r.user),
};

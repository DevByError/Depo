/**
 * The API client: JSON in and out, the sign-in token, timeouts, and the API's error format
 * ({"error": {"code", "message", "details": [{"field", "message"}]}}) turned into ApiError.
 * Screens never call fetch directly; they call the typed functions in features/<name>/api.ts.
 */

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: FieldError[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field messages keyed by field name, for showing them next to the inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details) if (!out[d.field]) out[d.field] = d.message;
    return out;
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiClientOptions {
  /** Where the API is; "" means the same origin (the dev server passes /api on). */
  baseUrl?: string;
  getToken?: () => string | null;
  /** Called when the API answers 401: the session has ended. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function queryString(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: FieldError[] };
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Query; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const token = options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort);
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(`${base}${path}${queryString(init.query)}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      const timedOut = controller.signal.aborted;
      throw new ApiError(
        timedOut
          ? "The server took too long to answer. Try again."
          : "Could not reach the server. Check your connection and try again.",
        0,
        timedOut ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }

    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) options.onUnauthorized?.();
      const error = (data as ErrorBody | null)?.error;
      throw new ApiError(
        error?.message ?? `The server answered with an error (${res.status}).`,
        res.status,
        error?.code ?? "http_error",
        Array.isArray(error?.details) ? error.details : [],
      );
    }
    return data as T;
  }

  return {
    get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
      request<T>("GET", path, { query, ...(signal ? { signal } : {}) }),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, { body }),
    del: (path: string) => request<void>("DELETE", path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

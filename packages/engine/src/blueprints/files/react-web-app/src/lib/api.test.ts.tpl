import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, queryString } from "./api";

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the API client", () => {
  it("sends JSON with the token and returns the parsed body", async () => {
    const fetch = vi.fn(async () => reply(201, { id: 7, name: "Launch" }));
    const api = createApiClient({ baseUrl: "http://api.test/", getToken: () => "tok", fetch });
    const created = await api.post<{ id: number }>("/api/projects", { name: "Launch" });
    expect(created.id).toBe(7);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/projects");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Launch" }));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("builds query strings without empty values", async () => {
    expect(queryString({ page: 2, q: "a b", status: "", sort: undefined, x: null })).toBe("?page=2&q=a+b");
    expect(queryString({})).toBe("");
    const fetch = vi.fn(async () => reply(200, { items: [] }));
    await createApiClient({ fetch }).get("/api/projects", { page: 1, q: "" });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("/api/projects?page=1");
  });

  it("turns the API's error format into an ApiError with field messages", async () => {
    const fetch = vi.fn(async () =>
      reply(422, {
        error: {
          code: "validation_error",
          message: "Some fields are not valid.",
          details: [
            { field: "name", message: "Enter a name." },
            { field: "name", message: "Second message is ignored." },
            { field: "status", message: "Pick a status." },
          ],
        },
      }),
    );
    const err = await createApiClient({ fetch })
      .post("/api/projects", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("validation_error");
    expect(apiError.message).toBe("Some fields are not valid.");
    expect(apiError.fieldErrors()).toEqual({ name: "Enter a name.", status: "Pick a status." });
  });

  it("tells the app when the session has ended (401)", async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi.fn(async () => reply(401, { error: { code: "unauthorized", message: "Sign in first." } }));
    const err = await createApiClient({ fetch, onUnauthorized })
      .get("/api/auth/me")
      .catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect((err as ApiError).message).toBe("Sign in first.");
  });

  it("handles 204, bodies that are not JSON, and network failures", async () => {
    const empty = createApiClient({ fetch: vi.fn(async () => new Response(null, { status: 204 })) });
    expect(await empty.del("/api/projects/1")).toBeUndefined();

    const html = createApiClient({ fetch: vi.fn(async () => new Response("<h1>Bad gateway</h1>", { status: 502 })) });
    const bad = (await html.get("/api/projects").catch((e: unknown) => e)) as ApiError;
    expect(bad.status).toBe(502);
    expect(bad.message).toContain("502");

    const offline = createApiClient({
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const down = (await offline.get("/api/projects").catch((e: unknown) => e)) as ApiError;
    expect(down.code).toBe("network_error");
    expect(down.message).toContain("Could not reach the server");
  });

  it("gives up after the timeout", async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const api = createApiClient({ fetch: hang as unknown as typeof fetch, timeoutMs: 20 });
    const err = (await api.get("/api/slow").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("timeout");
  });
});

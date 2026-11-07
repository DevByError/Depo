import { afterEach, describe, expect, test } from "bun:test";
import {
  collectChat,
  keepAliveSeconds,
  normalizeKeepAlive,
  OllamaProvider,
  OpenAICompatibleProvider,
  ollamaKeepAlive,
} from "../src/index";

type Handler = (req: Request, url: URL) => Response | Promise<Response>;
const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: Handler): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(req, new URL(req.url)) });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("keep-alive values", () => {
  test("valid values are normalised and invalid ones refused", () => {
    expect(normalizeKeepAlive("30m")).toBe("30m");
    expect(normalizeKeepAlive(" 2H ")).toBe("2h");
    expect(normalizeKeepAlive("-1")).toBe("-1");
    expect(normalizeKeepAlive("0")).toBe("0");
    expect(normalizeKeepAlive(-1)).toBe("-1");
    expect(normalizeKeepAlive(300)).toBe("300s");
    for (const bad of ["", "forever", "5", "5 m", "-5m", "1.5h", "05m", "1d", null, true, 1.5, "1000000h"]) {
      expect(normalizeKeepAlive(bad)).toBeNull();
    }
  });

  test("seconds and the form Ollama accepts", () => {
    expect(keepAliveSeconds("5m")).toBe(300);
    expect(keepAliveSeconds("2h")).toBe(7200);
    expect(keepAliveSeconds("90s")).toBe(90);
    expect(keepAliveSeconds("0")).toBe(0);
    expect(keepAliveSeconds("-1")).toBeNull();
    // Ollama cannot parse the string "-1" as a duration, so forever and "now" go as numbers.
    expect(ollamaKeepAlive("-1")).toBe(-1);
    expect(ollamaKeepAlive("0")).toBe(0);
    expect(ollamaKeepAlive("30m")).toBe("30m");
    expect(ollamaKeepAlive("soon")).toBeUndefined();
  });
});

describe("Ollama: keeping models loaded and timings", () => {
  test("chat sends keep_alive and reads load, prompt and writing times", async () => {
    let body: Record<string, unknown> = {};
    const base = serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return ndjson([
        { message: { content: "ok" } },
        {
          done: true,
          done_reason: "stop",
          prompt_eval_count: 1200,
          prompt_eval_duration: 2_000_000_000,
          eval_count: 40,
          eval_duration: 4_000_000_000,
          load_duration: 6_500_000_000,
          total_duration: 12_600_000_000,
        },
      ]);
    });
    const res = await collectChat(
      new OllamaProvider("ollama", base).chat({
        model: "qwen2.5-coder:7b",
        messages: [{ role: "user", content: "hi" }],
        contextLength: 16384,
        keepAlive: "30m",
      }),
    );
    expect(body.keep_alive).toBe("30m");
    expect(body.options).toEqual({ num_ctx: 16384 });
    expect(res.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 40,
      durationMs: 4000,
      loadMs: 6500,
      promptMs: 2000,
    });
  });

  test('"until Depo closes" is sent as -1 and no keep_alive is sent when none is asked', async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = serve(async (req) => {
      bodies.push((await req.json()) as Record<string, unknown>);
      return ndjson([{ done: true, prompt_eval_count: 1, eval_count: 1 }]);
    });
    const p = new OllamaProvider("ollama", base);
    await collectChat(p.chat({ model: "m", messages: [], keepAlive: "-1" }));
    await collectChat(p.chat({ model: "m", messages: [] }));
    expect(bodies[0]?.keep_alive).toBe(-1);
    expect("keep_alive" in (bodies[1] ?? {})).toBe(false);
  });

  test("preload is an empty generate with num_ctx and keep_alive; unload and loaded models", async () => {
    const seen: { path: string; body: Record<string, unknown> | null }[] = [];
    const base = serve(async (req, url) => {
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null;
      seen.push({ path: url.pathname, body });
      if (url.pathname === "/api/generate") {
        return Response.json({ done: true, done_reason: "load", load_duration: 3_250_000_000 });
      }
      if (url.pathname === "/api/ps") {
        return Response.json({
          models: [
            {
              name: "qwen2.5-coder:7b",
              model: "qwen2.5-coder:7b",
              size_vram: 4_000_000_000,
              expires_at: "2026-11-07T12:00:00Z",
              context_length: 16384,
            },
            { model: "nomic-embed-text:latest" },
          ],
        });
      }
      return new Response("nope", { status: 404 });
    });
    const p = new OllamaProvider("ollama", base);
    expect(await p.preload("qwen2.5-coder:7b", { contextLength: 16384, keepAlive: "2h" })).toEqual({
      loadMs: 3250,
    });
    expect(seen[0]).toEqual({
      path: "/api/generate",
      body: {
        model: "qwen2.5-coder:7b",
        prompt: "",
        stream: false,
        options: { num_ctx: 16384 },
        keep_alive: "2h",
      },
    });
    await p.unload("qwen2.5-coder:7b");
    expect(seen[1]?.body).toMatchObject({ model: "qwen2.5-coder:7b", keep_alive: 0 });
    expect(await p.loaded()).toEqual([
      {
        name: "qwen2.5-coder:7b",
        contextLength: 16384,
        sizeVramBytes: 4_000_000_000,
        expiresAt: "2026-11-07T12:00:00Z",
      },
      { name: "nomic-embed-text:latest", contextLength: null, sizeVramBytes: null, expiresAt: null },
    ]);
  });
});

describe("OpenAI-compatible runtimes", () => {
  test("llama.cpp gets cache_prompt and reports its timings, including reused prompt tokens", async () => {
    let body: Record<string, unknown> = {};
    const base = serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return new Response(
        [
          sse({ choices: [{ delta: { content: "hi" } }] }),
          sse({
            choices: [{ delta: {}, finish_reason: "stop" }],
            timings: {
              prompt_n: 120,
              prompt_ms: 400.4,
              predicted_n: 30,
              predicted_ms: 1500.2,
              cache_n: 2048,
            },
          }),
          sse({ choices: [], usage: { prompt_tokens: 2168, completion_tokens: 30 } }),
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
    const res = await collectChat(
      new OpenAICompatibleProvider("lc", "llamacpp", base).chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        keepAlive: "30m",
      }),
    );
    expect(body.cache_prompt).toBe(true);
    expect("ttl" in body).toBe(false);
    expect("keep_alive" in body).toBe(false);
    expect(res.usage).toEqual({
      promptTokens: 2168,
      completionTokens: 30,
      durationMs: 1500,
      promptMs: 400,
      cachedPromptTokens: 2048,
    });
  });

  test("timings alone still give a usage", async () => {
    const base = serve(
      () =>
        new Response(
          [
            sse({
              choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
              timings: { prompt_n: 10, prompt_ms: 50, predicted_n: 4, predicted_ms: 200 },
            }),
            "data: [DONE]\n\n",
          ].join(""),
        ),
    );
    const res = await collectChat(
      new OpenAICompatibleProvider("lc", "llamacpp", base).chat({ model: "m", messages: [] }),
    );
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 4, durationMs: 200, promptMs: 50 });
  });

  test("LM Studio gets a ttl only for a positive keep-alive, and never cache_prompt", async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = serve(async (req) => {
      bodies.push((await req.json()) as Record<string, unknown>);
      return new Response(
        `${sse({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })}data: [DONE]\n\n`,
      );
    });
    const p = new OpenAICompatibleProvider("lm", "lmstudio", base);
    for (const keepAlive of ["2h", "-1", "0", undefined]) {
      await collectChat(
        p.chat({ model: "m", messages: [], ...(keepAlive !== undefined ? { keepAlive } : {}) }),
      );
    }
    expect(bodies.map((b) => b.ttl)).toEqual([7200, undefined, undefined, undefined]);
    expect(bodies.some((b) => "cache_prompt" in b)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type ChatChunk,
  collectChat,
  createProvider,
  extractJson,
  generateObject,
  isLocalUrl,
  ModelGatewayError,
  type ModelProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
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

/** A streaming body that emits each piece with an optional delay between them. */
function stream(pieces: string[], delayMs = 0, hang = false): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(ctl) {
        for (const p of pieces) {
          ctl.enqueue(enc.encode(p));
          if (delayMs) await Bun.sleep(delayMs);
        }
        if (hang) return; // never close
        ctl.close();
      },
    }),
  );
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("OpenAI-compatible provider", () => {
  test("streams text, assembles split tool calls, and reports usage", async () => {
    let body: Record<string, unknown> = {};
    const base = serve(async (req, url) => {
      expect(url.pathname).toBe("/v1/chat/completions");
      body = (await req.json()) as Record<string, unknown>;
      return stream([
        sse({ choices: [{ delta: { content: "Hel" } }] }),
        // a frame split across two network chunks, with CRLF line endings
        "data: ",
        `${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\r\n\r\n`,
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_" } }] } }] }),
        sse({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] } }],
        }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.py"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
        "data: [DONE]\n\n",
      ]);
    });
    const p = new OpenAICompatibleProvider("lm", "lmstudio", base);
    const res = await collectChat(
      p.chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
        temperature: 0.2,
        maxTokens: 50,
      }),
    );
    expect(res.text).toBe("Hello");
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: { path: "a.py" }, rawArguments: '{"path":"a.py"}' },
    ]);
    expect(res.finishReason).toBe("tool_calls");
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
    expect((body.tools as unknown[]).length).toBe(1);
  });

  test("maps assistant tool calls and tool results to the OpenAI wire format", async () => {
    let body: { messages: Record<string, unknown>[] } = { messages: [] };
    const base = serve(async (req) => {
      body = (await req.json()) as typeof body;
      return stream([
        sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]);
    });
    const p = new OpenAICompatibleProvider("lc", "llamacpp", base);
    await collectChat(
      p.chat({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "x", name: "ls", arguments: {}, rawArguments: "{}" }],
          },
          { role: "tool", toolCallId: "x", name: "ls", content: "a.py" },
        ],
      }),
    );
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "x", type: "function", function: { name: "ls", arguments: "{}" } }],
    });
    expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "x", content: "a.py" });
  });

  test("invalid tool-call JSON is kept raw for repair, not thrown", async () => {
    const base = serve(() =>
      stream([
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{bad" } }] } },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const res = await collectChat(
      new OpenAICompatibleProvider("lm", "lmstudio", base).chat({ model: "m", messages: [] }),
    );
    expect(res.toolCalls[0]?.arguments).toBeUndefined();
    expect(res.toolCalls[0]?.rawArguments).toBe("{bad");
    expect(res.finishReason).toBe("tool_calls");
  });

  test("lists models and embeds", async () => {
    const base = serve((_req, url) => {
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "qwen" }, { id: "nomic" }] });
      if (url.pathname === "/v1/embeddings")
        return Response.json({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
        });
      return new Response("no", { status: 404 });
    });
    const p = new OpenAICompatibleProvider("lm", "lmstudio", base);
    expect((await p.listModels()).map((m) => m.name)).toEqual(["qwen", "nomic"]);
    expect(await p.embed("nomic", ["a", "b"])).toEqual([[1], [2]]);
    expect((await p.health()).ok).toBe(true);
  });

  test("HTTP errors carry status and body", async () => {
    const base = serve(() => new Response("model not loaded", { status: 500 }));
    const p = new OpenAICompatibleProvider("lm", "lmstudio", base);
    const err = await drain(p.chat({ model: "m", messages: [] })).catch((e) => e);
    expect(err).toBeInstanceOf(ModelGatewayError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(500);
    expect(err.message).toContain("LM Studio returned 500: model not loaded");
  });
});

describe("Ollama provider", () => {
  test("streams NDJSON chat with tool calls, options, format, and usage", async () => {
    let body: Record<string, unknown> = {};
    const base = serve(async (req, url) => {
      expect(url.pathname).toBe("/api/chat");
      body = (await req.json()) as Record<string, unknown>;
      const lines = [
        { message: { content: "Look" } },
        { message: { content: "ing" } },
        { message: { content: "", tool_calls: [{ function: { name: "grep", arguments: { q: "def" } } }] } },
        { done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 5, eval_duration: 250_000_000 },
      ];
      return stream(lines.map((l) => `${JSON.stringify(l)}\n`));
    });
    const p = new OllamaProvider("ollama", base);
    const res = await collectChat(
      p.chat({
        model: "qwen2.5-coder:7b",
        messages: [
          { role: "system", content: "s" },
          { role: "tool", toolCallId: "call_1", name: "ls", content: "x" },
        ],
        contextLength: 16384,
        temperature: 0,
        maxTokens: 99,
        jsonSchema: { type: "object" },
      }),
    );
    expect(res.text).toBe("Looking");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      name: "grep",
      arguments: { q: "def" },
      rawArguments: '{"q":"def"}',
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.usage).toEqual({ promptTokens: 30, completionTokens: 5, durationMs: 250 });
    expect(body.options).toEqual({ num_ctx: 16384, temperature: 0, num_predict: 99 });
    expect(body.format).toEqual({ type: "object" });
    expect((body.messages as unknown[])[1]).toEqual({ role: "tool", content: "x", tool_name: "ls" });
  });

  test("health, tags, embed, pull progress, delete", async () => {
    const seen: string[] = [];
    const base = serve(async (req, url) => {
      seen.push(`${req.method} ${url.pathname}`);
      switch (url.pathname) {
        case "/api/version":
          return Response.json({ version: "0.12.3" });
        case "/api/tags":
          return Response.json({
            models: [
              {
                name: "qwen2.5-coder:7b",
                size: 4_700_000_000,
                modified_at: "2026-10-01T00:00:00Z",
                details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" },
              },
            ],
          });
        case "/api/embed":
          return Response.json({ embeddings: [[0.1, 0.2]] });
        case "/api/pull":
          return stream([
            `${JSON.stringify({ status: "pulling manifest" })}\n`,
            `${JSON.stringify({ status: "downloading", total: 100, completed: 40 })}\n`,
            `${JSON.stringify({ status: "success" })}\n`,
          ]);
        case "/api/delete":
          return new Response(null, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const p = new OllamaProvider("ollama", base);
    expect(await p.health()).toEqual({ ok: true, version: "0.12.3", message: null });
    expect(await p.listModels()).toEqual([
      {
        name: "qwen2.5-coder:7b",
        sizeBytes: 4_700_000_000,
        family: "qwen2",
        parameterSize: "7.6B",
        quantization: "Q4_K_M",
        modifiedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    expect(await p.embed("nomic-embed-text", ["x"])).toEqual([[0.1, 0.2]]);
    const progress: unknown[] = [];
    await p.pull("qwen2.5-coder:7b", (pr) => progress.push(pr));
    expect(progress).toEqual([
      { status: "pulling manifest", completedBytes: null, totalBytes: null },
      { status: "downloading", completedBytes: 40, totalBytes: 100 },
      { status: "success", completedBytes: null, totalBytes: null },
    ]);
    await p.remove("qwen2.5-coder:7b");
    expect(seen).toContain("DELETE /api/delete");
  });

  test("pull surfaces an error line from Ollama", async () => {
    const base = serve(() =>
      stream([`${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`]),
    );
    const err = await new OllamaProvider("ollama", base).pull("nope:1b", () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ModelGatewayError);
    expect(err.message).toContain("could not download nope:1b");
  });

  test("an error in the chat stream becomes a gateway error", async () => {
    const base = serve(() => stream([`${JSON.stringify({ error: "model requires more system memory" })}\n`]));
    const err = await drain(new OllamaProvider("ollama", base).chat({ model: "m", messages: [] })).catch(
      (e) => e,
    );
    expect(err.kind).toBe("http");
    expect(err.message).toContain("more system memory");
  });
});

describe("failure handling", () => {
  test("unreachable runtime gives an actionable message", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = s.port;
    s.stop(true);
    const p = new OllamaProvider("ollama", `http://127.0.0.1:${port}`);
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.message).toBe("Ollama is not running or not reachable. Start it and try again.");
    const err = await p.listModels().catch((e) => e);
    expect(err.kind).toBe("unreachable");
  });

  test("a stalled stream fails with an idle timeout", async () => {
    const base = serve(() => stream([`${JSON.stringify({ message: { content: "a" } })}\n`], 0, true));
    const p = new OllamaProvider("ollama", base);
    const got: ChatChunk[] = [];
    const err = await (async () => {
      for await (const c of p.chat({ model: "m", messages: [], idleTimeoutMs: 150 })) got.push(c);
    })().catch((e) => e);
    expect(got).toEqual([{ type: "text", delta: "a" }]);
    expect(err.kind).toBe("timeout");
    expect(err.message).toBe("Ollama stopped responding.");
  });

  test("a slow but steady stream is not cut off by the header timeout", async () => {
    const pieces = Array.from(
      { length: 6 },
      (_, i) => `${JSON.stringify({ message: { content: String(i) } })}\n`,
    );
    pieces.push(`${JSON.stringify({ done: true })}\n`);
    const base = serve(() => stream(pieces, 60));
    // idle timeout 200 ms per gap, total stream ~420 ms
    const res = await collectChat(
      new OllamaProvider("ollama", base).chat({ model: "m", messages: [], idleTimeoutMs: 200 }),
    );
    expect(res.text).toBe("012345");
    expect(res.finishReason).toBe("stop");
  });

  test("cancellation stops a stream mid-way", async () => {
    const pieces = Array.from(
      { length: 50 },
      (_, i) => `${JSON.stringify({ message: { content: String(i % 10) } })}\n`,
    );
    const base = serve(() => stream(pieces, 20));
    const ctl = new AbortController();
    let n = 0;
    const err = await (async () => {
      for await (const c of new OllamaProvider("ollama", base).chat({
        model: "m",
        messages: [],
        signal: ctl.signal,
      })) {
        if (c.type === "text" && ++n === 3) ctl.abort();
      }
    })().catch((e) => e);
    expect(err).toBeInstanceOf(ModelGatewayError);
    expect(err.kind).toBe("cancelled");
    expect(n).toBe(3);
  });

  test("an already-aborted signal cancels before connecting", async () => {
    let hits = 0;
    const base = serve(() => {
      hits++;
      return new Response("");
    });
    const ctl = new AbortController();
    ctl.abort();
    const err = await drain(
      new OllamaProvider("ollama", base).chat({ model: "m", messages: [], signal: ctl.signal }),
    ).catch((e) => e);
    expect(err.kind).toBe("cancelled");
    expect(hits).toBe(0);
  });
});

/** Scripted provider: returns the given replies in order and records requests. */
function scripted(replies: string[]): ModelProvider & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    requests,
    health: async () => ({ ok: true, version: "x", message: null }),
    listModels: async () => [],
    embed: async () => [],
    async *chat(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const text = replies.shift() ?? "";
      yield { type: "text", delta: text };
      yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

describe("structured output", () => {
  const Plan = z.object({ steps: z.array(z.string()).min(1), risky: z.boolean() });

  test("valid on the first try, with the schema sent to the runtime", async () => {
    const p = scripted(['{"steps":["edit main.py"],"risky":false}']);
    const r = await generateObject(p, {
      model: "m",
      messages: [{ role: "user", content: "plan" }],
      schema: Plan,
    });
    expect(r.value).toEqual({ steps: ["edit main.py"], risky: false });
    expect(r.attempts).toBe(1);
    const req = p.requests[0] as { jsonSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(req.jsonSchema.properties)).toEqual(["steps", "risky"]);
  });

  test("repairs broken JSON and schema mismatches with the exact error", async () => {
    const p = scripted([
      "{steps: oops",
      '```json\n{"steps":[],"risky":"no"}\n```',
      'Sure! {"steps":["a"],"risky":true} done',
    ]);
    const r = await generateObject(p, {
      model: "m",
      messages: [{ role: "user", content: "plan" }],
      schema: Plan,
    });
    expect(r.value).toEqual({ steps: ["a"], risky: true });
    expect(r.attempts).toBe(3);
    expect(r.usage).toHaveLength(3);
    const last = p.requests[2] as { messages: { role: string; content: string }[] };
    const feedback = last.messages.at(-1)?.content ?? "";
    expect(feedback).toContain("steps:");
    expect(feedback).toContain("risky:");
    expect(last.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  test("gives up after maxRepairs with an invalid_output error", async () => {
    const p = scripted(["nope", "still nope"]);
    const err = await generateObject(p, { model: "m", messages: [], schema: Plan, maxRepairs: 1 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ModelGatewayError);
    expect(err.kind).toBe("invalid_output");
    expect(err.message).toContain("after 2 attempts");
  });

  test("extractJson handles fences, prose, and arrays", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here: {"a":{"b":2}} ok')).toBe('{"a":{"b":2}}');
    expect(extractJson("list [1,2] end")).toBe("[1,2]");
    expect(extractJson("plain")).toBe("plain");
  });
});

describe("registry", () => {
  test("isLocalUrl accepts only loopback and private networks", () => {
    for (const ok of [
      "http://127.0.0.1:11434",
      "http://localhost:1234",
      "http://[::1]:8080",
      "http://192.168.1.20:11434",
      "http://10.0.0.5",
      "http://172.20.1.1",
      "http://gpu-box:11434",
      "http://studio.local:1234",
      "http://100.100.1.2:11434",
    ]) {
      expect(isLocalUrl(ok)).toBe(true);
    }
    for (const bad of [
      "https://api.openai.com/v1",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "ftp://127.0.0.1",
      "not a url",
      "http://example.com",
    ]) {
      expect(isLocalUrl(bad)).toBe(false);
    }
  });

  test("createProvider refuses cloud URLs and picks the right adapter", () => {
    expect(() =>
      createProvider({ id: "x", kind: "lmstudio", baseUrl: "https://api.example.com", enabled: true }),
    ).toThrow(/not a local or LAN address/);
    expect(
      createProvider({ id: "o", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }),
    ).toBeInstanceOf(OllamaProvider);
    expect(
      createProvider({ id: "l", kind: "llamacpp", baseUrl: "http://127.0.0.1:8080", enabled: true }),
    ).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

describe("node:http fallback", () => {
  test("nodeRequest streams a response like fetch", async () => {
    const { nodeRequest } = await import("../src/http");
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { n: number };
        return new Response(`{"n":${body.n + 1}}\n{"done":true}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    });
    try {
      const res = await nodeRequest(`http://127.0.0.1:${s.port}/api/chat`, {
        kind: "ollama",
        body: { n: 1 },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-ndjson");
      expect(await res.text()).toBe('{"n":2}\n{"done":true}\n');
    } finally {
      s.stop(true);
    }
  });
});

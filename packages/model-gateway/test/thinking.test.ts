import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type ChatChunk,
  collectChat,
  generateObject,
  type ModelProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  type StructuredProgress,
  withoutThinking,
} from "../src/index";

// The owner's first team run (qwen3:4b as the Manager on a GTX 1650) sat on "Manager is planning
// the work" for 11 minutes: the model thought without a limit and Depo showed nothing of it.

const servers: ReturnType<typeof Bun.serve>[] = [];
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

describe("thinking models", () => {
  test("Ollama: think is sent, and the model's thinking comes as thinking chunks, not answer text", async () => {
    let body: Record<string, unknown> = {};
    const base = serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return ndjson([
        { message: { content: "", thinking: "The user wants " } },
        { message: { content: "", thinking: "a login page." } },
        { message: { content: '{"ok":true}' } },
        { done: true, done_reason: "stop", eval_count: 9 },
      ]);
    });
    const p = new OllamaProvider("ollama", base);
    const chunks: ChatChunk[] = [];
    for await (const c of p.chat({ model: "qwen3:4b", messages: [], think: false })) chunks.push(c);
    expect(body.think).toBe(false);
    expect(chunks.filter((c) => c.type === "thinking").map((c) => (c as { delta: string }).delta)).toEqual([
      "The user wants ",
      "a login page.",
    ]);
    const res = await collectChat(
      (async function* () {
        yield* chunks;
      })(),
    );
    expect(res.text).toBe('{"ok":true}');
    expect(res.finishReason).toBe("stop");
  });

  test("Ollama: a 400 that refuses think is asked again without it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = serve(async (req) => {
      const b = (await req.json()) as Record<string, unknown>;
      bodies.push(b);
      if ("think" in b)
        return new Response(JSON.stringify({ error: '"qwen2.5-coder:3b" does not support thinking' }), {
          status: 400,
        });
      return ndjson([{ message: { content: "hi" } }, { done: true, done_reason: "stop" }]);
    });
    const res = await collectChat(
      new OllamaProvider("ollama", base).chat({ model: "qwen2.5-coder:3b", messages: [], think: false }),
    );
    expect(res.text).toBe("hi");
    expect(bodies).toHaveLength(2);
    expect("think" in (bodies[1] ?? {})).toBe(false);
    // Unset, think is not sent at all.
    await collectChat(new OllamaProvider("ollama", base).chat({ model: "m", messages: [] }));
    expect("think" in (bodies[2] ?? {})).toBe(false);
  });

  test("OpenAI-compatible: reasoning_content becomes thinking chunks", async () => {
    const base = serve(
      () =>
        new Response(
          `${[
            { choices: [{ delta: { reasoning_content: "Let me think." } }] },
            { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
          ]
            .map((o) => `data: ${JSON.stringify(o)}\n\n`)
            .join("")}data: [DONE]\n\n`,
        ),
    );
    const chunks: ChatChunk[] = [];
    for await (const c of new OpenAICompatibleProvider("lc", "llamacpp", base).chat({
      model: "m",
      messages: [],
    }))
      chunks.push(c);
    expect(chunks[0]).toEqual({ type: "thinking", delta: "Let me think." });
    expect(chunks[1]).toEqual({ type: "text", delta: "Answer" });
  });

  test("structured output: thinking is left out of the JSON, and progress counts thinking and answer", async () => {
    const replies: ChatChunk[][] = [
      [
        { type: "thinking", delta: "x".repeat(120) },
        { type: "text", delta: '{"steps":["a"]}' },
        { type: "done", finishReason: "stop", usage: null },
      ],
    ];
    const provider: ModelProvider = {
      id: "f",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "x", message: null }),
      listModels: async () => [],
      embed: async () => [],
      async *chat() {
        yield* replies.shift() ?? [];
      },
    };
    const seen: StructuredProgress[] = [];
    const r = await generateObject(provider, {
      model: "m",
      messages: [],
      schema: z.object({ steps: z.array(z.string()) }),
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(r.value).toEqual({ steps: ["a"] });
    expect(seen[0]).toEqual({ thinkingChars: 120, textChars: 0, attempt: 1 });
    expect(seen.at(-1)).toEqual({ thinkingChars: 120, textChars: 15, attempt: 1 });
  });

  test("structured output: thinking inside the answer between <think> tags", async () => {
    const parts = ["<think>Plan: {maybe", " a table}</think>\n", '{"steps":["b"]}'];
    const provider: ModelProvider = {
      id: "f",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      health: async () => ({ ok: true, version: "x", message: null }),
      listModels: async () => [],
      embed: async () => [],
      async *chat() {
        for (const p of parts) yield { type: "text", delta: p };
        yield { type: "done", finishReason: "stop", usage: null };
      },
    };
    const seen: StructuredProgress[] = [];
    const r = await generateObject(provider, {
      model: "m",
      messages: [],
      schema: z.object({ steps: z.array(z.string()) }),
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(r.value).toEqual({ steps: ["b"] });
    expect(seen[0]?.textChars).toBe(0);
    expect(seen[0]?.thinkingChars).toBeGreaterThan(0);
    expect(seen.at(-1)?.textChars).toBe(15);
    expect(withoutThinking("<think>never closed {")).toBe("");
    expect(withoutThinking('a<think>x</think>{"k":1}')).toBe('a{"k":1}');
  });
});

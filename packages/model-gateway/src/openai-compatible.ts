import { ModelGatewayError, providerLabel } from "./errors";
import { parseJsonArgs, readLines, request, toGatewayError } from "./http";
import { keepAliveSeconds } from "./keep-alive";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ModelProvider,
  ProviderHealth,
  ProviderKind,
  ToolCall,
} from "./types";

// Slow PCs: a tool call can be generated silently at ~2 tokens/s, and prompt reading can take
// many minutes. The user can always stop a task, so these limits only catch a hung runtime.
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_FIRST_BYTE_MS = 1_200_000;

/**
 * Adapter for any OpenAI-compatible local server: llama.cpp `llama-server`, LM Studio,
 * and Ollama's `/v1` endpoint. Only local or LAN endpoints are ever configured; there is
 * no cloud provider in Depo.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    readonly baseUrl: string,
  ) {}

  protected url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await request(this.url("/v1/models"), { kind: this.kind, signal, timeoutMs: 3000 });
      return { ok: true, version: null, message: null };
    } catch (err) {
      return { ok: false, version: null, message: toGatewayError(err, this.kind, signal).message };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await request(this.url("/v1/models"), { kind: this.kind, signal });
    const json = (await res.json()) as { data?: { id?: unknown }[] };
    return (json.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({
        name: m.id,
        sizeBytes: null,
        family: null,
        parameterSize: null,
        quantization: null,
        modifiedAt: null,
      }));
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await request(this.url("/v1/embeddings"), {
      kind: this.kind,
      signal,
      timeoutMs: 120_000,
      body: { model, input: inputs },
    });
    const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== inputs.length || rows.some((r) => !Array.isArray(r.embedding))) {
      throw new ModelGatewayError(
        "invalid_output",
        `${providerLabel(this.kind)} returned malformed embeddings.`,
      );
    }
    return rows.map((r) => r.embedding as number[]);
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    // llama.cpp: reuse the KV cache for the part of the prompt that did not change since the
    // last call (each agent step re-sends the whole conversation).
    if (this.kind === "llamacpp") body.cache_prompt = true;
    // LM Studio: how long a model it loaded on demand stays loaded (seconds). Only a positive
    // duration is sent; "until Depo closes" and "unload at once" keep LM Studio's own setting.
    if (this.kind === "lmstudio" && req.keepAlive !== undefined) {
      const ttl = keepAliveSeconds(req.keepAlive);
      if (ttl !== null && ttl > 0) body.ttl = ttl;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", strict: true, schema: req.jsonSchema },
      };
    }

    const res = await request(this.url("/v1/chat/completions"), {
      kind: this.kind,
      signal: req.signal,
      body,
      timeoutMs: req.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_MS,
    });

    const partial = new Map<number, { id: string; name: string; args: string }>();
    let finish: Extract<ChatChunk, { type: "done" }>["finishReason"] = "unknown";
    let usage: Extract<ChatChunk, { type: "done" }>["usage"] = null;
    let timings: LlamaTimings | null = null;

    try {
      for await (const line of readLines(res, {
        signal: req.signal,
        idleTimeoutMs: req.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        kind: this.kind,
      })) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        let json: OpenAIChunk;
        try {
          json = JSON.parse(data) as OpenAIChunk;
        } catch {
          continue;
        }
        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
          };
        }
        if (json.timings && typeof json.timings === "object") timings = json.timings;
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0)
          yield { type: "text", delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = partial.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          partial.set(idx, cur);
        }
        if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
      }
    } catch (err) {
      throw toGatewayError(err, this.kind, req.signal);
    }

    for (const [, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {
        id: p.id,
        name: p.name,
        arguments: parseJsonArgs(p.args),
        rawArguments: p.args,
      };
      yield { type: "tool_call", call };
    }
    if (partial.size > 0 && finish === "unknown") finish = "tool_calls";
    yield { type: "done", finishReason: finish, usage: withTimings(usage, timings) };
  }
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** llama.cpp server adds its own timings to the last chunk. */
  timings?: LlamaTimings;
}

interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
  /** Prompt tokens reused from the cache (newer llama.cpp). */
  cache_n?: number;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Add llama.cpp's timings to the usage (or build the usage from them when there was none). */
function withTimings(
  usage: Extract<ChatChunk, { type: "done" }>["usage"],
  t: LlamaTimings | null,
): Extract<ChatChunk, { type: "done" }>["usage"] {
  if (!t) return usage;
  const base = usage ?? {
    promptTokens: num(t.prompt_n) ? t.prompt_n : 0,
    completionTokens: num(t.predicted_n) ? t.predicted_n : 0,
  };
  return {
    ...base,
    ...(num(t.predicted_ms) ? { durationMs: Math.round(t.predicted_ms) } : {}),
    ...(num(t.prompt_ms) ? { promptMs: Math.round(t.prompt_ms) } : {}),
    ...(num(t.cache_n) ? { cachedPromptTokens: t.cache_n } : {}),
  };
}

function mapFinish(r: string): Extract<ChatChunk, { type: "done" }>["finishReason"] {
  if (r === "stop" || r === "length" || r === "tool_calls") return r;
  if (r === "function_call") return "tool_calls";
  return "unknown";
}

export function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      if (m.images?.length) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((b64) => ({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            })),
          ],
        };
      }
      return { role: "user", content: m.content };
    case "assistant":
      return m.toolCalls?.length
        ? {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.rawArguments || JSON.stringify(c.arguments ?? {}) },
            })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

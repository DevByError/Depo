import { ModelGatewayError } from "./errors";
import { readLines, request, toGatewayError } from "./http";
import { ollamaKeepAlive } from "./keep-alive";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  LoadedModel,
  ModelInfo,
  ModelProvider,
  PreloadOptions,
  ProviderHealth,
  PullProgress,
  Usage,
} from "./types";

// Slow PCs: a tool call can be generated silently at ~2 tokens/s, and prompt reading can take
// many minutes. The user can always stop a task, so these limits only catch a hung runtime.
const DEFAULT_IDLE_MS = 600_000;
export const PARSE_ERROR =
  /syntax error|unexpected EOF|unexpected end|failed to parse|invalid character|unmarshal/i;
const DEFAULT_FIRST_BYTE_MS = 1_200_000;

/**
 * Ollama via its native API (`/api/*`). Native rather than `/v1` because only the native API
 * honours `num_ctx`, JSON-schema `format`, model pull/delete and reports timings.
 */
export class OllamaProvider implements ModelProvider {
  readonly kind = "ollama" as const;
  private callSeq = 0;

  constructor(
    readonly id: string,
    readonly baseUrl: string = "http://127.0.0.1:11434",
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      const res = await request(this.url("/api/version"), { kind: this.kind, signal, timeoutMs: 3000 });
      const json = (await res.json()) as { version?: string };
      return { ok: true, version: json.version ?? null, message: null };
    } catch (err) {
      return { ok: false, version: null, message: toGatewayError(err, this.kind, signal).message };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await request(this.url("/api/tags"), { kind: this.kind, signal });
    const json = (await res.json()) as {
      models?: {
        name?: string;
        size?: number;
        modified_at?: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }[];
    };
    return (json.models ?? [])
      .filter((m) => typeof m.name === "string")
      .map((m) => ({
        name: m.name as string,
        sizeBytes: typeof m.size === "number" ? m.size : null,
        family: m.details?.family ?? null,
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        modifiedAt: m.modified_at ?? null,
      }));
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await request(this.url("/api/embed"), {
      kind: this.kind,
      signal,
      timeoutMs: 120_000,
      body: { model, input: inputs },
    });
    const json = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== inputs.length) {
      throw new ModelGatewayError("invalid_output", "Ollama returned malformed embeddings.");
    }
    return json.embeddings;
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await request(this.url("/api/pull"), {
      kind: this.kind,
      signal,
      body: { model, stream: true },
      timeoutMs: 60_000,
    });
    try {
      for await (const line of readLines(res, { signal, idleTimeoutMs: 300_000, kind: this.kind })) {
        const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (j.error) throw new ModelGatewayError("http", `Ollama could not download ${model}: ${j.error}`);
        onProgress({
          status: j.status ?? "",
          completedBytes: j.completed ?? null,
          totalBytes: j.total ?? null,
        });
      }
    } catch (err) {
      throw toGatewayError(err, this.kind, signal);
    }
  }

  async remove(model: string): Promise<void> {
    await request(this.url("/api/delete"), { kind: this.kind, method: "DELETE", body: { model } });
  }

  /**
   * Load a model without generating (an empty generate), with the context length and keep-alive
   * the next calls use, so they find it ready instead of reloading it.
   */
  async preload(model: string, opts: PreloadOptions = {}): Promise<{ loadMs: number | null }> {
    const body: Record<string, unknown> = { model, prompt: "", stream: false };
    if (opts.contextLength !== undefined) body.options = { num_ctx: opts.contextLength };
    const keepAlive = opts.keepAlive === undefined ? undefined : ollamaKeepAlive(opts.keepAlive);
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    const res = await request(this.url("/api/generate"), {
      kind: this.kind,
      signal: opts.signal,
      body,
      // Loading a model that does not fit in VRAM can take minutes on a slow disk.
      timeoutMs: 600_000,
    });
    const json = (await res.json().catch(() => ({}))) as { load_duration?: number; error?: string };
    if (json.error) throw new ModelGatewayError("http", `Ollama: ${json.error}`);
    return { loadMs: typeof json.load_duration === "number" ? nsToMs(json.load_duration) : null };
  }

  /** Unload a model now (keep_alive 0). */
  async unload(model: string, signal?: AbortSignal): Promise<void> {
    await request(this.url("/api/generate"), {
      kind: this.kind,
      signal,
      body: { model, prompt: "", stream: false, keep_alive: 0 },
      timeoutMs: 10_000,
    });
  }

  /** Models in memory right now, with the context length they were loaded with (newer Ollama). */
  async loaded(signal?: AbortSignal): Promise<LoadedModel[]> {
    const res = await request(this.url("/api/ps"), { kind: this.kind, signal, timeoutMs: 5000 });
    const json = (await res.json()) as {
      models?: {
        name?: string;
        model?: string;
        size_vram?: number;
        expires_at?: string;
        context_length?: number;
      }[];
    };
    return (json.models ?? [])
      .map((m) => ({
        name: m.name ?? m.model ?? "",
        contextLength: typeof m.context_length === "number" ? m.context_length : null,
        sizeVramBytes: typeof m.size_vram === "number" ? m.size_vram : null,
        expiresAt: m.expires_at ?? null,
      }))
      .filter((m) => m.name !== "");
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const options: Record<string, number> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.contextLength !== undefined) options.num_ctx = req.contextLength;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      options,
    };
    // Keep the model loaded between calls: a reload costs seconds to minutes on a small GPU.
    const keepAlive = req.keepAlive === undefined ? undefined : ollamaKeepAlive(req.keepAlive);
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.jsonSchema) body.format = req.jsonSchema;

    const res = await request(this.url("/api/chat"), {
      kind: this.kind,
      signal: req.signal,
      body,
      timeoutMs: req.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_MS,
    });

    let sawTool = false;
    try {
      for await (const line of readLines(res, {
        signal: req.signal,
        idleTimeoutMs: req.idleTimeoutMs ?? DEFAULT_IDLE_MS,
        kind: this.kind,
      })) {
        let j: OllamaChunk;
        try {
          j = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }
        if (j.error) {
          // Ollama parses some models' tool calls itself (e.g. Qwen3-Coder's XML); a malformed one
          // ends the stream with a parse error. That is a model mistake, not a runtime failure.
          if (PARSE_ERROR.test(j.error))
            throw new ModelGatewayError(
              "invalid_output",
              `The model wrote a tool call Ollama could not read (${j.error}).`,
            );
          throw new ModelGatewayError("http", `Ollama: ${j.error}`);
        }
        const content = j.message?.content;
        if (typeof content === "string" && content.length > 0) yield { type: "text", delta: content };
        for (const tc of j.message?.tool_calls ?? []) {
          sawTool = true;
          const args = tc.function?.arguments ?? {};
          yield {
            type: "tool_call",
            call: {
              id: `call_${++this.callSeq}`,
              name: tc.function?.name ?? "",
              arguments: args,
              rawArguments: JSON.stringify(args),
            },
          };
        }
        if (j.done) {
          yield {
            type: "done",
            finishReason: sawTool ? "tool_calls" : j.done_reason === "length" ? "length" : "stop",
            usage: ollamaUsage(j),
          };
          return;
        }
      }
    } catch (err) {
      throw toGatewayError(err, this.kind, req.signal);
    }
    yield { type: "done", finishReason: sawTool ? "tool_calls" : "unknown", usage: null };
  }
}

interface OllamaChunk {
  message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Durations are in nanoseconds. */
  eval_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  error?: string;
}

const nsToMs = (ns: number) => Math.round(ns / 1e6);

/** Token counts and timings from Ollama's final chunk. */
function ollamaUsage(j: OllamaChunk): Usage {
  return {
    promptTokens: j.prompt_eval_count ?? 0,
    completionTokens: j.eval_count ?? 0,
    ...(j.eval_duration ? { durationMs: nsToMs(j.eval_duration) } : {}),
    ...(typeof j.load_duration === "number" ? { loadMs: nsToMs(j.load_duration) } : {}),
    ...(typeof j.prompt_eval_duration === "number" ? { promptMs: nsToMs(j.prompt_eval_duration) } : {}),
  };
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return m.images?.length
        ? { role: "user", content: m.content, images: m.images }
        : { role: "user", content: m.content };
    case "assistant":
      return m.toolCalls?.length
        ? {
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({
              function: { name: c.name, arguments: c.arguments ?? {} },
            })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", content: m.content, tool_name: m.name };
  }
}

import { ModelGatewayError } from "./errors";
import { readLines, request, toGatewayError } from "./http";
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ModelProvider,
  ProviderHealth,
  PullProgress,
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
            usage: {
              promptTokens: j.prompt_eval_count ?? 0,
              completionTokens: j.eval_count ?? 0,
              ...(j.eval_duration ? { durationMs: Math.round(j.eval_duration / 1e6) } : {}),
            },
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
  eval_duration?: number;
  error?: string;
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

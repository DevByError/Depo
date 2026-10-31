/** Provider-neutral chat types. Every local runtime is mapped onto these. */

export type ProviderKind = "ollama" | "llamacpp" | "lmstudio";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Untrusted: validate before use. */
  arguments: unknown;
  /** The raw argument string, kept for repair prompts when parsing failed. */
  rawArguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Constrain output to this JSON Schema (grammar/format when the runtime supports it). */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** Context window to request (Ollama `num_ctx`). */
  contextLength?: number;
  signal?: AbortSignal;
  /** Abort if no data arrives for this long. Default 120 s (model loading can be slow). */
  idleTimeoutMs?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Generation time reported by the runtime, when available. */
  durationMs?: number;
}

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; finishReason: "stop" | "length" | "tool_calls" | "unknown"; usage: Usage | null };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: Extract<ChatChunk, { type: "done" }>["finishReason"];
  usage: Usage | null;
}

export interface ModelInfo {
  /** Name to pass in requests, e.g. `qwen2.5-coder:7b`. */
  name: string;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  modifiedAt: string | null;
}

export interface ProviderHealth {
  ok: boolean;
  version: string | null;
  /** Friendly, actionable message when not ok. */
  message: string | null;
}

export interface PullProgress {
  status: string;
  completedBytes: number | null;
  totalBytes: number | null;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Only runtimes that manage their own model store (Ollama) support these. */
  pull?(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  remove?(model: string): Promise<void>;
}

import { z } from "zod";
import { collectChat } from "./collect";
import { ModelGatewayError } from "./errors";
import type { ChatChunk, ChatMessage, ChatRequest, ModelProvider, Usage } from "./types";

export interface StructuredOptions<T> extends Omit<ChatRequest, "jsonSchema" | "tools"> {
  schema: z.ZodType<T>;
  /** Repair attempts after the first try. Default 2. */
  maxRepairs?: number;
  /** Called as the reply streams: characters of thinking and of answer so far (this attempt). */
  onProgress?: (p: StructuredProgress) => void;
}

export interface StructuredProgress {
  thinkingChars: number;
  textChars: number;
  attempt: number;
}

export interface StructuredResult<T> {
  value: T;
  attempts: number;
  usage: Usage[];
}

/**
 * Ask for JSON matching a Zod schema. The runtime is constrained with the JSON Schema when
 * it supports it; the answer is always validated, and on failure the model is shown the
 * exact error and asked to fix its output (validate → repair → retry).
 */
export async function generateObject<T>(
  provider: ModelProvider,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const jsonSchema = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  const messages: ChatMessage[] = [...opts.messages];
  const maxRepairs = opts.maxRepairs ?? 2;
  const usage: Usage[] = [];
  let lastError = "";

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const { schema: _schema, maxRepairs: _m, onProgress, ...rest } = opts;
    const stream = provider.chat({ ...rest, messages, jsonSchema });
    const res = await collectChat(onProgress ? withProgress(stream, onProgress, attempt) : stream);
    if (res.usage) usage.push(res.usage);
    res.text = withoutThinking(res.text);
    const raw = extractJson(res.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      lastError = `Not valid JSON: ${(e as Error).message}`;
      messages.push({ role: "assistant", content: res.text });
      messages.push({ role: "user", content: `${lastError}\nReply again with only the corrected JSON.` });
      continue;
    }
    const check = opts.schema.safeParse(parsed);
    if (check.success) return { value: check.data, attempts: attempt, usage };
    lastError = check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    messages.push({ role: "assistant", content: res.text });
    messages.push({
      role: "user",
      content: `Your JSON does not match the required schema: ${lastError}\nReply again with only the corrected JSON.`,
    });
  }
  throw new ModelGatewayError(
    "invalid_output",
    `The model could not produce valid output after ${maxRepairs + 1} attempts.`,
    undefined,
    lastError,
  );
}

/** Passes the chunks on and reports how much thinking and answer came so far. */
async function* withProgress(
  stream: AsyncIterable<ChatChunk>,
  onProgress: (p: StructuredProgress) => void,
  attempt: number,
): AsyncGenerator<ChatChunk> {
  let thinkingChars = 0;
  let textChars = 0;
  // Some runtimes send the thinking inside the answer, between <think> tags.
  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === "thinking") thinkingChars += chunk.delta.length;
    else if (chunk.type === "text") {
      text += chunk.delta;
      const open = text.lastIndexOf("<think>");
      if (open < 0) textChars = text.length;
      else if (text.indexOf("</think>", open) < 0) thinkingChars += chunk.delta.length;
      else textChars = withoutThinking(text).length;
    }
    onProgress({ thinkingChars, textChars, attempt });
    yield chunk;
  }
}

/** The answer without a thinking model's <think>…</think> part (also one that never closed). */
export function withoutThinking(text: string): string {
  const out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  return (open >= 0 ? out.slice(0, open) : out).trim();
}

/** Pull a JSON object out of a reply that may wrap it in prose or a ``` fence. */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start < 0) return text.trim();
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

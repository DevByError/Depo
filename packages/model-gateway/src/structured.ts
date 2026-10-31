import { z } from "zod";
import { collectChat } from "./collect";
import { ModelGatewayError } from "./errors";
import type { ChatMessage, ChatRequest, ModelProvider, Usage } from "./types";

export interface StructuredOptions<T> extends Omit<ChatRequest, "jsonSchema" | "tools"> {
  schema: z.ZodType<T>;
  /** Repair attempts after the first try. Default 2. */
  maxRepairs?: number;
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
    const { schema: _schema, maxRepairs: _m, ...rest } = opts;
    const res = await collectChat(provider.chat({ ...rest, messages, jsonSchema }));
    if (res.usage) usage.push(res.usage);
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

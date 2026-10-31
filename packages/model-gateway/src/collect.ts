import type { ChatChunk, ChatResult } from "./types";

/** Drain a chat stream into a single result, forwarding text deltas as they arrive. */
export async function collectChat(
  stream: AsyncIterable<ChatChunk>,
  onText?: (delta: string) => void,
): Promise<ChatResult> {
  let text = "";
  const toolCalls: ChatResult["toolCalls"] = [];
  let finishReason: ChatResult["finishReason"] = "unknown";
  let usage: ChatResult["usage"] = null;
  for await (const chunk of stream) {
    if (chunk.type === "text") {
      text += chunk.delta;
      onText?.(chunk.delta);
    } else if (chunk.type === "tool_call") {
      toolCalls.push(chunk.call);
    } else {
      finishReason = chunk.finishReason;
      usage = chunk.usage;
    }
  }
  return { text, toolCalls, finishReason, usage };
}

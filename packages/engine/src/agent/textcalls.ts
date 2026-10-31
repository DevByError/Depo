import type { ToolCall } from "@depo/model-gateway";

/**
 * Some local models describe tool calls in text instead of the native tool-call channel
 * (`<tool_call>{…}</tool_call>`, or a JSON block with name + arguments). Recover them so the
 * loop still works; only names of real tools are accepted.
 */
export function parseTextToolCalls(text: string, toolNames: string[]): ToolCall[] {
  const known = new Set(toolNames);
  const candidates: string[] = [];
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) if (m[1]) candidates.push(m[1]);
  if (candidates.length === 0) {
    for (const m of text.matchAll(/```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g))
      if (m[1]) candidates.push(m[1]);
  }
  if (candidates.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  }
  const calls: ToolCall[] = [];
  for (const c of candidates) {
    let j: unknown;
    try {
      j = JSON.parse(c);
    } catch {
      continue;
    }
    if (!j || typeof j !== "object") continue;
    const o = j as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? o.tool : null;
    if (!name || !known.has(name)) continue;
    let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // keep as string; validation will report it
      }
    }
    calls.push({ id: `text_${calls.length + 1}`, name, arguments: args, rawArguments: JSON.stringify(args) });
  }
  return calls;
}

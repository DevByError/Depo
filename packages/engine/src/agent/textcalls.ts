import type { ToolCall } from "@depo/model-gateway";

/**
 * Some local models describe tool calls in text instead of the native tool-call channel
 * (`<tool_call>{…}</tool_call>`, or a JSON block with name + arguments). Recover them so the
 * loop still works; only names of real tools are accepted.
 */
export function parseTextToolCalls(text: string, toolNames: string[]): ToolCall[] {
  return extractTextToolCalls(text, toolNames).calls;
}

/** Tool calls written as text, plus the reply with those calls taken out (for display). */
export function extractTextToolCalls(text: string, toolNames: string[]): { calls: ToolCall[]; rest: string } {
  const known = new Set(toolNames);
  const candidates: { raw: string; json: string }[] = [];
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g))
    if (m[1]) candidates.push({ raw: m[0], json: m[1] });
  if (candidates.length === 0) {
    for (const m of text.matchAll(/```(?:json|tool_call)?\s*(\{[\s\S]*?)\s*```/g))
      if (m[1]) candidates.push({ raw: m[0], json: m[1] });
  }
  if (candidates.length === 0) {
    // Bare JSON objects, possibly with prose around them: {"name": ..., "arguments": ...}
    for (const obj of jsonObjects(text))
      if (/"(name|tool)"\s*:/.test(obj)) candidates.push({ raw: obj, json: obj });
  }
  const calls: ToolCall[] = [];
  let rest = text;
  for (const c of candidates) {
    const j = parseLoose(c.json);
    if (!j || typeof j !== "object") continue;
    const o = j as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? o.tool : null;
    if (!name || !known.has(name)) continue;
    let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
    if (typeof args === "string") args = parseLoose(args) ?? args;
    calls.push({ id: `text_${calls.length + 1}`, name, arguments: args, rawArguments: JSON.stringify(args) });
    rest = rest.replace(c.raw, "");
  }
  return { calls, rest: calls.length ? rest.trim() : text };
}

/** JSON.parse, then again after escaping raw newlines and tabs inside strings (a common slip). */
function parseLoose(s: string): unknown {
  const fixed = escapeControlCharsInStrings(s);
  for (const attempt of [s, fixed, closeBrackets(fixed)]) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** Append the closing brackets a model forgot at the end (a common slip with long calls). */
export function closeBrackets(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return s + stack.reverse().join("");
}

/** Does this reply look like an attempted tool call that could not be read? */
export function looksLikeToolCall(text: string, toolNames: string[]): boolean {
  return /"(name|tool)"\s*:/.test(text) && toolNames.some((n) => text.includes(`"${n}"`));
}

export function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") {
        out += "\\r";
        continue;
      } else if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** Top-level balanced {...} spans in text, string-aware. */
function jsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/**
 * Remove leftover tool-call markup from a reply that made no tool call, e.g. a final summary
 * ending in a stray `<tool_call>` that some models emit before deciding to stop.
 */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<\/?(tool_call|tool_response|function_call)>\s*$/gi, "")
    .replace(/<\/?(tool_call|tool_response|function_call)>\s*$/gi, "")
    .trimEnd();
}

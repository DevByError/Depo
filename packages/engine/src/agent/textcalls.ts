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
  const tagged: { raw: string; json: string }[] = [];
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g))
    if (m[1]) tagged.push({ raw: m[0], json: m[1] });
  // A fenced block may hold several calls, one JSON object after another.
  const fenced: { raw: string; json: string }[] = [];
  for (const m of text.matchAll(/```(?:json|tool_call)?\s*(\{[\s\S]*?)\s*```/g)) {
    const objs = m[1] ? jsonObjects(m[1]) : [];
    if (objs.length > 1) for (const o of objs) fenced.push({ raw: o, json: o });
    else if (m[1]) fenced.push({ raw: m[0], json: m[1] });
  }
  // Bare JSON objects, possibly with prose around them: {"name": ..., "arguments": ...}
  const bare = () =>
    jsonObjects(text)
      .filter((obj) => /"(name|tool)"\s*:/.test(obj))
      .map((obj) => ({ raw: obj, json: obj }));
  // The first kind that holds a real call wins: a fenced package.json ({"name": "my-app"}) must
  // not hide a call written next to it.
  for (const candidates of [tagged, fenced]) {
    const r = callsFrom(candidates, text, known);
    if (r.calls.length) return r;
  }
  const r = callsFrom(bare(), text, known);
  return r.calls.length ? r : { calls: [], rest: text };
}

function callsFrom(
  candidates: { raw: string; json: string }[],
  text: string,
  known: Set<string>,
): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  let rest = text;
  // Small models often "cd" before a command, as if in a terminal: carry it into run_command's cwd.
  let dir: string[] = [];
  for (const c of candidates) {
    const j = parseLoose(c.json);
    if (!j || typeof j !== "object") continue;
    const o = j as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? o.tool : null;
    let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
    if (typeof args === "string") args = parseLoose(args) ?? args;
    if (name && CD_TOOLS.has(name) && known.has("run_command")) {
      dir = changeDir(dir, args);
      rest = rest.replace(c.raw, "");
      continue;
    }
    if (!name || !known.has(name)) continue;
    if (name === "run_command" && dir.length && args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      if (!a.cwd) args = { ...a, cwd: dir.join("/") };
    }
    calls.push({ id: `text_${calls.length + 1}`, name, arguments: args, rawArguments: JSON.stringify(args) });
    rest = rest.replace(c.raw, "");
  }
  if (calls.length) rest = rest.replace(/```(?:json|tool_call)?\s*```/g, "");
  return { calls, rest: calls.length ? rest.trim() : text };
}

const CD_TOOLS = new Set(["cd", "chdir", "change_directory", "change_dir"]);

/** The folder after a pretend `cd` call, as path parts below the project root. */
function changeDir(dir: string[], args: unknown): string[] {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const raw = [a.dir, a.path, a.directory, a.folder].find((v) => typeof v === "string") as string | undefined;
  if (!raw) return dir;
  const out = raw.replace(/\\/g, "/").startsWith("/") ? [] : [...dir];
  for (const part of raw.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
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

/** A reply that contains a tool result the model wrote itself ("<tool_response>…"). */
export function inventsToolResult(text: string): boolean {
  return /<tool_(response|result)>|<\/tool_(response|result)>/i.test(text);
}

/**
 * Some models (qwen2.5-coder 7b among them) open their replies with a bare "<tool_response>" tag
 * and then write ordinary sentences ("<tool_response>\nLet's start by reading app.ts."). That is a
 * habit, not a made-up result, so the tag is dropped. A tag that is closed, or followed by
 * something that reads like a tool's output, is left for the made-up-result check.
 */
export function withoutStrayResultTag(text: string): string {
  const m = /^\s*<tool_(response|result)>[ \t]*\n?/i.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  if (/<\/?tool_(response|result)>/i.test(rest)) return text;
  const first = rest.trimStart().split("\n", 1)[0] ?? "";
  return PROSE_START.test(first) ? rest.trimStart() : text;
}

const PROSE_START =
  /^(I|I'll|I've|I'm|I am|I will|Let's|Let me|Now|Next|Then|Sure|Okay|OK|Alright|The|This|These|To|Here|Great|Sorry|Apologies|No|Yes|All|Done|First|Please|We|It|My|Based on|Since|After|Before|Unfortunately|Thank)\b/;

/** The reply without the tool results the model wrote itself (and anything after an unclosed one). */
export function withoutInventedResults(text: string): string {
  return text
    .replace(/<tool_(response|result)>[\s\S]*?<\/tool_(response|result)>/gi, "")
    .replace(/<tool_(response|result)>[\s\S]*$/i, "")
    .replace(/<\/?tool_(response|result)>/gi, "")
    .replace(/```\w*\s*```/g, "")
    .trim();
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
  return jsonObjectSpans(text).map((s) => text.slice(s.start, s.end));
}

/**
 * Where the first complete tool call written as text ends, or -1. While a reply streams, a small
 * model that writes a call and then carries on (writing the result itself, then the next steps)
 * can be stopped there instead of writing for minutes.
 */
export function firstTextCallEnd(text: string, toolNames: string[]): number {
  return textCallSpans(text, toolNames)[0]?.end ?? -1;
}

/** Each complete tool call written as text (start and end), in order. */
export function textCallSpans(text: string, toolNames: string[]): { start: number; end: number }[] {
  const known = new Set(toolNames);
  const isCall = (json: string) => {
    const j = parseStrict(json);
    if (!j || typeof j !== "object") return false;
    const o = j as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? o.tool : null;
    return !!name && (known.has(name) || CD_TOOLS.has(name));
  };
  const spans: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g))
    if (m[1] && isCall(m[1])) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  // Objects inside <tool_call> tags are already counted by the tag.
  const tagged = (s: { start: number; end: number }) =>
    spans.some((t) => t.start <= s.start && t.end >= s.end);
  for (const s of jsonObjectSpans(text)) if (!tagged(s) && isCall(text.slice(s.start, s.end))) spans.push(s);
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The end of the first group of tool calls written next to each other (only blank lines, commas,
 * fences or call tags between them), or -1. Calls further on belong to steps the model went on to
 * invent after the first one, and are not run.
 */
export function firstCallGroupEnd(text: string, toolNames: string[]): number {
  const spans = textCallSpans(text, toolNames);
  const first = spans[0];
  if (!first) return -1;
  let end = first.end;
  for (const s of spans.slice(1)) {
    const gap = text
      .slice(end, s.start)
      .replace(/<\/?(tool_call|tool_response|tool_result)>/gi, "")
      .replace(/```+\w*/g, "")
      .replace(/[\s,;]/g, "");
    if (gap) break;
    end = s.end;
  }
  return end;
}

function parseStrict(s: string): unknown {
  for (const attempt of [s, escapeControlCharsInStrings(s)]) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

function jsonObjectSpans(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
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
      if (depth === 0 && start >= 0) found.push({ start, end: i + 1 });
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

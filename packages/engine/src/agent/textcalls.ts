import type { ToolCall } from "@depo/model-gateway";
import { aliasFor } from "./aliases";

/**
 * Some local models describe tool calls in text instead of the native tool-call channel
 * (`<tool_call>{…}</tool_call>`, or a JSON block with name + arguments). Recover them so the
 * loop still works; only names of real tools are accepted.
 */
export function parseTextToolCalls(text: string, toolNames: string[]): ToolCall[] {
  return extractTextToolCalls(text, toolNames).calls;
}

/** What extractTextToolCalls found: the calls, the reply without them, and calls run under another name. */
export interface TextCalls {
  calls: ToolCall[];
  rest: string;
  /** Call id → the made-up name the model used, for calls Depo ran as a real tool. */
  renamed: Record<string, string>;
}

/** Tool calls written as text, plus the reply with those calls taken out (for display). */
export function extractTextToolCalls(text: string, toolNames: string[], root?: string): TextCalls {
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
  const bare = () => {
    const objs = jsonObjects(text).filter((obj) => /["'](name|tool|function)["']\s*:/.test(obj));
    // A call left open at the end (the closing brackets never written).
    const tail = openTail(text);
    if (tail && /["'](name|tool|function)["']\s*:/.test(tail)) objs.push(tail);
    return objs.map((obj) => ({ raw: obj, json: obj }));
  };
  // The first kind that holds a real call wins: a fenced package.json ({"name": "my-app"}) must
  // not hide a call written next to it.
  for (const candidates of [tagged, fenced]) {
    const r = callsFrom(candidates, text, known, root);
    if (r.calls.length) return r;
  }
  const r = callsFrom(bare(), text, known, root);
  return r.calls.length ? r : { calls: [], rest: text, renamed: {} };
}

/** The tool name and arguments of a parsed call object, in the shapes models write them. */
function callParts(o: Record<string, unknown>): { name: string | null; args: unknown } {
  // {"type": "function", "function": {"name": …, "arguments": "{…}"}}
  const fn = o.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) return callParts(fn as Record<string, unknown>);
  const name =
    typeof o.name === "string"
      ? o.name
      : typeof o.tool === "string"
        ? o.tool
        : typeof o.function === "string"
          ? o.function
          : null;
  const key = ["arguments", "args", "parameters", "params", "input"].find((k) => k in o);
  // {"name": "write_file", "path": …, "content": …}: the arguments written next to the name.
  let args: unknown = key
    ? o[key]
    : Object.fromEntries(
        Object.entries(o).filter(([k]) => !["name", "tool", "function", "type", "id"].includes(k)),
      );
  if (typeof args === "string") args = parseLoose(args) ?? args;
  return { name, args: args ?? {} };
}

function callsFrom(
  candidates: { raw: string; json: string }[],
  text: string,
  known: Set<string>,
  root?: string,
): TextCalls {
  const calls: ToolCall[] = [];
  const renamed: Record<string, string> = {};
  let rest = text;
  // Small models often "cd" before a command, as if in a terminal: carry it into run_command's cwd.
  let dir: string[] = [];
  for (const c of candidates) {
    const j = parseLoose(c.json);
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    let { name, args } = callParts(j as Record<string, unknown>);
    if (name && CD_TOOLS.has(name) && known.has("run_command")) {
      dir = changeDir(dir, args);
      rest = rest.replace(c.raw, "");
      continue;
    }
    if (!name) continue;
    const id = `text_${calls.length + 1}`;
    if (!known.has(name)) {
      const alias = aliasFor(name, args, known, root);
      if (!alias) continue;
      renamed[id] = name;
      name = alias.name;
      args = alias.args;
    }
    if (name === "run_command" && dir.length && args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      if (!a.cwd) args = { ...a, cwd: dir.join("/") };
    }
    calls.push({ id, name, arguments: args, rawArguments: JSON.stringify(args) });
    rest = rest.replace(c.raw, "");
  }
  if (calls.length) rest = rest.replace(/```(?:json|tool_call)?\s*```/g, "");
  return { calls, rest: calls.length ? rest.trim() : text, renamed };
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

/**
 * JSON.parse, then again after the slips small models make: raw newlines and tabs inside strings,
 * escapes JSON does not have (`\'`), and closing brackets left off the end.
 */
function parseLoose(s: string): unknown {
  return parseWithRepairs(s).value;
}

function parseWithRepairs(s: string): { value: unknown; error: string | null } {
  const fixed = escapeControlCharsInStrings(s);
  const escapes = fixBadEscapes(fixed);
  let first: string | null = null;
  // Each repair builds on the one before; the first error is the one the model is told about
  // (the later ones come from Depo's own guesses).
  const steps = [
    () => s,
    () => fixed,
    () => escapes,
    () => balanceBrackets(escapes),
    () => balanceBrackets(pythonish(escapes)),
    () => balanceBrackets(missingCommas(pythonish(escapes))),
    () => balanceBrackets(fixInnerQuotes(pythonish(escapes))),
    // Quotes first, then raw line breaks: with a stray quote, the line breaks were judged outside
    // strings above and left raw.
    () => balanceBrackets(escapeControlCharsInStrings(fixInnerQuotes(pythonish(fixBadEscapes(s))))),
  ];
  for (const step of steps) {
    try {
      return { value: JSON.parse(step()), error: null };
    } catch (err) {
      first ??= err instanceof Error ? err.message : String(err);
    }
  }
  return { value: undefined, error: first };
}

/**
 * The parts of a JSON text outside strings changed by `fn` (strings are left alone). `between`
 * is true for a part with a string on both sides.
 */
function outsideStrings(s: string, fn: (part: string, between: boolean) => string): string {
  let out = "";
  let part = "";
  let inStr = false;
  let esc = false;
  let strings = 0;
  for (const ch of s) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      out += fn(part, strings > 0) + ch;
      part = "";
      inStr = true;
      strings++;
      continue;
    }
    part += ch;
  }
  return out + fn(part, false);
}

/**
 * Commas a model left out between members (`"a": "x" "b": "y"`, `"a": 1 "b": 2`, `} "b"`): JSON
 * never has a value right before a string without one.
 */
export function missingCommas(s: string): string {
  return outsideStrings(s, (p, between) => {
    if (!between) return p;
    if (!p.trim()) return `,${p}`;
    return p.replace(/([}\]\d]|\btrue|\bfalse|\bnull)(\s*)$/, "$1,$2");
  });
}

/**
 * JSON as Python or JavaScript writes it: True/False/None, trailing commas, and (when there are no
 * double quotes at all) single-quoted strings.
 */
export function pythonish(s: string): string {
  const quoted = s.includes('"') ? s : s.replace(/'/g, '"');
  return outsideStrings(quoted, (p) =>
    p
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
}

/**
 * Brackets put right: a missing closer is added where the next closer shows it was due
 * (`[{"a": 1}}` gets its `]`), a closer with no opener is dropped, and what is still open at the
 * end (a string, then brackets) is closed.
 */
export function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      const at = stack.lastIndexOf(ch);
      if (at < 0) continue;
      while (stack.length > at + 1) out += stack.pop();
      stack.pop();
    }
    out += ch;
  }
  if (inStr) out = `${esc ? out.slice(0, -1) : out}"`;
  out = out.replace(/[\s,:]+$/, "");
  return out + stack.reverse().join("");
}

/**
 * Quotes inside a string value that should have been written as \" (`"content": "say("hi")"`).
 * A quote ends a string only where JSON could go on after it: a key before `:`, a value before
 * `,` and the next key, or the closing bracket of what holds it. A guess, tried last.
 */
export function fixInnerQuotes(s: string): string {
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let isKey = false;
  let esc = false;
  let last = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? "";
    if (!inStr) {
      if (ch === '"') {
        inStr = true;
        isKey = stack.at(-1) === "{" && (last === "{" || last === ",");
      } else if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
      if (!/\s/.test(ch)) last = ch;
      out += ch;
      continue;
    }
    if (esc) {
      esc = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      out += ch;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }
    const after = s.slice(i + 1, i + 200);
    const top = stack.at(-1);
    const ends = isKey
      ? /^\s*:/.test(after)
      : /^\s*$/.test(after) ||
        (top === "{" && /^\s*,\s*"[^"\n]{1,60}"\s*:/.test(after)) ||
        (top === "[" && /^\s*,\s*["{[\d\-tfn]/.test(after)) ||
        (top === "{" && /^\s*}\s*(?:[,}\]]|$)/.test(after)) ||
        (top === "[" && /^\s*]\s*(?:[,}\]]|$)/.test(after));
    if (ends) {
      inStr = false;
      last = '"';
      out += ch;
    } else out += '\\"';
  }
  return out;
}

/**
 * Backslash escapes that JSON does not have, inside strings: `\'` becomes `'` (models copy it from
 * JavaScript), any other (`\d`, `\.`, `\$`) a literal backslash, which is what the code meant.
 */
export function fixBadEscapes(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? "";
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = s[i + 1] ?? "";
      if (next && '"\\/bfnrt'.includes(next)) {
        out += ch + next;
        i++;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += s.slice(i, i + 6);
        i += 5;
      } else if (next === "'") {
        out += "'";
        i++;
      } else out += "\\\\";
      continue;
    }
    if (ch === '"') inStr = false;
    out += ch;
  }
  return out;
}

/** The text tool calls that name a tool Depo does not have ("add_table"), by name. */
export function unknownToolCalls(text: string, toolNames: string[]): string[] {
  const known = new Set(toolNames);
  const names = new Set<string>();
  const tail = openTail(text);
  const sources = [
    ...[...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1] ?? ""),
    ...jsonObjects(text),
    // A call left open at the end (the model stopped before closing it).
    ...(tail ? [tail] : []),
  ];
  for (const json of sources) {
    const j = parseLoose(json);
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    const o = j as Record<string, unknown>;
    const { name, args } = callParts(o);
    // Only something shaped like a call: a package.json also has a "name".
    const hasArgs = ["arguments", "args", "parameters", "params", "input", "function"].some((k) => k in o);
    if (
      name &&
      hasArgs &&
      !known.has(name) &&
      !CD_TOOLS.has(name) &&
      /^[\w.-]{1,64}$/.test(name) &&
      !aliasFor(name, args, known)
    )
      names.add(name);
  }
  return [...names];
}

/** Why the first tool call written as text could not be read (a JSON error), or null. */
export function textCallProblem(text: string, toolNames: string[]): string | null {
  for (const json of [
    ...[...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(/```(?:json|tool_call)?\s*(\{[\s\S]*?)\s*```/g)].map((m) => m[1] ?? ""),
  ])
    if (toolNames.some((n) => json.includes(`"${n}"`))) {
      const r = parseWithRepairs(json);
      if (r.error) return r.error;
    }
  for (const json of jsonObjects(text))
    if (toolNames.some((n) => json.includes(`"${n}"`))) {
      const r = parseWithRepairs(json);
      if (r.error) return r.error;
    }
  return null;
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

/** An object opened at the top level and never closed, from its `{` to the end of the text. */
function openTail(text: string): string | null {
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
    } else if (ch === "}" && depth > 0) depth--;
  }
  if (depth === 0 || start < 0) return null;
  return text.slice(start).replace(/\s*(<\/tool_call>|```)\s*$/, "");
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
  const fixed = escapeControlCharsInStrings(s);
  for (const attempt of [s, fixed, fixBadEscapes(fixed)]) {
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

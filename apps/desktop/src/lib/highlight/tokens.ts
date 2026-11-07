/**
 * Highlighted code as plain data: lines of tokens, each with a colour kind. React renders them
 * as text in spans (never as HTML), so file contents can never inject markup.
 */

/** Colour classes; each has a CSS variable in `styles/syntax.css` for both themes. */
export const TOKEN_KINDS = [
  "keyword",
  "builtin",
  "type",
  "function",
  "string",
  "number",
  "comment",
  "meta",
  "property",
  "tag",
  "regexp",
  "section",
  "punct",
  "added",
  "removed",
  "strong",
  "emphasis",
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface Token {
  text: string;
  kind: TokenKind | null;
}

/** Scopes that stop the colour of the scope around them (the code inside `${...}` is code, not string). */
const RESET = "reset";

/** highlight.js scope (dotted, "title.function") to a colour kind. Unlisted scopes take their parent's colour. */
const SCOPES: Record<string, TokenKind | typeof RESET> = {
  keyword: "keyword",
  "selector-pseudo": "keyword",
  "template-tag": "keyword",
  "variable.language": "keyword",
  built_in: "builtin",
  type: "type",
  "title.class": "type",
  "title.class.inherited": "type",
  "selector-class": "type",
  title: "function",
  "title.function": "function",
  "title.function.invoke": "function",
  "selector-id": "function",
  string: "string",
  char: "string",
  code: "string",
  "meta.string": "string",
  number: "number",
  literal: "number",
  symbol: "number",
  formula: "number",
  "variable.constant": "number",
  comment: "comment",
  quote: "comment",
  meta: "meta",
  "meta.prompt": "meta",
  attr: "property",
  attribute: "property",
  property: "property",
  "selector-attr": "property",
  name: "tag",
  "selector-tag": "tag",
  regexp: "regexp",
  link: "regexp",
  "char.escape": "regexp",
  section: "section",
  tag: "punct",
  punctuation: "punct",
  operator: "punct",
  bullet: "punct",
  addition: "added",
  deletion: "removed",
  strong: "strong",
  emphasis: "emphasis",
  subst: RESET,
  params: RESET,
};

/** `hljs-title function_` -> `title.function`; classes without the prefix (sub-languages) give "". */
function scopeOf(classAttr: string): string {
  const parts = classAttr.trim().split(/\s+/);
  const first = parts[0] ?? "";
  if (!first.startsWith("hljs-")) return "";
  return [first.slice(5), ...parts.slice(1).map((p) => p.replace(/_+$/, ""))].join(".");
}

/** The colour of a scope, trying the general scope when the exact one is not listed. */
export function kindForScope(scope: string): TokenKind | typeof RESET | null {
  let s = scope;
  while (s) {
    const k = SCOPES[s];
    if (k) return k;
    const dot = s.lastIndexOf(".");
    s = dot < 0 ? "" : s.slice(0, dot);
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

function decodeEntities(s: string): string {
  return s.indexOf("&") < 0
    ? s
    : s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => ENTITIES[e] ?? _);
}

/**
 * Read highlight.js output (escaped text and nested `<span class>` only) into lines of tokens.
 * Scopes that span several lines (a block comment) carry their colour onto each line.
 */
export function htmlToLines(html: string): Token[][] {
  const lines: Token[][] = [[]];
  // The colour in effect at each nesting level; index 0 is the plain text outside any span.
  const stack: (TokenKind | null)[] = [null];
  const push = (text: string) => {
    if (!text) return;
    const kind = stack[stack.length - 1] ?? null;
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1] as Token[];
      const last = line[line.length - 1];
      if (last && last.kind === kind) last.text += part;
      else line.push({ text: part, kind });
    });
  };
  const re = /<span class="([^"]*)">|<\/span>/g;
  let at = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    push(decodeEntities(html.slice(at, m.index)));
    at = m.index + m[0].length;
    if (m[0] === "</span>") {
      if (stack.length > 1) stack.pop();
    } else {
      const parent = stack[stack.length - 1] ?? null;
      const k = kindForScope(scopeOf(m[1] ?? ""));
      stack.push(k === RESET ? null : (k ?? parent));
    }
  }
  push(decodeEntities(html.slice(at)));
  return lines;
}

/** Plain lines of a text (CRLF safe), the shape highlighted lines are matched against. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

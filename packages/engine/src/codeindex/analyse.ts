import type { Node } from "web-tree-sitter";
import { type CodeSymbol, parseSource, symbolsFromTree } from "./symbols";

/**
 * What the code map needs from one file, read in a single parse: its declarations, the modules it
 * imports (as written; resolved to project files later), a simple branch count and, when it looks
 * like one, why it is an entry point. TypeScript, JavaScript and Python imports come from the
 * syntax tree (so comments and strings never count); other languages use careful patterns.
 */

/** `type` = a TypeScript type-only import or export (erased at runtime, so never part of a cycle). */
export type ImportKind =
  | "import"
  | "export"
  | "type"
  | "require"
  | "dynamic"
  | "from"
  | "include"
  | "use"
  | "mod";

export interface RawImport {
  /** The module as written, e.g. `./util`, `@/lib/cn`, `..models`, `app.db`, `crate::db`. */
  spec: string;
  /** Python `from x import name`: the imported name, which may itself be a submodule. */
  name: string;
  kind: ImportKind;
  line: number;
}

export interface SourceAnalysis {
  symbols: CodeSymbol[];
  imports: RawImport[];
  branches: number;
  entry: string | null;
}

/** Bump when extraction changes, so files indexed by an older engine are analysed again. */
export const MAP_VERSION = 1;

const MAX_IMPORTS = 300;

/** Named node types that open a branch (if, loops, case arms, catch, ternaries) across the grammars. */
const BRANCH_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "else_if_clause",
  "if_expression",
  "if",
  "elsif",
  "unless",
  "if_modifier",
  "unless_modifier",
  "for_statement",
  "for_in_statement",
  "enhanced_for_statement",
  "for_each_statement",
  "foreach_statement",
  "for_expression",
  "for",
  "while_statement",
  "while_expression",
  "while",
  "until",
  "do_statement",
  "do_while_statement",
  "loop_expression",
  "switch_case",
  "case_clause",
  "case_statement",
  "switch_section",
  "switch_label",
  "expression_case",
  "type_case",
  "communication_case",
  "match_arm",
  "when_entry",
  "when",
  "switch_statement_case",
  "catch_clause",
  "catch_block",
  "except_clause",
  "rescue",
  "ternary_expression",
  "conditional_expression",
  "conditional",
  "for_in_clause",
  "if_clause",
]);
/** Anonymous operator tokens that add a path. */
const BRANCH_TOKENS = new Set(["&&", "||", "??", "and", "or"]);

type Family = "js" | "python" | "other";

function familyOf(lang: string): Family {
  if (lang === "typescript" || lang === "tsx" || lang === "javascript") return "js";
  if (lang === "python") return "python";
  return "other";
}

export async function analyseSource(rel: string, lang: string | null, text: string): Promise<SourceAnalysis> {
  const entry = entryHint(rel, lang, text);
  if (lang) {
    const parsed = await parseSource(lang, text).catch(() => null);
    if (parsed) {
      try {
        const symbols = symbolsFromTree(parsed.root, text);
        const fam = familyOf(lang);
        const walked = walkTree(parsed.root, fam);
        const imports = fam === "other" ? regexImports(rel, lang, text) : walked.imports;
        return { symbols, imports: imports.slice(0, MAX_IMPORTS), branches: walked.branches, entry };
      } finally {
        parsed.dispose();
      }
    }
  }
  return { symbols: [], imports: regexImports(rel, lang, text).slice(0, MAX_IMPORTS), branches: 0, entry };
}

/** One pass over every node: count branches and collect JS/Python imports. */
function walkTree(root: Node, fam: Family): { imports: RawImport[]; branches: number } {
  const imports: RawImport[] = [];
  let branches = 0;
  const cursor = root.walk();
  const visit = (): boolean => {
    const type = cursor.nodeType;
    if (!cursor.nodeIsNamed) {
      if (BRANCH_TOKENS.has(type)) branches++;
      return false;
    }
    if (BRANCH_TYPES.has(type)) branches++;
    if (fam === "js") {
      if (type === "import_statement" || type === "export_statement") {
        const node = cursor.currentNode;
        const src =
          node.childForFieldName("source") ??
          node.namedChildren.find((c) => c?.type === "import_require_clause")?.childForFieldName("source");
        const spec = src ? stringValue(src) : "";
        if (spec)
          imports.push({
            spec,
            name: "",
            kind: node.children.some((c) => c?.type === "type" && !c.isNamed)
              ? "type"
              : type === "export_statement"
                ? "export"
                : "import",
            line: node.startPosition.row + 1,
          });
        // An export can wrap a declaration with branches inside: keep walking it.
        return type === "export_statement" && !src;
      }
      if (type === "call_expression") {
        const node = cursor.currentNode;
        const fn = node.childForFieldName("function");
        const isImport = fn?.type === "import";
        if (fn && (isImport || (fn.type === "identifier" && fn.text === "require"))) {
          const arg = node.childForFieldName("arguments")?.namedChildren[0];
          const spec = arg ? stringValue(arg) : "";
          if (spec)
            imports.push({
              spec,
              name: "",
              kind: isImport ? "dynamic" : "require",
              line: node.startPosition.row + 1,
            });
        }
      }
    } else if (fam === "python") {
      if (type === "import_statement") {
        const node = cursor.currentNode;
        for (const n of node.childrenForFieldName("name")) {
          const mod = n?.type === "aliased_import" ? n.childForFieldName("name")?.text : n?.text;
          if (mod) imports.push({ spec: mod, name: "", kind: "import", line: node.startPosition.row + 1 });
        }
        return false;
      }
      if (type === "import_from_statement") {
        const node = cursor.currentNode;
        const mod = node.childForFieldName("module_name")?.text.replace(/\s+/g, "") ?? "";
        if (!mod) return false;
        const names = node
          .childrenForFieldName("name")
          .map((n) => (n?.type === "aliased_import" ? n.childForFieldName("name")?.text : n?.text))
          .filter((n): n is string => !!n)
          .slice(0, 20);
        const line = node.startPosition.row + 1;
        if (names.length === 0) imports.push({ spec: mod, name: "", kind: "from", line });
        for (const name of names) imports.push({ spec: mod, name, kind: "from", line });
        return false;
      }
    }
    return true;
  };
  visit();
  let enter = true;
  for (;;) {
    if (enter && cursor.gotoFirstChild()) {
      enter = visit();
      continue;
    }
    let moved = cursor.gotoNextSibling();
    while (!moved) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        return { imports, branches };
      }
      moved = cursor.gotoNextSibling();
    }
    enter = visit();
  }
}

/** The text of a string literal node (`"x"`, `'x'`, or a template without substitutions). */
function stringValue(n: Node): string {
  if (n.type === "string") {
    const frag = n.namedChildren.find((c) => c?.type === "string_fragment");
    return frag?.text ?? "";
  }
  if (n.type === "template_string" && n.namedChildren.every((c) => c?.type === "string_fragment"))
    return n.text.slice(1, -1);
  return "";
}

// ---- patterns for the other languages ---------------------------------------------------------

function lineIndex(text: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const JS_LIKE = /\.(vue|svelte|astro|mdx)$/i;
const CSS_LIKE = /\.(css|scss|sass|less)$/i;

export function regexImports(rel: string, lang: string | null, text: string): RawImport[] {
  const out: RawImport[] = [];
  const lineAt = lineIndex(text);
  const add = (
    re: RegExp,
    kind: ImportKind,
    map: (m: RegExpExecArray) => string | undefined = (m) => m[1],
  ) => {
    for (const m of text.matchAll(re)) {
      const spec = map(m as RegExpExecArray)?.trim();
      if (spec && spec.length <= 300) out.push({ spec, name: "", kind, line: lineAt(m.index ?? 0) });
      if (out.length >= MAX_IMPORTS) return;
    }
  };
  if (lang === "typescript" || lang === "tsx" || lang === "javascript" || JS_LIKE.test(rel)) {
    add(/\bimport\s+type\s+[\w*{}\s,$]+?\s+from\s+["']([^"'\n]+)["']/g, "type");
    add(/\bimport\s+(?!type\s)(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g, "import");
    add(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+["']([^"'\n]+)["']/g, "export");
    add(/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g, "require");
    add(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g, "dynamic");
  } else if (lang === "python") {
    add(/^[ \t]*import\s+([\w.]+)/gm, "import");
    for (const m of text.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+\(?([\w\s,*]+)\)?/gm)) {
      const line = lineAt(m.index ?? 0);
      const names = (m[2] ?? "")
        .split(",")
        .map((s) => s.trim().split(/\s+/)[0] ?? "")
        .filter((s) => s && s !== "*")
        .slice(0, 20);
      if (names.length === 0) out.push({ spec: m[1] ?? "", name: "", kind: "from", line });
      for (const name of names) out.push({ spec: m[1] ?? "", name, kind: "from", line });
    }
  } else if (lang === "go") {
    add(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, "import");
    for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
      const base = block.index ?? 0;
      const body = block[1] ?? "";
      const offset = (block[0] ?? "").indexOf(body);
      for (const m of body.matchAll(/^\s*(?:[\w.]+\s+)?"([^"]+)"/gm))
        if (m[1])
          out.push({ spec: m[1], name: "", kind: "import", line: lineAt(base + offset + (m.index ?? 0)) });
    }
  } else if (lang === "rust") {
    add(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm, "mod");
    add(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+?)(?:::\{[^;]*\}|::\*)?(?:\s+as\s+\w+)?\s*;/gm, "use");
  } else if (lang === "java") {
    add(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm, "import");
  } else if (lang === "kotlin") {
    add(/^\s*import\s+([\w.]+(?:\.\*)?)/gm, "import");
  } else if (lang === "c_sharp") {
    add(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm, "use");
  } else if (lang === "php") {
    add(/^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm, "use");
    add(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"'\n]+)["']/g, "include");
  } else if (lang === "ruby") {
    add(/^\s*require_relative\s*\(?\s*["']([^"'\n]+)["']/gm, "require", (m) =>
      m[1] ? `./${m[1].replace(/^\.\//, "")}` : undefined,
    );
    add(/^\s*require\s*\(?\s*["']([^"'\n]+)["']/gm, "require");
  } else if (lang === "c") {
    add(/^\s*#\s*include\s*"([^"\n]+)"/gm, "include");
  } else if (lang === "dart") {
    add(/^\s*(?:import|export|part)\s+["']([^"'\n]+)["']/gm, "import");
  } else if (CSS_LIKE.test(rel)) {
    add(/@(?:import|use|forward)\s+(?:url\()?["']([^"'\n]+)["']/g, "include");
  } else if (/\.html?$/i.test(rel)) {
    add(/<script\b[^>]*\bsrc=["']([^"'\n]+)["']/gi, "include");
  }
  return out;
}

// ---- entry points ----------------------------------------------------------------------------

const ENTRY_PATTERNS: [RegExp, RegExp, string][] = [
  [/\.pyi?$/, /^if\s+__name__\s*==\s*["']__main__["']\s*:/m, "runs as a script"],
  [/\.py$/, /\bFastAPI\s*\(/, "FastAPI app"],
  [/\.py$/, /\bFlask\s*\(\s*__name__/, "Flask app"],
  [/\.py$/, /\buvicorn\.run\s*\(/, "starts a server"],
  [/\.(m|c)?[jt]sx?$/, /^#!.*\b(node|bun|deno|tsx)\b/, "command line tool"],
  [/\.(m|c)?[jt]sx?$/, /\bBun\.serve\s*\(|\bDeno\.serve\s*\(/, "starts a server"],
  [/\.(m|c)?[jt]sx?$/, /\.listen\s*\(\s*(?:\d|port\b|PORT\b|process\.env|config\.)/, "starts a server"],
  [
    /\.(m|c)?[jt]sx?$/,
    /\bcreateRoot\s*\([^)]*\)\s*\.render\s*\(|ReactDOM\.render\s*\(/,
    "mounts the React app",
  ],
  [/\.(m|c)?[jt]sx?$/, /\bcreateApp\s*\([\s\S]{0,200}?\.mount\s*\(/, "mounts the Vue app"],
  [/\.go$/, /^package\s+main\b[\s\S]*\bfunc\s+main\s*\(/m, "Go main package"],
  [/\.rs$/, /^\s*(?:async\s+)?fn\s+main\s*\(/m, "main function"],
  [/\.java$/, /\bpublic\s+static\s+void\s+main\s*\(/, "main method"],
  [/\.kts?$/, /^\s*fun\s+main\s*\(/m, "main function"],
  [/\.cs$/, /\bstatic\s+(?:async\s+)?[\w<>]+\s+Main\s*\(/, "Main method"],
  [/\.dart$/, /^\s*(?:Future<void>|void)?\s*main\s*\(/m, "main function"],
  [/\.(c|cc|cpp)$/, /^\s*int\s+main\s*\(/m, "main function"],
];

export function entryHint(rel: string, lang: string | null, text: string): string | null {
  if (!lang && !/\.(m|c)?[jt]sx?$/.test(rel)) return null;
  const head = text.length > 200_000 ? text.slice(0, 200_000) : text;
  for (const [file, re, why] of ENTRY_PATTERNS) if (file.test(rel) && re.test(head)) return why;
  return null;
}

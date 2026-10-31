import fs from "node:fs";
import { Language, type Node, Parser } from "web-tree-sitter";
import { LANGUAGES, TREE_SITTER_RUNTIME } from "./languages";

export interface CodeSymbol {
  name: string;
  /** function | method | class | interface | struct | enum | trait | type | module | impl | constant */
  kind: string;
  parent: string | null;
  startLine: number;
  endLine: number;
  /** The declaration's first line, trimmed (what a repo map shows). */
  signature: string;
}

let ready: Promise<void> | null = null;
const loaded = new Map<string, Promise<Language>>();

function init(): Promise<void> {
  ready ??= Parser.init({
    // Emscripten asks where its .wasm lives; give it the embedded file's bytes directly.
    wasmBinary: fs.readFileSync(TREE_SITTER_RUNTIME),
    locateFile: () => TREE_SITTER_RUNTIME,
  } as object);
  return ready;
}

async function language(name: string): Promise<Language | null> {
  const l = LANGUAGES[name];
  if (!l) return null;
  let p = loaded.get(name);
  if (!p) {
    p = init().then(() => Language.load(fs.readFileSync(l.wasm)));
    loaded.set(name, p);
  }
  return p;
}

/** Node types that declare something worth listing, by keyword in the type name. */
const KIND_WORDS: [RegExp, string][] = [
  [/method|constructor/, "method"],
  [/function|func_literal|arrow_function|lambda/, "function"],
  [/class|object_declaration/, "class"],
  [/interface|protocol/, "interface"],
  [/struct/, "struct"],
  [/enum/, "enum"],
  [/trait|mixin|extension/, "trait"],
  [/impl/, "impl"],
  [/type_alias|type_declaration|type_item|type_spec|typedef/, "type"],
  [/module|namespace|mod_item|package/, "module"],
];
const DECL = /(definition|declaration|item|spec|signature|statement|specifier)$/;

function kindOf(type: string): string | null {
  if (!DECL.test(type) && !/^(class|function|method)$/.test(type)) return null;
  if (
    /^(import|use|expression|return|if|for|while|variable|lexical|local|assignment|field|parameter)/.test(
      type,
    )
  )
    return null;
  for (const [re, kind] of KIND_WORDS) if (re.test(type)) return kind;
  return null;
}

function nameOf(n: Node): string | null {
  const named = n.childForFieldName("name") ?? n.childForFieldName("declarator");
  if (named) {
    // C-style declarators nest the name: function_declarator → identifier.
    const id = named.type.endsWith("identifier") ? named : named.descendantsOfType("identifier")[0];
    return (id ?? named).text.split("(")[0]?.trim() || null;
  }
  // `impl Foo for Bar` and similar have a type instead of a name.
  const t = n.childForFieldName("type");
  return t ? t.text.slice(0, 80) : null;
}

/** Top-level and nested declarations (classes, functions, methods …) of one source file. */
export async function extractSymbols(langName: string, source: string): Promise<CodeSymbol[]> {
  const lang = await language(langName);
  if (!lang) return [];
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return [];
  const lines = source.split("\n");
  const out: CodeSymbol[] = [];
  const visit = (n: Node, parent: string | null, depth: number) => {
    if (depth > 12) return;
    let kind = kindOf(n.type);
    // `struct P;` uses (no body) are references, not declarations.
    if (kind && n.type.endsWith("specifier") && !n.childForFieldName("body")) kind = null;
    // `const f = () => …` declares a function too.
    if (!kind && n.type === "variable_declarator") {
      const v = n.childForFieldName("value");
      if (v && /arrow_function|function/.test(v.type)) kind = "function";
    }
    let nextParent = parent;
    if (kind) {
      const name = nameOf(n);
      if (name && name.length <= 120) {
        const line = n.startPosition.row;
        out.push({
          name,
          kind: kind === "function" && parent ? "method" : kind,
          parent,
          startLine: line + 1,
          endLine: n.endPosition.row + 1,
          signature: (lines[line] ?? "").trim().slice(0, 200),
        });
        if (kind !== "function" && kind !== "method") nextParent = name;
        // Do not list local helpers inside function bodies.
        if (kind === "function" || kind === "method") return;
      }
    }
    for (const c of n.namedChildren) if (c) visit(c, nextParent, depth + 1);
  };
  visit(tree.rootNode, null, 0);
  tree.delete();
  parser.delete();
  return out;
}

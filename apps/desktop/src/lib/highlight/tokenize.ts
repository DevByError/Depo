import type { HLJSApi, LanguageFn } from "highlight.js";
import { type GrammarName, grammarFor, type LanguageId } from "./languages";
import { htmlToLines, type Token } from "./tokens";

/**
 * Turns code into highlighted lines. Runs in the highlight worker (or on the main thread when
 * workers are unavailable). highlight.js core and each grammar load on first use, so a project of
 * Python files never downloads the Rust grammar.
 */

type GrammarModule = { default: LanguageFn };

// One dynamic import per grammar: the bundler gives each its own small chunk.
const GRAMMARS: Record<GrammarName, () => Promise<GrammarModule>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  python: () => import("highlight.js/lib/languages/python"),
  json: () => import("highlight.js/lib/languages/json"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  less: () => import("highlight.js/lib/languages/less"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  sql: () => import("highlight.js/lib/languages/sql"),
  bash: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/shell"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  dos: () => import("highlight.js/lib/languages/dos"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  php: () => import("highlight.js/lib/languages/php"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  diff: () => import("highlight.js/lib/languages/diff"),
};

/** Grammars a grammar hands parts of its text to (JSX tags, CSS in HTML, RUN lines in a Dockerfile). */
const EMBEDS: Partial<Record<GrammarName, GrammarName[]>> = {
  typescript: ["xml"],
  javascript: ["xml"],
  xml: ["css", "javascript"],
  markdown: ["xml"],
  dockerfile: ["bash"],
  shell: ["bash"],
  php: ["xml"],
};

let core: Promise<HLJSApi> | null = null;
const loading = new Map<GrammarName, Promise<void>>();
const loaded = new Set<GrammarName>();

function loadCore(): Promise<HLJSApi> {
  core ??= import("highlight.js/lib/core").then((m) => m.default);
  return core;
}

function ensureGrammar(hljs: HLJSApi, name: GrammarName): Promise<void> {
  let p = loading.get(name);
  if (!p) {
    p = GRAMMARS[name]().then((m) => {
      hljs.registerLanguage(name, m.default);
      loaded.add(name);
    });
    loading.set(name, p);
    // A failed download can be tried again later.
    p.catch(() => loading.delete(name));
  }
  return p;
}

/** Load a grammar and the grammars it embeds (embedded ones are optional: plain text if they fail). */
async function ensureLanguage(hljs: HLJSApi, name: GrammarName): Promise<void> {
  await ensureGrammar(hljs, name);
  await Promise.all((EMBEDS[name] ?? []).map((n) => ensureGrammar(hljs, n).catch(() => undefined)));
}

/** Grammars loaded so far (for tests and diagnostics). */
export function loadedGrammars(): GrammarName[] {
  return [...loaded].sort();
}

export async function tokenize(code: string, lang: LanguageId): Promise<Token[][]> {
  const hljs = await loadCore();
  const grammar = grammarFor(lang);
  await ensureLanguage(hljs, grammar);
  const result = hljs.highlight(code.replace(/\r\n?/g, "\n"), { language: grammar, ignoreIllegals: true });
  return htmlToLines(result.value);
}

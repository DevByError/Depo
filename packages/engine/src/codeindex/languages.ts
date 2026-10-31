// Grammars are embedded into the engine executable (Bun `type: "file"` imports), so the code
// index works offline with no downloads. Paths point into the executable when compiled.

import cWasm from "tree-sitter-wasms/out/tree-sitter-c.wasm" with { type: "file" };
import c_sharpWasm from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm" with { type: "file" };
import dartWasm from "tree-sitter-wasms/out/tree-sitter-dart.wasm" with { type: "file" };
import goWasm from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import javaWasm from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import javascriptWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import kotlinWasm from "tree-sitter-wasms/out/tree-sitter-kotlin.wasm" with { type: "file" };
import phpWasm from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import pythonWasm from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import rubyWasm from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };
import rustWasm from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import runtimeWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

export const TREE_SITTER_RUNTIME: string = runtimeWasm;

export const LANGUAGES: Record<string, { wasm: string; extensions: string[] }> = {
  python: { wasm: pythonWasm, extensions: [".py", ".pyi"] },
  typescript: { wasm: typescriptWasm, extensions: [".ts", ".mts", ".cts"] },
  tsx: { wasm: tsxWasm, extensions: [".tsx"] },
  javascript: { wasm: javascriptWasm, extensions: [".js", ".mjs", ".cjs", ".jsx"] },
  go: { wasm: goWasm, extensions: [".go"] },
  rust: { wasm: rustWasm, extensions: [".rs"] },
  java: { wasm: javaWasm, extensions: [".java"] },
  c_sharp: { wasm: c_sharpWasm, extensions: [".cs"] },
  kotlin: { wasm: kotlinWasm, extensions: [".kt", ".kts"] },
  php: { wasm: phpWasm, extensions: [".php"] },
  dart: { wasm: dartWasm, extensions: [".dart"] },
  ruby: { wasm: rubyWasm, extensions: [".rb"] },
  c: { wasm: cWasm, extensions: [".c", ".h"] },
};

const BY_EXT = new Map<string, string>();
for (const [name, l] of Object.entries(LANGUAGES)) for (const e of l.extensions) BY_EXT.set(e, name);

export function languageFor(file: string): string | null {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? null : (BY_EXT.get(file.slice(dot).toLowerCase()) ?? null);
}

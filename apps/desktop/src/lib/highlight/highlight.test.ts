import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHighlightCache,
  highlightCode,
  highlightKey,
  highlightStats,
  isTooLarge,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
} from "./highlighter";
import { languageForFence, languageForPath, languageLabel } from "./languages";
import { loadedGrammars, tokenize } from "./tokenize";
import { htmlToLines, type Token } from "./tokens";
import { useDiffHighlight, useHighlight } from "./use-highlight";

const text = (line: Token[] | undefined) => (line ?? []).map((t) => t.text).join("");
const kindOf = (line: Token[] | undefined, piece: string) => line?.find((t) => t.text.includes(piece))?.kind;

beforeEach(() => clearHighlightCache());

describe("language detection", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["web/src/App.tsx", "tsx"],
    ["lib/util.mjs", "javascript"],
    ["components/Button.jsx", "jsx"],
    ["app\\main.py", "python"],
    ["package.json", "json"],
    ["styles/site.css", "css"],
    ["public/index.html", "html"],
    ["docs/README.md", "markdown"],
    [".github/workflows/ci.yml", "yaml"],
    ["pyproject.toml", "toml"],
    ["db/schema.sql", "sql"],
    ["scripts/setup.sh", "bash"],
    ["scripts/Build Tools.ps1", "powershell"],
    ["C:\\Users\\Ana\\My Project\\run.bat", "batch"],
    ["tools/build.cmd", "batch"],
    ["cmd/server/main.go", "go"],
    ["src/lib.rs", "rust"],
    ["src/main/java/App.java", "java"],
    ["Api/Program.cs", "csharp"],
    ["Dockerfile", "dockerfile"],
    ["deploy/Dockerfile.prod", "dockerfile"],
    ["Makefile", "makefile"],
    [".env.local", "ini"],
  ])("%s is %s", (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });

  it("unknown files have no language", () => {
    expect(languageForPath("LICENSE")).toBeNull();
    expect(languageForPath("photo.png")).toBeNull();
    expect(languageForPath("")).toBeNull();
  });

  it.each([
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["js", "javascript"],
    ["python title=app.py", "python"],
    ["py", "python"],
    ["json", "json"],
    ["yml", "yaml"],
    ["toml", "toml"],
    ["sh", "bash"],
    ["console", "console"],
    ["powershell", "powershell"],
    ["pwsh", "powershell"],
    ["bat", "batch"],
    ["cmd", "batch"],
    ["golang", "go"],
    ["rs", "rust"],
    ["c#", "csharp"],
    ["Dockerfile", "dockerfile"],
    ["{.rust}", "rust"],
    ["app/main.py", "python"],
    ["html", "html"],
    ["css", "css"],
    ["sql", "sql"],
    ["md", "markdown"],
    ["java", "java"],
  ])("a ```%s fence is %s", (info, lang) => {
    expect(languageForFence(info)).toBe(lang);
  });

  it("unknown fences have no language and keep their own label", () => {
    expect(languageForFence("")).toBeNull();
    expect(languageForFence("text")).toBeNull();
    expect(languageForFence("brainfuck")).toBeNull();
    expect(languageLabel(null, "brainfuck")).toBe("brainfuck");
    expect(languageLabel(null, "")).toBe("Text");
    expect(languageLabel("csharp")).toBe("C#");
  });
});

describe("tokens", () => {
  it("reads highlight.js output into lines and carries a scope across lines", () => {
    const lines = htmlToLines(
      '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &amp; y&quot;</span>;\n<span class="hljs-comment">/* one\ntwo */</span>',
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([
      { text: "const", kind: "keyword" },
      { text: " a = ", kind: null },
      { text: '"x & y"', kind: "string" },
      { text: ";", kind: null },
    ]);
    expect(lines[1]).toEqual([{ text: "/* one", kind: "comment" }]);
    expect(lines[2]).toEqual([{ text: "two */", kind: "comment" }]);
  });

  it("maps dotted scopes and resets the colour inside template substitutions", () => {
    const lines = htmlToLines(
      '<span class="hljs-title function_">go</span><span class="hljs-string">`a<span class="hljs-subst">#{b}</span>`</span>',
    );
    expect(lines[0]).toEqual([
      { text: "go", kind: "function" },
      { text: "`a", kind: "string" },
      { text: "#{b}", kind: null },
      { text: "`", kind: "string" },
    ]);
  });

  it("highlights the required languages without losing a character", async () => {
    const samples: [Parameters<typeof tokenize>[1], string, string, string][] = [
      ["typescript", "const n: number = 1; // one", "const", "keyword"],
      ["tsx", "export const A = () => <div className={x}>hi</div>;", "div", "tag"],
      ["python", 'def main():\n    return "hi"  # done', "def", "keyword"],
      ["json", '{ "name": "depo", "n": 2 }', '"depo"', "string"],
      ["css", ".btn { color: red; }", ".btn", "type"],
      ["html", '<a href="/x">x</a>', "href", "property"],
      ["markdown", "# Title\n\nSome *text*.", "# Title", "section"],
      ["yaml", "name: depo\nport: 8080", "8080", "number"],
      ["toml", '[tool]\nname = "depo"', '"depo"', "string"],
      ["sql", "SELECT id FROM users WHERE id = 1;", "SELECT", "keyword"],
      ["bash", 'echo "hi" && exit 1', "echo", "builtin"],
      ["powershell", "Get-ChildItem -Path . | Where-Object { $_.Length -gt 0 }", "Get-ChildItem", "builtin"],
      ["batch", "@echo off\nset NAME=depo", "set", "builtin"],
      ["go", 'func main() { fmt.Println("hi") }', "func", "keyword"],
      ["rust", 'fn main() { println!("hi"); }', "fn", "keyword"],
      ["java", "public class App { }", "public", "keyword"],
      ["csharp", "public sealed class App { }", "public", "keyword"],
      ["dockerfile", "FROM node:22\nRUN npm ci", "FROM", "keyword"],
    ];
    for (const [lang, code, piece, kind] of samples) {
      const lines = await tokenize(code, lang);
      expect(lines.map(text).join("\n"), lang).toBe(code);
      expect(kindOf(lines.flat(), piece), `${lang}: ${piece}`).toBe(kind);
    }
  });

  it("keeps line count with Windows line endings", async () => {
    const lines = await tokenize("a = 1\r\nb = 2\r\n", "python");
    expect(lines.map(text)).toEqual(["a = 1", "b = 2", ""]);
  });
});

describe("highlighter", () => {
  it("loads a grammar only when its language is first used", async () => {
    // Rust is used by no other test in this file before this one, Swift by none at all.
    expect(loadedGrammars()).not.toContain("swift");
    await highlightCode("let x = 1;", "rust");
    expect(loadedGrammars()).toContain("rust");
    expect(loadedGrammars()).not.toContain("swift");
  });

  it("caches by language and content", async () => {
    const code = "def f():\n    return 1\n";
    const a = await highlightCode(code, "python");
    const b = await highlightCode(code, "python");
    expect(a.status).toBe("ready");
    expect(b).toEqual(a);
    expect(highlightStats()).toMatchObject({ runs: 1, hits: 1, cached: 1 });
    // Same text, another language: highlighted again.
    await highlightCode(code, "ruby");
    expect(highlightStats().runs).toBe(2);
    expect(highlightKey(code, "python")).not.toBe(highlightKey(code, "ruby"));
  });

  it("shares one run between callers that ask at the same time", async () => {
    const code = "SELECT 1;";
    const [a, b] = await Promise.all([highlightCode(code, "sql"), highlightCode(code, "sql")]);
    expect(a).toEqual(b);
    expect(highlightStats().runs).toBe(1);
  });

  it("skips code above the size limit", async () => {
    expect(isTooLarge("x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(true);
    expect(isTooLarge("\n".repeat(MAX_HIGHLIGHT_LINES))).toBe(true);
    expect(isTooLarge("\n".repeat(MAX_HIGHLIGHT_LINES - 1))).toBe(false);
    expect(await highlightCode("a\n".repeat(MAX_HIGHLIGHT_LINES + 5), "python")).toEqual({ status: "large" });
    expect(highlightStats().runs).toBe(0);
  });
});

describe("useHighlight", () => {
  it("is plain for an unknown language and does no work", () => {
    const { result } = renderHook(() => useHighlight("some text", null));
    expect(result.current).toEqual({ state: "plain", lines: null });
    expect(highlightStats().runs).toBe(0);
  });

  it("loads, then shows the colours; a second view of the same code is ready at once", async () => {
    const code = "const a = 1;";
    const first = renderHook(() => useHighlight(code, "typescript"));
    expect(first.result.current.state).toBe("loading");
    await waitFor(() => expect(first.result.current.state).toBe("ready"));
    expect(kindOf(first.result.current.lines?.[0], "const")).toBe("keyword");
    const second = renderHook(() => useHighlight(code, "typescript"));
    expect(second.result.current.state).toBe("ready");
    expect(highlightStats().runs).toBe(1);
  });

  it("says large above the limit", () => {
    const { result } = renderHook(() => useHighlight("x".repeat(MAX_HIGHLIGHT_CHARS + 10), "typescript"));
    expect(result.current.state).toBe("large");
  });

  it("follows new code", async () => {
    const { result, rerender } = renderHook(({ code }) => useHighlight(code, "python"), {
      initialProps: { code: "x = 1" },
    });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({ code: "def g(): pass" });
    await waitFor(() => expect(kindOf(result.current.lines?.[0], "def")).toBe("keyword"));
  });

  it("gives each diff row the tokens of its side, keeping a multi-line comment coloured", async () => {
    const rows = [
      { t: " ", text: "/* start" },
      { t: "-", text: "old */ const a = 1;" },
      { t: "+", text: "new */ let a = 2;" },
    ];
    const { result } = renderHook(() => useDiffHighlight(rows, "typescript"));
    await waitFor(() => expect(result.current.tokens.every((r) => r !== null)).toBe(true));
    expect(result.current.large).toBe(false);
    const [ctx, removed, added] = result.current.tokens;
    expect(text(ctx ?? undefined)).toBe("/* start");
    expect(text(removed ?? undefined)).toBe("old */ const a = 1;");
    expect(kindOf(removed ?? undefined, "old */")).toBe("comment");
    expect(kindOf(removed ?? undefined, "const")).toBe("keyword");
    expect(text(added ?? undefined)).toBe("new */ let a = 2;");
    expect(kindOf(added ?? undefined, "let")).toBe("keyword");
    await act(async () => undefined);
  });
});

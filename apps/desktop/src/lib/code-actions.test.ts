import { beforeEach, describe, expect, it } from "vitest";
import { prefill, useComposer } from "@/store/composer";
import {
  ASK_MAX_LINES,
  askText,
  changeText,
  EXCERPT_LINES,
  fenced,
  linesLabel,
  pathLine,
} from "./code-actions";
import { languageForFence } from "./highlight/languages";

const sel = (count: number, start = 1) => ({
  path: "src/app.ts",
  start,
  end: start + count - 1,
  lines: Array.from({ length: count }, (_, i) => `line ${start + i}`),
  lang: "typescript" as const,
});

describe("line actions text", () => {
  it("names places plainly", () => {
    expect(pathLine("a/b.py", 3, 3)).toBe("a/b.py:3");
    expect(pathLine("a/b.py", 3, 9)).toBe("a/b.py:3-9");
    expect(linesLabel(4, 4)).toBe("line 4");
    expect(linesLabel(4, 6)).toBe("lines 4 to 6");
  });

  it("asks about at most 80 lines and says so", () => {
    const text = askText(sel(120));
    const code = text.split("```")[1]?.split("\n").slice(1, -1) ?? [];
    expect(code).toHaveLength(ASK_MAX_LINES);
    expect(code[0]).toBe("line 1");
    expect(text.startsWith("Explain what lines 1 to 120 of `src/app.ts` do.")).toBe(true);
    expect(text).toContain("Only the first 80 of 120 selected lines are shown.");
    expect(text.length).toBeLessThan(20_000);
  });

  it("keeps the question under the task size limit even for minified lines", () => {
    const text = askText({ ...sel(80), lines: Array.from({ length: 80 }, () => "x".repeat(5000)) });
    expect(text.length).toBeLessThan(20_000);
  });

  it("starts a change with a short excerpt and the caret after the heading", () => {
    const { text, cursor } = changeText(sel(30, 10));
    expect(text.slice(0, cursor)).toBe("Change lines 10 to 39 of `src/app.ts`: ");
    expect(text).toContain(`Only the first ${EXCERPT_LINES} of 30 selected lines are shown.`);
  });

  it("fences code that itself holds backticks, tagged with a language the chat understands", () => {
    const block = fenced("const s = `x`;\n```\nmore", "typescript");
    expect(block.startsWith("````typescript\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
    expect(languageForFence("typescript")).toBe("typescript");
    expect(languageForFence("batch")).toBe("batch");
    expect(languageForFence("csharp")).toBe("csharp");
  });
});

describe("composer prefill", () => {
  beforeEach(() => useComposer.setState({ pending: null }));

  it("is read once", () => {
    prefill("Change this: ", { cursor: 7, mode: "fix" });
    expect(useComposer.getState().pending).toMatchObject({ text: "Change this: ", cursor: 7, mode: "fix" });
    expect(useComposer.getState().take()?.text).toBe("Change this: ");
    expect(useComposer.getState().take()).toBeNull();
  });

  it("puts the caret at the end by default and keeps it inside the text", () => {
    prefill("abc");
    expect(useComposer.getState().pending?.cursor).toBe(3);
    prefill("abc", { cursor: 99 });
    expect(useComposer.getState().pending?.cursor).toBe(3);
  });
});

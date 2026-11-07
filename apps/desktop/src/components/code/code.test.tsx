import type { ChatItem, GitFileDiff } from "@depo/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLog } from "@/components/chat/WorkLog";
import { CommitDiff } from "@/components/git/CommitDiff";
import { Markdown } from "@/components/panels/Markdown";
import type { Token } from "@/lib/highlight/tokens";
import { Tokens } from "./Tokens";

const writeText = vi.fn(async (_text: string) => undefined);
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

describe("chat code blocks", () => {
  it("show the language, colours and a Copy button", async () => {
    const { container } = render(
      <Markdown text={"Here is the fix:\n\n```ts\nconst a: number = 1;\n// done\n```\n\nThat is all."} />,
    );
    const block = screen.getByRole("figure", { name: "TypeScript code" });
    expect(block.tabIndex).toBe(0);
    expect(container.textContent).toContain("TypeScript");
    await waitFor(() => expect(block.querySelector(".tok-keyword")?.textContent).toBe("const"));
    expect(block.querySelector(".tok-comment")?.textContent).toBe("// done");
    expect(block.textContent).toBe("const a: number = 1;\n// done");
    expect(container.textContent).toContain("That is all.");

    fireEvent.click(screen.getByRole("button", { name: "Copy TypeScript code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a: number = 1;\n// done"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("an unknown language keeps its name and shows plain text", async () => {
    render(<Markdown text={"```brainfuck\n++[>+<-]\n```"} />);
    const block = screen.getByRole("figure", { name: "brainfuck code" });
    expect(block.textContent).toBe("++[>+<-]");
    await new Promise((r) => setTimeout(r, 30));
    expect(block.querySelector("[class^='tok-']")).toBeNull();
  });

  it("a block without a language is Text; a longer fence can hold ``` inside", () => {
    render(<Markdown text={"````\nUse a fence:\n```py\nx = 1\n```\n````\nafter"} />);
    const block = screen.getByRole("figure", { name: "Text code" });
    expect(block.textContent).toBe("Use a fence:\n```py\nx = 1\n```");
    expect(screen.getAllByRole("figure")).toHaveLength(1);
  });

  it("Python from a file-name fence", async () => {
    render(<Markdown text={"```app/main.py\ndef main():\n    pass\n```"} />);
    const block = screen.getByRole("figure", { name: "Python code" });
    await waitFor(() => expect(block.querySelector(".tok-keyword")?.textContent).toBe("def"));
  });
});

describe("Tokens", () => {
  it("never shows tokens that do not spell the line (stale colours while streaming)", () => {
    const stale: Token[] = [
      { text: "const", kind: "keyword" },
      { text: " a", kind: null },
    ];
    const { container, rerender } = render(<Tokens tokens={stale} text="const a" />);
    expect(container.querySelector(".tok-keyword")).toBeTruthy();
    rerender(<Tokens tokens={stale} text="const ab" />);
    expect(container.querySelector(".tok-keyword")).toBeNull();
    expect(container.textContent).toBe("const ab");
  });
});

let n = 0;
const tool = (toolName: string, text: string, args?: ChatItem["args"]): ChatItem => ({
  id: `m${++n}`,
  role: "tool",
  text,
  toolName,
  isError: false,
  agent: null,
  createdAt: "2026-11-07T10:00:10Z",
  args,
});

describe("work log", () => {
  it("colours an edit's diff and a written file", async () => {
    render(
      <WorkLog
        id="t-code"
        steps={[
          tool("edit_file", "Applied 1 edit(s) to app/main.py.", {
            path: "app/main.py",
            edits: [{ search: "def old():\n    return 1", replace: "def new():\n    return 2" }],
          }),
          tool("write_file", "Wrote web/app.ts", { path: "web/app.ts", content: "export const x = 1;\n" }),
        ]}
        state="done"
        startedAt="2026-11-07T10:00:00Z"
        endedAt="2026-11-07T10:01:00Z"
        live={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show the work/ }));
    const list = screen.getByRole("list", { name: "Steps" });
    fireEvent.click(within(list).getByRole("button", { name: /Edited app\/main\.py/ }));
    const diff = screen.getByRole("figure", { name: "Change 1 of 1 in app/main.py" });
    await waitFor(() => expect(diff.querySelectorAll(".tok-keyword").length).toBeGreaterThanOrEqual(2));
    expect(diff.textContent).toContain("Removed: def old():");
    expect(diff.textContent).toContain("Added: def new():");

    fireEvent.click(within(list).getByRole("button", { name: /web\/app\.ts/ }));
    const written = screen.getByRole("figure", { name: "Content written to web/app.ts" });
    await waitFor(() => expect(written.querySelector(".tok-keyword")?.textContent).toBe("export"));
    expect(written.textContent).toBe("export const x = 1;\n");
  });
});

describe("history diffs", () => {
  const file = (path: string): GitFileDiff => ({
    path,
    oldPath: null,
    kind: "modified",
    binary: false,
    additions: 1,
    deletions: 1,
    truncated: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-let a = 1;", "+const a = 2;"] }],
  });

  it("colours open files and leaves closed ones until they are opened", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map(file);
    const { container } = render(<CommitDiff files={files} />);
    const blocks = container.querySelectorAll("details");
    await waitFor(() => expect(blocks[0]?.querySelector(".tok-keyword")?.textContent).toBe("let"));
    expect(blocks[0]?.querySelector("tr.bg-success\\/12 .tok-keyword")?.textContent).toBe("const");
    const sixth = blocks[5] as HTMLDetailsElement;
    expect(sixth.open).toBe(false);
    expect(sixth.querySelector(".tok-keyword")).toBeNull();
    sixth.open = true;
    fireEvent(sixth, new Event("toggle"));
    await waitFor(() => expect(sixth.querySelector(".tok-keyword")).toBeTruthy());
  });
});

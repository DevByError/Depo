import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HIGHLIGHT_CHARS } from "@/lib/highlight/highlighter";
import { useComposer } from "@/store/composer";
import { useEngine } from "@/store/engine";
import { requestFile, useNav } from "@/store/nav";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    return Promise.resolve(f(params));
  },
}));

import { Composer } from "@/components/chat/Composer";
import { FilesPanel, parentDirs } from "./FilesPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const entry = (path: string, type: "file" | "dir") => ({
  name: path.split("/").pop() ?? path,
  path,
  type,
  size: type === "file" ? 10 : null,
});

const CODE = [
  "export const a = 1;",
  "export function f(x: number) {",
  "  return x + 1;",
  "}",
  "const b = 'two';",
  "// end",
  "",
].join("\n");

let files: Record<string, string> = {};
let tree: Record<string, ReturnType<typeof entry>[]> = {};
const scrolled: Element[] = [];
const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  calls.length = 0;
  scrolled.length = 0;
  writeText.mockClear();
  for (const k of Object.keys(responses)) delete responses[k];
  files = { "src/app.ts": CODE };
  tree = { ".": [entry("src", "dir")], src: [entry("src/app.ts", "file")] };
  responses["files.list"] = (p) => ({ entries: tree[(p as { path: string }).path] ?? [] });
  responses["files.read"] = (p) => {
    const path = (p as { path: string }).path;
    const text = files[path] ?? "";
    return { path, text, binary: false, size: text.length, truncated: false };
  };
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", taskId: null, centerTab: "files" });
  useNav.getState().clearFile();
  useComposer.setState({ pending: null });
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

/** Open src/app.ts and wait until its lines are there. */
async function openApp(line: number | null = null) {
  requestFile("src/app.ts", line);
  const view = wrap(<FilesPanel />);
  const viewer = await screen.findByRole("region", { name: "File src/app.ts" });
  await screen.findByRole("button", { name: "Line 1" });
  return { ...view, viewer };
}

const lineButton = (n: number) => screen.getByRole("button", { name: `Line ${n}` });
const pressed = () =>
  screen
    .getAllByRole("button", { name: /^Line \d+$/ })
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => Number(b.textContent));
const toolbar = () => screen.queryByRole("toolbar", { name: "Selected lines" });

describe("Files tree", () => {
  it("lists the folders to open for a path", () => {
    expect(parentDirs("web/src/lib/cn.ts")).toEqual(["web", "web/src", "web/src/lib"]);
    expect(parentDirs("README.md")).toEqual([]);
    expect(parentDirs("./a/b.py")).toEqual(["a"]);
  });

  it("opens the folders above a requested file, scrolls to it and flashes the line", async () => {
    tree = {
      ".": [entry("web", "dir"), entry("README.md", "file")],
      web: [entry("web/src", "dir")],
      "web/src": [entry("web/src/lib", "dir")],
      "web/src/lib": [entry("web/src/lib/cn.ts", "file")],
    };
    files = { "web/src/lib/cn.ts": CODE, "README.md": "# Hello\n" };
    requestFile("web\\src\\lib\\cn.ts", 3);
    wrap(<FilesPanel />);

    const nav = screen.getByRole("navigation", { name: "Project files" });
    const file = await within(nav).findByRole("button", { name: "cn.ts" });
    expect(file.getAttribute("aria-current")).toBe("true");
    for (const dir of ["web", "src", "lib"])
      expect(within(nav).getByRole("button", { name: dir }).getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(scrolled).toContain(file));

    const viewer = screen.getByRole("region", { name: "File web/src/lib/cn.ts" });
    await waitFor(() => expect(viewer.querySelector('[data-line="3"]')).toBeTruthy());
    const row = viewer.querySelector('[data-line="3"]') as HTMLElement;
    expect(row.className).toContain("bg-accent-soft");
    expect(scrolled).toContain(row);
    // Keyboard users land on the requested line.
    expect(lineButton(3).tabIndex).toBe(0);
    expect(lineButton(1).tabIndex).toBe(-1);

    // Another file opened from elsewhere while the tab is open follows too.
    act(() => requestFile("README.md"));
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: "README.md" }).getAttribute("aria-current")).toBe(
        "true",
      ),
    );
    expect(await screen.findByRole("region", { name: "File README.md" })).toBeTruthy();
    expect(useNav.getState().file).toBeNull();
  });

  it("coming back to Files shows the file that was open", async () => {
    await openApp();
    cleanup();
    wrap(<FilesPanel />);
    expect(await screen.findByRole("region", { name: "File src/app.ts" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Project files" });
    expect((await within(nav).findByRole("button", { name: "app.ts" })).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("shows the code with colours and the language", async () => {
    const { viewer } = await openApp();
    await waitFor(() => expect(viewer.querySelector(".tok-keyword")?.textContent).toBe("export"));
    expect(viewer.querySelector(".tok-comment")?.textContent).toBe("// end");
    expect(viewer.textContent).toContain("TypeScript");
    expect(viewer.querySelector('[data-line="2"]')?.textContent).toContain("export function f(x: number) {");
  });

  it("says when a file is too large for colours", async () => {
    files = { "src/app.ts": `const big = "${"x".repeat(MAX_HIGHLIGHT_CHARS)}";\n` };
    const { viewer } = await openApp();
    expect(await within(viewer).findByText("Large file: shown without colours")).toBeTruthy();
    expect(viewer.querySelector("[class^='tok-']")).toBeNull();
  });
});

describe("selecting lines", () => {
  it("click picks a line, Shift+click a range", async () => {
    await openApp();
    fireEvent.click(lineButton(2));
    expect(pressed()).toEqual([2]);
    expect(toolbar()?.textContent).toContain("Line 2");
    fireEvent.click(lineButton(4), { shiftKey: true });
    expect(pressed()).toEqual([2, 3, 4]);
    expect(toolbar()?.textContent).toContain("Lines 2 to 4");
    // Shift+click above the first line extends upwards from the same anchor.
    fireEvent.click(lineButton(1), { shiftKey: true });
    expect(pressed()).toEqual([1, 2]);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(toolbar()).toBeNull();
    expect(pressed()).toEqual([]);
  });

  it("works from the keyboard: arrows move, Shift extends, Enter picks, Escape clears", async () => {
    await openApp();
    // One tab stop in the gutter.
    expect(
      screen.getAllByRole("button", { name: /^Line \d+$/ }).filter((b) => b.tabIndex === 0),
    ).toHaveLength(1);
    lineButton(1).focus();
    fireEvent.keyDown(lineButton(1), { key: "ArrowDown" });
    expect(document.activeElement).toBe(lineButton(2));
    expect(lineButton(2).tabIndex).toBe(0);
    expect(toolbar()).toBeNull();

    fireEvent.keyDown(lineButton(2), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(lineButton(3), { key: "ArrowDown", shiftKey: true });
    expect(pressed()).toEqual([2, 3, 4]);
    expect(document.activeElement).toBe(lineButton(4));
    expect(toolbar()?.textContent).toContain("Lines 2 to 4");

    fireEvent.keyDown(lineButton(4), { key: "Enter" });
    expect(pressed()).toEqual([4]);
    fireEvent.keyDown(lineButton(4), { key: "End" });
    expect(document.activeElement).toBe(lineButton(6));
    fireEvent.keyDown(lineButton(6), { key: "Home", shiftKey: true });
    expect(pressed()).toEqual([1, 2, 3, 4]);
    fireEvent.keyDown(lineButton(1), { key: "Escape" });
    expect(toolbar()).toBeNull();
  });

  it("selecting text with the mouse selects its lines; a plain click clears", async () => {
    const { viewer } = await openApp();
    const textOf = (n: number) => {
      const span = viewer.querySelector(`[data-line="${n}"] > span`) as HTMLElement;
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      return walker.nextNode() as Text;
    };
    const range = document.createRange();
    range.setStart(textOf(2), 2);
    range.setEnd(textOf(5), 3);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(textOf(5).parentElement as HTMLElement);
    expect(pressed()).toEqual([2, 3, 4, 5]);
    expect(toolbar()?.textContent).toContain("Lines 2 to 5");

    sel.removeAllRanges();
    fireEvent.mouseUp(textOf(1).parentElement as HTMLElement);
    expect(toolbar()).toBeNull();
  });

  it("the toolbar's buttons are reachable with the arrow keys", async () => {
    await openApp();
    fireEvent.click(lineButton(2));
    const bar = toolbar() as HTMLElement;
    const ask = within(bar).getByRole("button", { name: "Ask about this" });
    ask.focus();
    fireEvent.keyDown(ask, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Change this" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(ask);
    fireEvent.keyDown(ask, { key: "Escape" });
    expect(toolbar()).toBeNull();
  });
});

describe("line actions", () => {
  it("Ask about this starts an ask-mode task with the place and the code, then opens Chat", async () => {
    responses["tasks.send"] = () => ({ id: "tsk_9" });
    await openApp();
    fireEvent.click(lineButton(2));
    fireEvent.click(lineButton(3), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    await waitFor(() => expect(useUi.getState().centerTab).toBe("chat"));
    const sent = calls.find((c) => c.method === "tasks.send")?.params as Record<string, string>;
    expect(sent).toMatchObject({ projectId: "prj_1", mode: "ask" });
    expect(sent.text).toBe(
      "Explain what lines 2 to 3 of `src/app.ts` do.\n\n" +
        "```typescript\nexport function f(x: number) {\n  return x + 1;\n```",
    );
    expect(useUi.getState().taskId).toBe("tsk_9");
  });

  it("Change this opens Chat on a new task with the composer filled and the caret placed", async () => {
    useUi.setState({ taskId: "tsk_old" });
    await openApp();
    fireEvent.click(lineButton(5));
    fireEvent.click(screen.getByRole("button", { name: "Change this" }));
    expect(useUi.getState().centerTab).toBe("chat");
    expect(useUi.getState().taskId).toBeNull();
    const head = "Change line 5 of `src/app.ts`: ";
    expect(useComposer.getState().pending).toMatchObject({
      text: `${head}\n\n\`\`\`typescript\nconst b = 'two';\n\`\`\``,
      cursor: head.length,
    });
    expect(calls.some((c) => c.method === "tasks.send")).toBe(false);

    cleanup();
    wrap(<Composer task={undefined} />);
    const box = screen.getByLabelText("Message the coding agent") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value.startsWith(head)).toBe(true));
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(head.length);
    expect(box.selectionEnd).toBe(head.length);
    // Read once: the store is empty again.
    expect(useComposer.getState().pending).toBeNull();
  });

  it("Copy path:line copies the file and line range", async () => {
    await openApp();
    fireEvent.click(lineButton(2));
    fireEvent.click(lineButton(4), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy path:line" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/app.ts:2-4"));
    expect(await screen.findByText("Copied.")).toBeTruthy();
    fireEvent.click(lineButton(6));
    fireEvent.click(screen.getByRole("button", { name: "Copy path:line" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src/app.ts:6"));
  });
});

import type { ChangeSet, DiffSide, ReviewComment } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: unknown }[] = [];
const responses: Record<string, (p: unknown) => unknown> = {};
vi.mock("@/lib/engine", () => ({
  call: (method: string, params: unknown) => {
    calls.push({ method, params });
    const f = responses[method];
    if (!f) return Promise.reject(new Error(`unmocked ${method}`));
    try {
      return Promise.resolve(f(params));
    } catch (e) {
      return Promise.reject(e);
    }
  },
}));
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { DiffReviewPanel } from "@/components/panels/DiffReviewPanel";
import { commentPlace, hunkRows, rowsLabel } from "./ReviewComments";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = "2026-11-07T10:00:00.000Z";
const changeSet = (taskId: string | null = "tsk_1"): ChangeSet => ({
  id: "cs_1",
  projectId: "prj_1",
  taskId,
  status: "pending",
  title: "Read the name from the command line",
  files: [
    {
      path: "app/main.py",
      kind: "modified",
      binary: false,
      additions: 2,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [" import os", "+import sys", "+print(sys.argv)", "-print(1)"],
        },
      ],
      baseHash: null,
      conflict: false,
      status: "pending",
    },
  ],
  createdAt: now,
  updatedAt: now,
});

type Key = { side: DiffSide; line: number };
type AddParams = { changeSetId: string; path: string; start: Key; end?: Key; body: string };

/** A small in-memory stand-in for the engine's comment store. */
function commentStore() {
  let comments: ReviewComment[] = [];
  let seq = 0;
  responses["review.comments.list"] = () => ({ comments });
  responses["review.comments.add"] = (raw) => {
    const p = raw as AddParams;
    const end = p.end ?? p.start;
    const c: ReviewComment = {
      id: `rvc_${++seq}`,
      projectId: "prj_1",
      taskId: "tsk_1",
      changeSetId: p.changeSetId,
      path: p.path,
      side: p.start.side,
      line: p.start.line,
      endSide: end.side,
      endLine: end.line,
      quote: "+import sys",
      body: p.body,
      status: "open",
      addressedBy: null,
      addressedIn: null,
      sentAt: null,
      ref: null,
      createdAt: now,
      updatedAt: now,
    };
    comments = [...comments, c];
    return c;
  };
  responses["review.comments.update"] = (raw) => {
    const p = raw as { id: string; body?: string; status?: "open" | "addressed" };
    comments = comments.map((c) =>
      c.id === p.id
        ? {
            ...c,
            ...(p.body ? { body: p.body } : {}),
            ...(p.status ? { status: p.status, addressedBy: p.status === "addressed" ? "owner" : null } : {}),
          }
        : c,
    );
    return comments.find((c) => c.id === p.id);
  };
  responses["review.comments.remove"] = (raw) => {
    comments = comments.filter((c) => c.id !== (raw as { id: string }).id);
    return { removed: true };
  };
  responses["review.requestChanges"] = () => {
    const open = comments.filter((c) => c.status === "open");
    comments = comments.map((c, i) => (c.status === "open" ? { ...c, sentAt: now, ref: i + 1 } : c));
    return { taskId: "tsk_1", sent: open.length, delivery: "queued" };
  };
  return { all: () => comments };
}

const lastCall = (method: string) => calls.filter((c) => c.method === method).at(-1)?.params;
const bar = () => screen.getByTestId("review-bar");

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", changeSetId: null });
  responses["checkpoints.list"] = () => ({ checkpoints: [] });
});
afterEach(cleanup);

describe("diff comments", () => {
  it("add a comment on one line with Ctrl+Enter; it shows under the line and in the bar", async () => {
    const cs = changeSet();
    responses["changes.list"] = () => ({ changeSets: [cs] });
    commentStore();
    wrap(<DiffReviewPanel />);

    await waitFor(() => expect(within(bar()).getByText("No open comments")).toBeTruthy());
    expect(within(bar()).getByText("Click a line number to comment on it.")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 2" }));
    const box = screen.getByLabelText("Comment on line 2", { selector: "textarea" }) as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(document.activeElement).toBe(box);
    const save = screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "  Use argparse here  " } });
    expect(save.disabled).toBe(false);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(lastCall("review.comments.add")).toEqual({
        changeSetId: "cs_1",
        path: "app/main.py",
        start: { side: "new", line: 2 },
        body: "Use argparse here",
      }),
    );
    const card = await screen.findByRole("article", { name: "Comment on app/main.py:2" });
    expect(card.textContent).toContain("Use argparse here");
    expect(card.textContent).toContain("Not sent yet");
    expect(screen.queryByLabelText("Comment on line 2", { selector: "textarea" })).toBeNull();
    await waitFor(() => expect(within(bar()).getByText("1 open comment")).toBeTruthy());
    // The file list shows how many comments wait on the file.
    expect(
      within(screen.getByRole("list", { name: "Changed files" })).getByText(/open comment/),
    ).toBeTruthy();
  });

  it("Shift+click picks a range; Escape closes the editor without saving", async () => {
    responses["changes.list"] = () => ({ changeSets: [changeSet()] });
    commentStore();
    wrap(<DiffReviewPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 3" }));
    const box = screen.getByLabelText("Comment on line 3", { selector: "textarea" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("Comment on line 3", { selector: "textarea" })).toBeNull();
    expect(calls.some((c) => c.method === "review.comments.add")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment on removed line 2" }), { shiftKey: true });
    const range = screen.getByLabelText("Comment on line 1 to removed line 2", { selector: "textarea" });
    fireEvent.change(range, { target: { value: "Keep the old print for now" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() =>
      expect(lastCall("review.comments.add")).toEqual({
        changeSetId: "cs_1",
        path: "app/main.py",
        start: { side: "new", line: 1 },
        end: { side: "old", line: 2 },
        body: "Keep the old print for now",
      }),
    );
    expect(await screen.findByRole("article", { name: "Comment on app/main.py:1" })).toBeTruthy();
  });

  it("arrow keys move between line numbers, one tab stop per change", async () => {
    responses["changes.list"] = () => ({ changeSets: [changeSet()] });
    commentStore();
    wrap(<DiffReviewPanel />);

    const first = (await screen.findByRole("button", { name: "Comment on line 1" })) as HTMLButtonElement;
    const second = screen.getByRole("button", { name: "Comment on line 2" }) as HTMLButtonElement;
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(second.tabIndex).toBe(0));
    expect(first.tabIndex).toBe(-1);

    // Shift+arrows mark a range; the rows are highlighted but no editor opens until Enter or a click.
    fireEvent.keyDown(second, { key: "ArrowDown", shiftKey: true });
    expect(screen.queryByRole("textbox")).toBeNull();
    const third = screen.getByRole("button", { name: "Comment on line 3" });
    expect(document.activeElement).toBe(third);
    fireEvent.click(third);
    expect(screen.getByLabelText("Comment on lines 2 to 3", { selector: "textarea" })).toBeTruthy();
  });

  it("edit (Escape keeps the text, Ctrl+Enter saves), mark as done, and delete", async () => {
    responses["changes.list"] = () => ({ changeSets: [changeSet()] });
    const store = commentStore();
    wrap(<DiffReviewPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 2" }));
    fireEvent.change(screen.getByLabelText("Comment on line 2", { selector: "textarea" }), {
      target: { value: "Use argparse" },
    });
    fireEvent.keyDown(screen.getByLabelText("Comment on line 2", { selector: "textarea" }), {
      key: "Enter",
      ctrlKey: true,
    });
    const card = await screen.findByRole("article", { name: "Comment on app/main.py:2" });

    fireEvent.click(within(card).getByRole("button", { name: "Edit comment on app/main.py:2" }));
    let edit = within(card).getByLabelText("Edit comment on app/main.py:2", { selector: "textarea" });
    expect((edit as HTMLTextAreaElement).value).toBe("Use argparse");
    fireEvent.keyDown(edit, { key: "Escape" });
    expect(card.textContent).toContain("Use argparse");
    expect(calls.some((c) => c.method === "review.comments.update")).toBe(false);

    fireEvent.click(within(card).getByRole("button", { name: "Edit comment on app/main.py:2" }));
    edit = within(card).getByLabelText("Edit comment on app/main.py:2", { selector: "textarea" });
    fireEvent.change(edit, { target: { value: "Use argparse with a --name flag" } });
    fireEvent.keyDown(edit, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(lastCall("review.comments.update")).toEqual({
        id: "rvc_1",
        body: "Use argparse with a --name flag",
      }),
    );
    await waitFor(() => expect(card.textContent).toContain("Use argparse with a --name flag"));

    fireEvent.click(within(card).getByRole("button", { name: "Mark as done" }));
    await waitFor(() =>
      expect(lastCall("review.comments.update")).toEqual({ id: "rvc_1", status: "addressed" }),
    );
    await waitFor(() => expect(card.textContent).toContain("Marked as done"));
    expect(within(bar()).getByText("No open comments")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /Reopen/ }));
    await waitFor(() => expect(lastCall("review.comments.update")).toEqual({ id: "rvc_1", status: "open" }));
    await waitFor(() => expect(within(bar()).getByText("1 open comment")).toBeTruthy());

    fireEvent.click(within(card).getByRole("button", { name: "Delete comment on app/main.py:2" }));
    await waitFor(() => expect(lastCall("review.comments.remove")).toEqual({ id: "rvc_1" }));
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Comment on app/main.py:2" })).toBeNull(),
    );
    expect(store.all()).toHaveLength(0);
  });

  it("Request changes sends every open comment with an optional note", async () => {
    responses["changes.list"] = () => ({ changeSets: [changeSet()] });
    commentStore();
    useUi.setState({ changeSetId: "cs_1" });
    wrap(<DiffReviewPanel />);

    for (const [line, body] of [
      ["2", "Use argparse"],
      ["3", "Print a greeting instead"],
    ] as const) {
      fireEvent.click(await screen.findByRole("button", { name: `Comment on line ${line}` }));
      const box = screen.getByLabelText(`Comment on line ${line}`, { selector: "textarea" });
      fireEvent.change(box, { target: { value: body } });
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
      await screen.findByRole("article", { name: `Comment on app/main.py:${line}` });
    }
    await waitFor(() => expect(within(bar()).getByText("2 open comments")).toBeTruthy());

    // Opening the form sends nothing; Escape closes it.
    fireEvent.click(within(bar()).getByRole("button", { name: "Request changes" }));
    let note = within(bar()).getByLabelText(/Send 2 comments to the agent\?/) as HTMLInputElement;
    expect(document.activeElement).toBe(note);
    fireEvent.keyDown(note, { key: "Escape" });
    expect(within(bar()).queryByRole("form", { name: "Request changes" })).toBeNull();
    expect(calls.some((c) => c.method === "review.requestChanges")).toBe(false);

    fireEvent.click(within(bar()).getByRole("button", { name: "Request changes" }));
    note = within(bar()).getByLabelText(/Send 2 comments to the agent\?/) as HTMLInputElement;
    fireEvent.change(note, { target: { value: "  Keep it short  " } });
    fireEvent.click(within(bar()).getByRole("button", { name: "Send to the agent" }));
    await waitFor(() =>
      expect(lastCall("review.requestChanges")).toEqual({ changeSetId: "cs_1", note: "Keep it short" }),
    );
    expect(
      await within(bar()).findByText(
        "Sent 2 comments to the agent. It is revising the changes in its private copy.",
      ),
    ).toBeTruthy();
    // Diff Review follows the task's next version as soon as it arrives.
    expect(useUi.getState().changeSetId).toBeNull();
    await waitFor(() =>
      expect(screen.getAllByRole("article").every((a) => a.textContent?.includes("Sent to the agent"))).toBe(
        true,
      ),
    );
  });

  it("a change set without a task shows the diff with no comment controls", async () => {
    responses["changes.list"] = () => ({ changeSets: [changeSet(null)] });
    commentStore();
    wrap(<DiffReviewPanel />);
    // Code lines are split into coloured spans, so look for the text of the whole row.
    await waitFor(() =>
      expect(screen.getAllByRole("row").some((r) => r.textContent?.includes("import sys"))).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /^Comment on line/ })).toBeNull();
    expect(screen.queryByTestId("review-bar")).toBeNull();
  });
});

describe("apply and undo", () => {
  it("Undo sits next to the apply message and puts the files back", async () => {
    const cs = changeSet(null);
    responses["changes.list"] = () => ({ changeSets: [cs] });
    responses["changes.apply"] = () => ({
      changeSet: { ...cs, status: "applied" },
      checkpointId: "cp_1",
      applied: ["app/main.py"],
      conflicts: [],
    });
    responses["checkpoints.restore"] = () => ({
      restored: ["app/main.py"],
      conflicts: [],
      checkpoint: {
        id: "cp_1",
        projectId: "prj_1",
        changeSetId: "cs_1",
        label: "Before applying: Read the name",
        files: [{ path: "app/main.py", existed: true, appliedHash: null }],
        status: "restored",
        createdAt: now,
      },
    });
    wrap(<DiffReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /^Apply 1 file/ }));
    const notice = await screen.findByText(/A checkpoint was saved, so you can undo it/);
    const status = notice.closest("[role=status]") as HTMLElement;
    fireEvent.click(within(status).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastCall("checkpoints.restore")).toEqual({ id: "cp_1", force: false }));
    expect(await within(status).findByText(/Undone/)).toBeTruthy();
  });
});

describe("comment helpers", () => {
  it("label rows and places in plain words", () => {
    const rows = hunkRows({
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 2,
      lines: [" a", "-b", "+c", "\\ No newline at end of file"],
    });
    expect(rows).toHaveLength(3);
    const [a, b, c] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0]];
    expect(rowsLabel(a, a)).toBe("line 10");
    expect(rowsLabel(b, b)).toBe("removed line 11");
    expect(rowsLabel(a, c)).toBe("lines 10 to 11");
    const base = { path: "app/main.py", side: "new", line: 12, endSide: "new", endLine: 14 } as const;
    expect(commentPlace(base as unknown as ReviewComment)).toBe("app/main.py:12-14");
    expect(commentPlace({ ...base, endLine: 12 } as unknown as ReviewComment)).toBe("app/main.py:12");
    expect(
      commentPlace({ ...base, side: "old", line: 7, endSide: "old", endLine: 7 } as unknown as ReviewComment),
    ).toBe("app/main.py:7 (removed)");
  });
});

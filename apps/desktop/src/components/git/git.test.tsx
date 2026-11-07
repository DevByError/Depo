import type { ChangeSet, DepoEvent, GitCommitSummary, GitDraft, GitStatus } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

const calls: { method: string; params: Record<string, unknown> }[] = [];
let responses: Record<string, (p: Record<string, unknown>) => unknown> = {};

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>) => {
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

import { CommitDialog } from "./CommitDialog";
import { CommitChangesBar } from "./CommitOffer";
import { GitBranchBadge } from "./GitBadge";
import { HistoryPanel } from "./HistoryPanel";

const TEMPLATE = "feat(app): add a health check\n\nAsked for: add a health endpoint";
const MODEL = "feat(api): add a health check endpoint\n\n- add GET /health that answers ok";

function draft(over: Partial<GitDraft> = {}): GitDraft {
  return {
    message: TEMPLATE,
    source: "template",
    note: null,
    files: [
      { path: "app/main.py", kind: "modified", additions: 4, deletions: 1, include: true, note: null },
      { path: "tests/test health.py", kind: "added", additions: 9, deletions: 0, include: true, note: null },
      {
        path: "app/config.py",
        kind: "modified",
        additions: 1,
        deletions: 0,
        include: false,
        note: "You changed this file after applying it. Tick it to commit your edits too.",
      },
    ],
    branch: "main",
    suggestedBranch: "depo/add-health-endpoint",
    identity: { name: "Ada", email: "ada@example.com" },
    committed: null,
    ...over,
  };
}

/** A promise the test resolves when it wants the "model" to answer. */
function gate<T>() {
  let open: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    open = r;
  });
  return { promise, open };
}

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const commitResult = (p: Record<string, unknown>) => ({
  hash: "abc1234def5678abc1234def5678abc1234def56",
  shortHash: "abc1234",
  branch: (p.branch as string | undefined) ?? "main",
  createdBranch: !!p.branch,
  files: p.files,
  skipped: [],
});

beforeEach(() => {
  calls.length = 0;
  responses = {};
  useEngine.setState({ status: "open", events: [] });
  useUi.setState({ projectId: "prj_1", bottomTab: "engine", bottomOpen: false });
});
afterEach(cleanup);

describe("commit form", () => {
  test("shows Depo's draft, takes the model's draft, and commits the edited message to a new branch", async () => {
    const model = gate<GitDraft>();
    responses["git.draftCommit"] = (p) => (p.model ? model.promise : draft());
    responses["git.commit"] = commitResult;
    wrap(<CommitDialog projectId="prj_1" changeSetId="chg_1" open onOpenChange={() => {}} />);

    const box = (await screen.findByLabelText("Commit message")) as HTMLTextAreaElement;
    expect(box.value).toBe(TEMPLATE);
    expect(screen.getByText("Your local model is writing a draft…")).toBeTruthy();
    expect(screen.getByText(/2 of 3/)).toBeTruthy();
    const config = screen.getByRole("checkbox", { name: /app\/config\.py/ }) as HTMLInputElement;
    expect(config.checked).toBe(false);
    expect(screen.getByText(/You changed this file after applying it/)).toBeTruthy();
    // The model draft is asked for at once, in the background.
    expect(calls.find((c) => c.method === "git.draftCommit" && c.params.model === true)).toBeTruthy();

    await act(async () => model.open(draft({ message: MODEL, source: "model" })));
    await waitFor(() => expect(box.value).toBe(MODEL));
    expect(screen.getByText("Drafted by your local model")).toBeTruthy();

    fireEvent.change(box, { target: { value: "fix(api): answer health checks" } });
    fireEvent.click(screen.getByRole("radio", { name: /A new branch/ }));
    const name = screen.getByRole("textbox", { name: "New branch name" }) as HTMLInputElement;
    expect(name.value).toBe("depo/add-health-endpoint");
    fireEvent.change(name, { target: { value: "depo/health" } });
    fireEvent.click(config);
    fireEvent.click(screen.getByRole("button", { name: "Commit 3 files" }));

    expect(await screen.findByText(/Committed 3 files to/)).toBeTruthy();
    expect(calls.find((c) => c.method === "git.commit")?.params).toEqual({
      projectId: "prj_1",
      changeSetId: "chg_1",
      message: "fix(api): answer health checks",
      files: ["app/main.py", "tests/test health.py", "app/config.py"],
      branch: "depo/health",
    });
    expect(screen.getByText("depo/health")).toBeTruthy();
    expect(screen.getByText(/Nothing was pushed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show history" }));
    expect(useUi.getState()).toMatchObject({ bottomTab: "history", bottomOpen: true });
  });

  test("keeps the owner's edit when the model answers late, and can switch to the model's draft", async () => {
    const model = gate<GitDraft>();
    responses["git.draftCommit"] = (p) => (p.model ? model.promise : draft());
    responses["git.commit"] = commitResult;
    wrap(<CommitDialog projectId="prj_1" changeSetId="chg_1" open onOpenChange={() => {}} />);

    const box = (await screen.findByLabelText("Commit message")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "docs: my own words" } });
    await act(async () => model.open(draft({ message: MODEL, source: "model" })));
    const use = await screen.findByRole("button", { name: "Use your model's draft instead" });
    expect(box.value).toBe("docs: my own words");
    fireEvent.click(use);
    expect(box.value).toBe(MODEL);

    // Committing to the current branch sends no branch name.
    fireEvent.click(screen.getByRole("button", { name: "Commit 2 files" }));
    await screen.findByText(/Committed 2 files to/);
    const sent = calls.find((c) => c.method === "git.commit")?.params;
    expect(sent).toMatchObject({ message: MODEL, files: ["app/main.py", "tests/test health.py"] });
    expect(sent).not.toHaveProperty("branch");
  });

  test("says when the model did not answer, and checks the new branch name", async () => {
    responses["git.draftCommit"] = (p) =>
      p.model ? draft({ note: "No local model answered in time, so this is Depo's simple draft." }) : draft();
    wrap(<CommitDialog projectId="prj_1" changeSetId="chg_1" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/No local model answered in time/)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "New branch name" }), {
      target: { value: "-bad name" },
    });
    expect(screen.getByRole("radio", { name: /A new branch/ })).toHaveProperty("checked", true);
    expect(screen.getByText(/Use letters, digits, dots/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit 2 files" })).toHaveProperty("disabled", true);
  });

  test("asks for a name and email when git has none, saves them for this project, then allows the commit", async () => {
    let identity: GitDraft["identity"] = null;
    responses["git.draftCommit"] = () => draft({ identity });
    responses["git.setIdentity"] = (p) => {
      identity = { name: String(p.name), email: String(p.email) };
      return { identity };
    };
    wrap(<CommitDialog projectId="prj_1" changeSetId="chg_1" open onOpenChange={() => {}} />);

    const group = await screen.findByRole("group", { name: "Git does not know who you are yet" });
    expect(screen.getByRole("button", { name: "Commit 2 files" })).toHaveProperty("disabled", true);
    // No model call without someone to commit as.
    expect(calls.some((c) => c.method === "git.draftCommit" && c.params.model === true)).toBe(false);

    fireEvent.change(within(group).getByLabelText("Name"), { target: { value: " Ada Lovelace " } });
    fireEvent.change(within(group).getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.click(within(group).getByRole("button", { name: "Save for this project" }));

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Git does not know who you are yet" })).toBeNull(),
    );
    expect(calls.find((c) => c.method === "git.setIdentity")?.params).toEqual({
      projectId: "prj_1",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(screen.getByRole("button", { name: "Commit 2 files" })).toHaveProperty("disabled", false);
  });
});

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  gitAvailable: true,
  isRepo: true,
  branch: "main",
  detached: false,
  unborn: false,
  changes: 2,
  staged: 0,
  untracked: 1,
  entries: [],
  identity: { name: "Ada", email: "ada@example.com" },
  ...over,
});

const changeSet = (over: Partial<ChangeSet> = {}): ChangeSet => ({
  id: "chg_1",
  projectId: "prj_1",
  taskId: "tsk_1",
  status: "applied",
  title: "Add a health endpoint",
  files: [],
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:00:00.000Z",
  ...over,
});

describe("commit offer in Diff Review", () => {
  test("offers to commit an applied change set, then says where it went", async () => {
    responses["git.status"] = () => status();
    responses["git.draftCommit"] = () => draft();
    wrap(<CommitChangesBar projectId="prj_1" changeSet={changeSet()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Commit these changes" }));
    expect(await screen.findByRole("dialog", { name: "Commit these changes" })).toBeTruthy();
    expect(await screen.findByLabelText("Commit message")).toBeTruthy();

    const committed: DepoEvent = {
      id: `evt_${"a".repeat(28)}`,
      ts: "2026-11-07T10:01:00.000Z",
      seq: 1,
      projectId: "prj_1",
      taskId: "tsk_1",
      agent: "engine",
      type: "committed",
      text: "Committed 2 files to main (abc1234): feat: add a health check",
      details: { changeSetId: "chg_1", hash: "abc1234def", shortHash: "abc1234", branch: "main" },
      durationMs: null,
      status: "succeeded",
      ephemeral: false,
    };
    act(() => useEngine.setState({ events: [committed] }));
    expect(await screen.findByText("abc1234")).toBeTruthy();
    expect(screen.getByText(/Committed as/)).toBeTruthy();
  });

  test("stays hidden for pending change sets and for folders that are not git repositories", async () => {
    responses["git.status"] = () => status({ isRepo: false, branch: null });
    const { container } = wrap(<CommitChangesBar projectId="prj_1" changeSet={changeSet()} />);
    await waitFor(() => expect(calls.some((c) => c.method === "git.status")).toBe(true));
    expect(container.textContent).toBe("");
    cleanup();
    responses["git.status"] = () => status();
    const again = wrap(<CommitChangesBar projectId="prj_1" changeSet={changeSet({ status: "pending" })} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(again.container.textContent).toBe("");
  });
});

const commit = (n: number, over: Partial<GitCommitSummary> = {}): GitCommitSummary => ({
  hash: `${n}`.repeat(40).slice(0, 40),
  shortHash: `${n}`.repeat(7),
  subject: `commit number ${n}`,
  body: "",
  author: "Ada",
  email: "ada@example.com",
  date: new Date(Date.now() - n * 3_600_000).toISOString(),
  files: n,
  additions: n,
  deletions: 0,
  ...over,
});

describe("history", () => {
  test("lists recent commits and shows the changes of the chosen one", async () => {
    responses["git.status"] = () => status();
    responses["git.log"] = () => ({ commits: [commit(1, { body: "Why it changed." }), commit(2)] });
    responses["git.show"] = (p) => ({
      commit: commit(1),
      files: [
        {
          path: p.hash === commit(2).hash ? "docs/guide.md" : "app/main.py",
          oldPath: null,
          kind: "modified",
          binary: false,
          additions: 1,
          deletions: 1,
          truncated: false,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old line", "+new line"] }],
        },
      ],
    });
    wrap(<HistoryPanel />);

    const list = await screen.findByRole("region", { name: "Commits, newest first" });
    expect(within(list).getAllByRole("button", { name: /commit number/ })).toHaveLength(2);
    expect(screen.getByText("2 changes not committed")).toBeTruthy();
    expect(await screen.findByText("app/main.py")).toBeTruthy();
    expect(screen.getByText("Why it changed.")).toBeTruthy();
    expect(screen.getByText("new line")).toBeTruthy();

    fireEvent.click(within(list).getByRole("button", { name: /commit number 2/ }));
    expect(await screen.findByText("docs/guide.md")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Changes in commit 2222222" })).toBeTruthy();
    expect(calls.find((c) => c.method === "git.show" && c.params.hash === commit(2).hash)).toBeTruthy();
  });

  test("explains when the project is not a git repository", async () => {
    responses["git.status"] = () => status({ isRepo: false, branch: null });
    wrap(<HistoryPanel />);
    expect(await screen.findByText(/not a git repository/)).toBeTruthy();
  });

  test("the branch badge shows uncommitted changes and opens the history", async () => {
    responses["git.status"] = () => status({ branch: "depo/health", changes: 1 });
    wrap(<GitBranchBadge projectId="prj_1" />);
    const badge = await screen.findByRole("button", { name: /depo\/health/ });
    expect(badge.textContent).toContain("1 change not committed");
    fireEvent.click(badge);
    expect(useUi.getState()).toMatchObject({ bottomTab: "history", bottomOpen: true });
  });
});

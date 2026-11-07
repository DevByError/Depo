import type { SearchGroup, SearchResult, SearchScope } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { useNav } from "@/store/nav";
import { useUi } from "@/store/ui";

const calls: { method: string; params: Record<string, unknown> }[] = [];

const RESULTS: Record<SearchScope, SearchResult[]> = {
  files: [
    {
      id: "file:app/routes/users.py",
      scope: "files",
      title: "app/routes/users.py",
      titleMarks: [[11, 15]],
      detail: "",
      snippet: null,
      score: 0.9,
      target: { kind: "file", path: "app/routes/users.py", line: null },
    },
  ],
  symbols: [
    {
      id: "symbol:app/services/user.py:12:UserService",
      scope: "symbols",
      title: "UserService",
      titleMarks: [[0, 4]],
      detail: "class · app/services/user.py:12",
      snippet: null,
      score: 0.8,
      target: { kind: "file", path: "app/services/user.py", line: 12 },
    },
  ],
  content: [],
  tasks: [
    {
      id: "task:tsk_7",
      scope: "tasks",
      title: "Fix the login bug for users",
      titleMarks: [[22, 26]],
      detail: "Done · 3 Nov",
      snippet: null,
      score: 0.6,
      target: { kind: "task", taskId: "tsk_7" },
    },
  ],
  decisions: [
    {
      id: "decision:evt_3",
      scope: "decisions",
      title: "Approved the plan for users",
      titleMarks: [],
      detail: "Manager · 3 Nov",
      snippet: null,
      score: 0.5,
      target: { kind: "decision", taskId: "tsk_7", eventId: "evt_3" },
    },
  ],
  memory: [
    {
      id: "memory:fact_1",
      scope: "memory",
      title: "Users log in with email",
      titleMarks: [],
      detail: "Project memory",
      snippet: null,
      score: 0.4,
      target: { kind: "memory", factId: "fact_1", global: false },
    },
  ],
  logs: [
    {
      id: "log:42",
      scope: "logs",
      title: "user lookup failed",
      titleMarks: [],
      detail: "error · tools",
      snippet: null,
      score: 0.3,
      target: { kind: "log", text: "user lookup failed", taskId: null },
    },
  ],
};
const ORDER: SearchScope[] = ["files", "symbols", "content", "tasks", "decisions", "memory", "logs"];

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "search.everything") {
      const scopes = (params.scopes as SearchScope[] | undefined) ?? ORDER;
      const groups: SearchGroup[] = ORDER.filter((s) => scopes.includes(s)).map((scope) => ({
        scope,
        results: params.query ? RESULTS[scope] : [],
        more: false,
        timedOut: false,
        error: null,
        tookMs: 2,
      }));
      return Promise.resolve({ query: params.query, groups, tookMs: 5 });
    }
    if (method === "tasks.send") return Promise.resolve({ id: "tsk_new", title: String(params.text) });
    return Promise.reject(new Error(`unmocked ${method}`));
  },
  setTheme: () => Promise.resolve(),
}));

import { CommandPalette } from "./CommandPalette";

function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>,
  );
  act(() => useUi.getState().setPaletteOpen(true));
  return screen.findByRole("combobox", { name: "Type a command" });
}

const searches = () => calls.filter((c) => c.method === "search.everything" && c.params.query !== "");
const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

beforeEach(() => {
  calls.length = 0;
  useEngine.setState({ status: "open" });
  useUi.setState({
    centerTab: "overview",
    bottomTab: "engine",
    paletteOpen: false,
    projectId: "prj_1",
    taskId: null,
    logsTaskId: null,
  });
  useNav.setState({ file: null, memory: null, logsText: null });
});
afterEach(cleanup);

test("everything search: says what it is searching, then shows each kind in its own section", async () => {
  const input = await open();
  fireEvent.change(input, { target: { value: "users" } });
  // Typing never waits for the engine: the sections say they are on their way.
  expect(screen.getByText(/^Searching files, symbols/)).toBeTruthy();

  const files = await screen.findByRole("group", { name: "Files" });
  expect(within(files).getByRole("option").textContent).toContain("users.py");
  expect(within(files).getByText("user", { selector: "mark" })).toBeTruthy();
  for (const name of ["Symbols", "Tasks", "Decisions", "Memory", "Logs", "Ask"])
    expect(screen.getByRole("group", { name })).toBeTruthy();
  // Scopes with nothing to show stay out of the way.
  expect(screen.queryByRole("group", { name: "In files" })).toBeNull();
  expect(searches()[0]?.params).toMatchObject({ projectId: "prj_1", query: "users", limit: 5 });
  expect(searches()[0]?.params.scopes).toHaveLength(7);
});

test("keyboard: arrows move across sections, Page keys jump to the ends, Enter opens a symbol at its line", async () => {
  const input = await open();
  fireEvent.change(input, { target: { value: "users" } });
  await screen.findByRole("group", { name: "Symbols" });
  const options = screen.getAllByRole("option");
  expect(selected()).toBe(options[0]);
  expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

  fireEvent.keyDown(input, { key: "PageDown" });
  expect(selected()?.textContent).toContain("Ask Depo");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(selected()?.textContent).toContain("user lookup failed");
  fireEvent.keyDown(input, { key: "PageUp" });
  expect(selected()).toBe(options[0]);

  const target = options.findIndex((o) => o.textContent?.includes("UserService"));
  for (let i = 0; i < target; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(selected()?.textContent).toContain("UserService");
  expect(input.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  fireEvent.keyDown(input, { key: "Enter" });

  expect(useUi.getState().paletteOpen).toBe(false);
  expect(useUi.getState().centerTab).toBe("files");
  expect(useNav.getState().file).toMatchObject({ path: "app/services/user.py", line: 12 });
});

test("prefixes narrow the search: / files, @ symbols, # tasks, > commands only, ? ask only", async () => {
  const input = await open();

  fireEvent.change(input, { target: { value: "/users" } });
  expect(screen.getByText("Files", { selector: "span" })).toBeTruthy();
  await waitFor(() =>
    expect(searches().at(-1)?.params).toMatchObject({ query: "users", scopes: ["files"], limit: 12 }),
  );
  await screen.findByRole("group", { name: "Files" });
  expect(screen.queryByRole("group", { name: "Ask" })).toBeNull();

  fireEvent.change(input, { target: { value: "@User" } });
  await waitFor(() =>
    expect(searches().at(-1)?.params).toMatchObject({ query: "User", scopes: ["symbols"] }),
  );

  fireEvent.change(input, { target: { value: "#login" } });
  await waitFor(() =>
    expect(searches().at(-1)?.params).toMatchObject({ query: "login", scopes: ["tasks", "decisions"] }),
  );
  await screen.findByRole("group", { name: "Decisions" });

  const before = searches().length;
  fireEvent.change(input, { target: { value: ">theme" } });
  expect(screen.getAllByRole("option").every((o) => o.id.startsWith("cmd-"))).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(searches().length).toBe(before);

  fireEvent.change(input, { target: { value: "?how does sign in work" } });
  const only = screen.getAllByRole("option");
  expect(only).toHaveLength(1);
  expect(only[0]?.textContent).toContain("Ask Depo: “how does sign in work”");
  expect(screen.queryByText("Nothing matches.")).toBeNull();
});

test("Ask Depo starts an Ask task with the question and opens Chat", async () => {
  const input = await open();
  fireEvent.change(input, { target: { value: "? how does sign in work" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useUi.getState().centerTab).toBe("chat");
  await waitFor(() => expect(useUi.getState().taskId).toBe("tsk_new"));
  expect(calls.find((c) => c.method === "tasks.send")?.params).toEqual({
    projectId: "prj_1",
    text: "how does sign in work",
    mode: "ask",
  });

  // Ctrl+Enter asks from the everything view too.
  act(() => useUi.getState().setPaletteOpen(true));
  const box = await screen.findByRole("combobox", { name: "Type a command" });
  fireEvent.change(box, { target: { value: "where is billing" } });
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(calls.filter((c) => c.method === "tasks.send")).toHaveLength(2));
  expect(calls.filter((c) => c.method === "tasks.send")[1]?.params).toMatchObject({
    text: "where is billing",
  });
});

test("results open where they live: task in Chat, decision in Team, memory in Memory, log line in Logs", async () => {
  const pick = async (text: RegExp) => {
    act(() => useUi.getState().setPaletteOpen(true));
    const box = await screen.findByRole("combobox", { name: "Type a command" });
    fireEvent.change(box, { target: { value: "users" } });
    fireEvent.click(await screen.findByText(text));
  };

  await open();
  act(() => useUi.getState().setPaletteOpen(false));

  await pick(/Fix the login bug/);
  expect(useUi.getState()).toMatchObject({ centerTab: "chat", taskId: "tsk_7" });

  useUi.setState({ taskId: null });
  await pick(/Approved the plan/);
  expect(useUi.getState()).toMatchObject({ centerTab: "team", taskId: "tsk_7" });

  await pick(/Users log in with email/);
  expect(useUi.getState().centerTab).toBe("memory");
  expect(useNav.getState().memory).toMatchObject({ factId: "fact_1", global: false });

  await pick(/user lookup failed/);
  expect(useUi.getState()).toMatchObject({ bottomTab: "logs", bottomOpen: true });
  expect(useNav.getState().logsText).toMatchObject({ text: "user lookup failed" });
});

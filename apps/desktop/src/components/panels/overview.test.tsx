import type { CodeMap, CodeMapNode, DepoEvent, Task } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useOpenFile } from "@/lib/open-file";
import { useEngine } from "@/store/engine";
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
vi.mock("@/lib/query", async () => {
  const { QueryClient: QC } = await import("@tanstack/react-query");
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});

import { OverviewPanel } from "./OverviewPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const now = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function node(id: string, over: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id,
    label: id,
    kind: "module",
    area: "core",
    files: 2,
    lines: 120,
    symbols: 4,
    branches: 3,
    importsOut: 0,
    importedBy: 0,
    inCycle: false,
    entry: false,
    module: null,
    outside: false,
    ...over,
  };
}

const moduleMap: CodeMap = {
  projectId: "prj_1",
  level: "module",
  focus: null,
  summary: {
    files: 7,
    lines: 1460,
    symbols: 30,
    edges: 6,
    modules: 3,
    languages: [
      { name: "TypeScript", files: 5, lines: 1200 },
      { name: "Python", files: 2, lines: 260 },
    ],
    libraries: [{ name: "react", count: 4 }],
  },
  nodes: [
    node("web/src", { area: "ui", files: 4, importsOut: 2, entry: true }),
    node("web/src/lib", { area: "core", files: 2, importedBy: 1 }),
    node("api/app", { area: "server", files: 3, importsOut: 1, importedBy: 1, inCycle: true }),
  ],
  edges: [
    { from: "web/src", to: "web/src/lib", weight: 3, cycle: false },
    { from: "web/src", to: "api/app", weight: 1, cycle: false },
  ],
  cycles: [["api/app/routes.py", "api/app/models.py"]],
  entryPoints: [{ path: "web/src/main.tsx", reason: "mounts the React app" }],
  hotSpots: {
    dependedOn: [{ path: "web/src/lib/cn.ts", value: 3, detail: "3 files import it" }],
    largest: [{ path: "web/src/App.tsx", value: 400, detail: "400 lines, 12 symbols" }],
    complex: [],
    churn: [],
  },
  truncated: false,
  indexing: false,
  updatedAt: now,
};

function filesOf(module: string): CodeMap {
  const files =
    module === "web/src/lib"
      ? [
          node("web/src/lib/cn.ts", { kind: "file", label: "cn.ts", module, files: 1, importedBy: 2 }),
          node("web/src/lib/api.ts", { kind: "file", label: "api.ts", module, files: 1, importsOut: 1 }),
          node("web/src/App.tsx", {
            kind: "file",
            label: "web/src/App.tsx",
            module: "web/src",
            outside: true,
          }),
        ]
      : [];
  return {
    ...moduleMap,
    level: "file",
    nodes: files,
    edges: [],
    summary: { ...moduleMap.summary, files: 2, lines: 80 },
  };
}

const tasks: Task[] = [
  {
    mode: "single",
    id: "tsk_done",
    projectId: "prj_1",
    title: "Add a health endpoint",
    prompt: "",
    status: "done",
    model: null,
    summary: null,
    error: null,
    createdAt: ago(300),
    updatedAt: ago(200),
  },
  {
    mode: "full_team",
    id: "tsk_team",
    projectId: "prj_1",
    title: "Build the login screen",
    prompt: "",
    status: "review",
    model: null,
    summary: null,
    error: null,
    createdAt: ago(60),
    updatedAt: ago(5),
  },
] as Task[];

function event(id: string, type: DepoEvent["type"], over: Partial<DepoEvent>): DepoEvent {
  return {
    id,
    ts: now,
    seq: 1,
    projectId: "prj_1",
    taskId: "tsk_team",
    agent: "coder@1.0.0",
    type,
    text: "",
    details: null,
    durationMs: null,
    status: "info",
    ephemeral: false,
    ...over,
  };
}

function setup() {
  responses["projects.overview"] = () => ({
    project: {
      id: "prj_1",
      name: "Shop",
      rootPath: "C:\\Users\\me\\shop",
      lastOpenedAt: now,
      createdAt: now,
      isGit: true,
      branch: "main",
      description: "A small shop",
      stack: "",
      origin: "created",
      archivedAt: null,
      exists: true,
    },
    taskCounts: { done: 1, review: 1 },
    lastTestRun: { at: ago(3), passed: true, text: "Tests: 8 passed", taskId: "tsk_team" },
    recentChanges: [{ id: "chg_1", title: "Login screen", status: "pending_review", files: 3, at: now }],
    index: {
      projectId: "prj_1",
      state: "idle",
      files: 7,
      symbols: 30,
      chunks: 0,
      embeddingModel: null,
      progress: null,
      lastIndexedAt: now,
      watching: true,
      error: null,
    },
    memory: { facts: 2, lessons: 1, markdownChars: 0 },
  });
  responses["codemap.repo"] = () => ({
    stack: {
      summary: "TypeScript, React, Python, FastAPI",
      languages: ["TypeScript", "Python"],
      frameworks: ["React", "FastAPI"],
      databases: [],
      tools: [],
      packageManager: "bun",
      testCommand: null,
      runCommand: null,
    },
    git: {
      branch: "main",
      changed: 2,
      ahead: 1,
      behind: 0,
      lastCommit: { hash: "abc", date: ago(90), subject: "Add cart" },
    },
  });
  responses["codemap.get"] = (p) => {
    const q = p as { level: string; module?: string };
    return q.level === "module" ? moduleMap : filesOf(q.module ?? "");
  };
  responses["codemap.file"] = (p) => ({
    path: (p as { path: string }).path,
    module: "web/src/lib",
    area: "core",
    lang: "TypeScript",
    lines: 12,
    branches: 1,
    entry: null,
    inCycle: false,
    churn: 4,
    imports: [{ spec: "clsx", line: 1, kind: "import", target: null, library: "clsx" }],
    importedBy: [{ path: "web/src/App.tsx", line: 3 }],
    symbols: [
      { name: "cn", kind: "function", parent: null, startLine: 3, endLine: 5, signature: "cn(...a)" },
    ],
  });
  responses["events.recent"] = (p) => {
    const types = (p as { types?: string[] }).types ?? [];
    if (types.includes("test_result"))
      return {
        events: [
          event("evt_1", "test_result", { ts: ago(30), status: "failed", details: { passed: 6, failed: 2 } }),
          event("evt_2", "test_result", {
            ts: ago(20),
            status: "succeeded",
            details: { passed: 8, failed: 0 },
          }),
          event("evt_3", "test_result", {
            ts: ago(3),
            status: "succeeded",
            details: { passed: 8, failed: 0 },
          }),
        ],
      };
    if (types.includes("decision"))
      return {
        events: [
          event("evt_d", "decision", {
            agent: "testing@1.0.0",
            text: "The login form works and the tests pass",
            details: { kind: "review", outcome: "approved" },
          }),
        ],
      };
    return { events: [] };
  };
  responses["scores.get"] = () => ({
    ux: { overall: 88, grade: "B", blocksRelease: false, at: ago(40) },
    security: null,
  });
  responses["security.last"] = () => ({
    report: {
      at: ago(60),
      findings: [
        { tool: "depo", rule: "r1", severity: "high", file: "a.py", line: 1, title: "t", fix: "f" },
        { tool: "depo", rule: "r2", severity: "medium", file: "b.py", line: 2, title: "t", fix: "f" },
        { tool: "depo", rule: "r3", severity: "info", file: "c.py", line: 3, title: "t", fix: "f" },
      ],
      score: { overall: 74, grade: "C", blocksRelease: false, counts: {}, reasons: [] },
      ran: [],
      skipped: [],
    },
  });
  responses["tasks.list"] = () => ({ tasks });
  responses["preview.list"] = () => ({
    previews: [
      {
        id: "prv_1",
        projectId: "prj_1",
        taskId: null,
        target: "project",
        kind: "vite",
        label: "Web app",
        role: "frontend",
        command: "",
        cwd: "",
        port: 5173,
        url: "http://127.0.0.1:5173/",
        state: "running",
        phase: "Ready",
        error: null,
        exitCode: null,
        startedBy: "user",
        groupId: null,
        approvalId: null,
        startedAt: now,
        readyAt: now,
        stoppedAt: null,
      },
    ],
  });
  responses["memory.get"] = () => ({
    markdown: "",
    facts: [
      {
        id: "mem_1",
        projectId: "prj_1",
        kind: "lesson",
        text: "Run pytest with -q in the api folder",
        signature: null,
        source: "auto",
        uses: 5,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  responses["projects.settings.get"] = () => ({
    indexEnabled: true,
    maxParallel: 1,
    paused: false,
    commandAllow: [],
    commandDeny: [],
    maxSteps: 40,
    previewCommand: "",
  });
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", centerTab: "overview", taskId: "tsk_old" });
  useOpenFile.getState().clear();
  try {
    localStorage.removeItem("depo.codemap.view");
  } catch {
    // ignore
  }
  setup();
});
afterEach(cleanup);

test("project home: header, health, work, decisions and memory, with the e2e names kept", async () => {
  wrap(<OverviewPanel />);
  const home = await screen.findByRole("region", { name: "Project overview" });
  expect(within(home).getByRole("heading", { name: "Shop" })).toBeTruthy();
  expect(home.textContent).toContain("Created in Depo");
  const about = within(home).getByRole("list", { name: "About this project" });
  await waitFor(() => expect(about.textContent).toContain("FastAPI"));
  expect(about.textContent).toContain("main · 2 changed · 1 ahead");
  expect(home.textContent).toContain("Add cart");

  const tests = within(home).getByRole("region", { name: "Last test run" });
  expect(tests.textContent).toContain("passed");
  expect(
    await within(tests).findByRole("img", { name: "Last 3 test runs: 2 passed, 1 failed" }),
  ).toBeTruthy();

  const security = within(home).getByRole("region", { name: "Security" });
  await waitFor(() => expect(security.textContent).toContain("74"));
  expect(security.textContent).toContain("2 open findings: 1 high, 1 medium");
  const ux = within(home).getByRole("region", { name: "UX score" });
  await waitFor(() => expect(ux.textContent).toContain("88"));
  const size = within(home).getByRole("region", { name: "Code size" });
  await waitFor(() => expect(size.textContent).toContain("1.5k"));
  expect(within(size).getByRole("list", { name: "Languages" }).textContent).toContain("TypeScript 82%");

  const taskCard = within(home).getByRole("region", { name: "Tasks" });
  expect(taskCard.textContent).toContain("To review");
  const teamTask = await within(taskCard).findByRole("button", { name: /Build the login screen/ });
  // The task to review comes before the finished one.
  const rows = within(taskCard)
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
  expect(rows.findIndex((t) => t.includes("login"))).toBeLessThan(
    rows.findIndex((t) => t.includes("health")),
  );

  const previews = within(home).getByRole("region", { name: "Previews" });
  expect(
    await within(previews).findByRole("button", { name: "Open Web app at http://127.0.0.1:5173/" }),
  ).toBeTruthy();
  const decisions = within(home).getByRole("region", { name: "Latest decisions" });
  expect(await within(decisions).findByText("Approved")).toBeTruthy();
  const memory = within(home).getByRole("region", { name: "Memory" });
  expect(await within(memory).findByText("Run pytest with -q in the api folder")).toBeTruthy();
  expect(screen.getByTestId("index-status").textContent).toMatch(/\d+ files/);

  // Settings stay folded until asked for.
  expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  expect(calls.some((c) => c.method === "projects.settings.get")).toBe(false);

  fireEvent.click(teamTask);
  expect(useUi.getState().taskId).toBe("tsk_team");
  expect(useUi.getState().centerTab).toBe("team");
});

test("quick actions start a new task, open the preview, and scan", async () => {
  responses["security.scan"] = () => ({
    at: now,
    findings: [],
    score: { overall: 100, grade: "A", blocksRelease: false, counts: {}, reasons: [] },
    ran: [],
    skipped: [],
  });
  wrap(<OverviewPanel />);
  const actions = await screen.findByRole("group", { name: "Quick actions" });
  fireEvent.click(within(actions).getByRole("button", { name: "Scan" }));
  expect(await within(actions).findByText("Scan finished: nothing found.")).toBeTruthy();
  fireEvent.click(within(actions).getByRole("button", { name: "Preview" }));
  expect(useUi.getState().centerTab).toBe("preview");
  fireEvent.click(within(actions).getByRole("button", { name: "New task" }));
  expect(useUi.getState().taskId).toBeNull();
  expect(useUi.getState().centerTab).toBe("chat");
});

test("settings open in their own section", async () => {
  wrap(<OverviewPanel />);
  await screen.findByRole("region", { name: "Project overview" });
  const summary = screen.getByText("Project settings");
  const details = summary.closest("details");
  if (!details) throw new Error("no details");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByRole("button", { name: "Save settings" })).toBeTruthy();
});

test("code map: the list alternative, a module's files, a file's imports, and Open in Files", async () => {
  wrap(<OverviewPanel />);
  const map = await screen.findByRole("region", { name: "Code map" });
  // The graph draws every module as a button.
  const graph = await within(map).findByRole("list", { name: "Modules in the graph" });
  expect(within(graph).getAllByRole("button")).toHaveLength(3);
  expect(
    within(graph).getByRole("button", { name: /^api\/app, 3 files, server.*in an import cycle/ }),
  ).toBeTruthy();
  expect(within(map).getByRole("region", { name: /Module graph/ }).tabIndex).toBe(0);

  // The list alternative shows the same modules as a table.
  fireEvent.click(within(map).getByRole("radio", { name: "List" }));
  const table = within(map).getByRole("table", { name: "Modules" });
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(within(map).getByRole("radio", { name: "List" }).getAttribute("aria-checked")).toBe("true");
  const lib = within(table).getByRole("button", { name: /^web\/src\/lib, 2 files/ });
  fireEvent.click(lib);
  expect(lib.getAttribute("aria-pressed")).toBe("true");

  const files = await within(map).findByRole("region", { name: "Files in web/src/lib" });
  await waitFor(() =>
    expect(
      calls.find((c) => c.method === "codemap.get" && (c.params as { module?: string }).module)?.params,
    ).toEqual({
      projectId: "prj_1",
      level: "file",
      module: "web/src/lib",
      limit: 300,
    }),
  );
  expect(await within(files).findByText("Files elsewhere they work with")).toBeTruthy();
  fireEvent.click(within(files).getByRole("button", { name: /cn\.ts/ }));

  const file = await within(map).findByRole("region", { name: "File web/src/lib/cn.ts" });
  expect(await within(file).findByText("clsx")).toBeTruthy();
  expect(within(file).getByText("Imported by (1)")).toBeTruthy();
  expect(file.textContent).toContain("changed in 4 commits");
  fireEvent.click(within(file).getByRole("button", { name: "Open in Files" }));
  expect(useUi.getState().centerTab).toBe("files");
  expect(useOpenFile.getState().path).toBe("web/src/lib/cn.ts");
});

test("code map: hot spots open a file, and the full view lists entry points and cycles", async () => {
  wrap(<OverviewPanel />);
  const hot = await screen.findByRole("region", { name: "Hot spots" });
  expect(within(hot).getByText("Most imported")).toBeTruthy();
  expect(within(hot).queryByText("Most complex")).toBeNull();
  fireEvent.click(within(hot).getByRole("button", { name: /web\/src\/App\.tsx/ }));
  expect(await screen.findByRole("region", { name: "File web/src/App.tsx" })).toBeTruthy();

  const map = screen.getByRole("region", { name: "Code map" });
  fireEvent.click(within(map).getByRole("button", { name: "Open code map" }));
  const full = await screen.findByRole("region", { name: "Code map" });
  expect(screen.queryByRole("region", { name: "Project overview" })).toBeNull();
  expect(within(full).getByRole("region", { name: "Entry points" }).textContent).toContain(
    "mounts the React app",
  );
  expect(within(full).getByRole("region", { name: "Import cycles" }).textContent).toContain("routes.py");
  fireEvent.click(within(full).getByRole("button", { name: "Back to project" }));
  expect(await screen.findByRole("region", { name: "Project overview" })).toBeTruthy();
});

test("code map: a project without code says so instead of drawing an empty graph", async () => {
  responses["codemap.get"] = () => ({
    ...moduleMap,
    nodes: [],
    edges: [],
    cycles: [],
    entryPoints: [],
    hotSpots: { dependedOn: [], largest: [], complex: [], churn: [] },
    indexing: true,
  });
  wrap(<OverviewPanel />);
  const map = await screen.findByRole("region", { name: "Code map" });
  expect(await within(map).findByText(/still being built/)).toBeTruthy();
  expect(within(map).queryByRole("radiogroup")).toBeNull();
});

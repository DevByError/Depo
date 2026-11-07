import type { PreviewInfo, RunRecipe } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";
import { usePreviewUi } from "@/store/preview";
import { useUi } from "@/store/ui";

const calls: { method: string; params: Record<string, unknown> }[] = [];
let previews: PreviewInfo[] = [];
let recipes: RunRecipe[] = [];
let approvals: unknown[] = [];

const recipe = (o: Partial<RunRecipe> = {}): RunRecipe => ({
  id: "fastapi:.",
  kind: "fastapi",
  label: "FastAPI app (app/main.py)",
  command: "python -m uvicorn app.main:app --host 127.0.0.1 --port {port} --reload",
  cwd: "",
  env: { PORT: "{port}" },
  port: 8000,
  readyPath: "/",
  role: "backend",
  missing: null,
  ...o,
});

const preview = (o: Partial<PreviewInfo> = {}): PreviewInfo => ({
  id: "prv_1",
  projectId: "prj_1",
  taskId: null,
  target: "project",
  kind: "fastapi",
  label: "FastAPI app (app/main.py)",
  role: "backend",
  command: "python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload",
  cwd: "",
  port: 8000,
  url: "http://127.0.0.1:8000/",
  state: "running",
  phase: "Running",
  error: null,
  exitCode: null,
  startedBy: "user",
  groupId: null,
  approvalId: null,
  startedAt: "2026-11-07T10:00:00.000Z",
  readyAt: "2026-11-07T10:00:02.000Z",
  stoppedAt: null,
  ...o,
});

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    switch (method) {
      case "preview.targets":
        return Promise.resolve({
          targets: [
            { taskId: null, label: "Project folder", status: null },
            { taskId: "tsk_1", label: "Add a login page", status: "review" },
          ],
        });
      case "preview.detect":
        return Promise.resolve({
          target: "project",
          root: "C:\\p",
          recipes,
          suggested: 0,
          override: "",
          notes: [],
        });
      case "preview.list":
        return Promise.resolve({
          previews: params.projectId ? previews.filter((p) => p.projectId === params.projectId) : previews,
        });
      case "preview.logs":
        return Promise.resolve({
          lines: [
            { seq: 1, stream: "depo", text: "$ python -m uvicorn app.main:app" },
            { seq: 2, stream: "err", text: "INFO:     Uvicorn running on http://127.0.0.1:8000" },
          ],
          next: 2,
          dropped: false,
          state: "running",
        });
      case "preview.start": {
        const p = preview({ state: "starting", phase: "Starting" });
        previews = [p];
        return Promise.resolve({ preview: p, related: [] });
      }
      case "preview.stop":
        previews = previews.map((p) => ({ ...p, state: "stopped" as const }));
        return Promise.resolve({ stopped: true });
      case "projects.settings.set":
        return Promise.resolve({});
      case "approvals.list":
        return Promise.resolve({ approvals });
      case "approvals.respond":
        return Promise.resolve({ ok: true });
      case "tasks.active":
        return Promise.resolve({ tasks: [] });
      case "projects.list":
        return Promise.resolve({ projects: [{ id: "prj_1", name: "Shop" }] });
      case "scheduler.status":
        return Promise.resolve({ running: [], queued: [], pausedAll: false });
      case "changes.list":
        return Promise.resolve({
          changeSets: [
            {
              id: "cs_1",
              projectId: "prj_1",
              taskId: "tsk_1",
              status: "pending",
              title: "Add a login page",
              files: [],
              createdAt: "2026-11-07T10:00:00.000Z",
              updatedAt: "2026-11-07T10:00:00.000Z",
            },
          ],
        });
      case "checkpoints.list":
        return Promise.resolve({ checkpoints: [] });
      default:
        return Promise.reject(new Error(`unmocked ${method}`));
    }
  },
}));

import { RunningSection } from "@/components/layout/RunningSection";
import { DiffReviewPanel } from "./DiffReviewPanel";
import { PreviewPanel } from "./PreviewPanel";

const opened: string[] = [];
let clipboard = "";

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  previews = [];
  recipes = [recipe()];
  approvals = [];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1", centerTab: "preview" });
  usePreviewUi.setState({
    projectId: null,
    taskId: null,
    previewId: null,
    autoStart: false,
    device: "desktop",
  });
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (t: string) => {
        clipboard = t;
        return Promise.resolve();
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

test("Preview tab: shows the detected command, starts the project and gives a link with a viewer and a log", async () => {
  // The viewer's area measures 400 × 600 once it appears.
  class FakeResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width: 400, height: 600 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const view = mount(<PreviewPanel />);
  const input = (await screen.findByLabelText("Start command")) as HTMLInputElement;
  await waitFor(() => expect(input.value).toContain("uvicorn app.main:app"));
  expect(screen.getByRole("combobox", { name: /What to run/ })).toBeTruthy();
  expect(screen.getByText("Task: Add a login page (changes not applied yet)")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(calls.some((c) => c.method === "preview.start")).toBe(true));
  const sent = calls.find((c) => c.method === "preview.start")?.params as {
    projectId: string;
    install: boolean;
  };
  expect(sent.projectId).toBe("prj_1");
  expect(sent.install).toBe(false);

  // The engine reports it running: the link, the viewer and the log appear.
  previews = [preview()];
  view.unmount();
  mount(<PreviewPanel />);
  const link = await screen.findByRole("link", { name: "http://127.0.0.1:8000/" });
  fireEvent.click(link);
  await waitFor(() => expect(opened).toEqual(["http://127.0.0.1:8000/"]));
  fireEvent.click(screen.getByRole("button", { name: /Open in browser/ }));
  await waitFor(() => expect(opened.length).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Copied/ })).toBeTruthy());
  expect(clipboard).toBe("http://127.0.0.1:8000/");

  const frame = screen.getByTitle("Preview of FastAPI app (app/main.py)") as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("http://127.0.0.1:8000/");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  fireEvent.click(screen.getByRole("button", { name: /Phone/ }));
  expect(screen.getByRole("button", { name: /Phone/ }).getAttribute("aria-pressed")).toBe("true");
  // The page renders at the phone's real size (scaled to fit the panel).
  expect((screen.getByTitle("Preview of FastAPI app (app/main.py)") as HTMLIFrameElement).style.width).toBe(
    "390px",
  );
  // 600 / 844 of the height fits: 71%.
  expect(screen.getByTestId("device-size").textContent).toBe("390 × 844 · 71%");
  const phone = screen.getByTitle("Preview of FastAPI app (app/main.py)") as HTMLIFrameElement;
  expect(phone.style.transform).toMatch(/^scale\(0\.71/);
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(screen.getByTestId("device-size").textContent).toBe("390 × 844 · 100%");
  expect(phone.style.transform).toBe("scale(1)");
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));
  expect(screen.getByTestId("device-size").textContent).toBe("1440 × 900 · 28%");
  vi.unstubAllGlobals();

  const log = screen.getByRole("region", { name: "Preview log" });
  expect(log.getAttribute("tabindex")).toBe("0");
  expect(await within(log).findByText(/Uvicorn running/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "preview.stop" && c.params.id === "prv_1")).toBe(true),
  );
});

test("Preview tab: missing packages offer Install and start; an edited command can be remembered", async () => {
  recipes = [
    recipe({
      missing: {
        reason: "The packages are not installed.",
        install: "python -m pip install -r requirements.txt",
        cwd: "",
      },
    }),
  ];
  mount(<PreviewPanel />);
  expect(await screen.findByText("Some packages are not installed yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Install and start/ }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "preview.start")?.params).toMatchObject({ install: true }),
  );

  const input = screen.getByLabelText("Start command") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "make run PORT={port}" } });
  fireEvent.click(screen.getByRole("button", { name: "Remember this command" }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "projects.settings.set")?.params).toEqual({
      id: "prj_1",
      patch: { previewCommand: "make run PORT={port}" },
    }),
  );
});

test("Preview tab: an install waiting for approval can be answered right there", async () => {
  previews = [
    preview({ state: "starting", phase: "Waiting for your OK to install packages", approvalId: "req_1" }),
  ];
  approvals = [
    {
      id: "req_1",
      createdAt: "2026-11-07T10:00:00.000Z",
      projectId: "prj_1",
      taskId: null,
      agent: "engine",
      kind: "command",
      title: 'Install packages: "npm install"?',
      reason: "This downloads packages from the internet.",
      details: { command: "npm install", previewId: "prv_1" },
    },
  ];
  mount(<PreviewPanel />);
  expect(await screen.findByText("Depo needs your OK to install packages")).toBeTruthy();
  expect(await screen.findByText("npm install")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "approvals.respond")?.params).toEqual({
      id: "req_1",
      approve: true,
    }),
  );
});

test("Preview these changes: the Preview tab starts the task's copy by itself", async () => {
  usePreviewUi.getState().show({ projectId: "prj_1", taskId: "tsk_1", autoStart: true });
  mount(<PreviewPanel />);
  await waitFor(() =>
    expect(calls.find((c) => c.method === "preview.start")?.params).toMatchObject({
      projectId: "prj_1",
      taskId: "tsk_1",
    }),
  );
  expect(usePreviewUi.getState().autoStart).toBe(false);
});

test("Preview tab: opens on the task copy Depo already started instead of offering to start again", async () => {
  previews = [
    preview({
      id: "prv_auto",
      taskId: "tsk_1",
      target: "workspace",
      url: "http://127.0.0.1:41234/",
      startedBy: "agent",
    }),
  ];
  mount(<PreviewPanel />);
  await waitFor(() =>
    expect(usePreviewUi.getState()).toMatchObject({ taskId: "tsk_1", previewId: "prv_auto" }),
  );
  expect(calls.some((c) => c.method === "preview.start")).toBe(false);
});

test("Preview tab: a site with an API opens on the site, and the API can be shown too", async () => {
  // The owner's run: the API started first, so the Preview tab showed its JSON instead of the site.
  const group = {
    taskId: "tsk_1",
    target: "workspace" as const,
    groupId: "grp_1",
    startedBy: "agent" as const,
  };
  previews = [
    preview({ ...group, id: "prv_be", label: "Bun app in be", kind: "bun", url: "http://127.0.0.1:44212/" }),
    preview({
      ...group,
      id: "prv_fe",
      label: "Next.js app in fe",
      kind: "next",
      role: "frontend",
      url: "http://127.0.0.1:3000/",
    }),
  ];
  mount(<PreviewPanel />);
  await waitFor(() =>
    expect(usePreviewUi.getState()).toMatchObject({ taskId: "tsk_1", previewId: "prv_fe" }),
  );
  expect(await screen.findByTitle("Preview of Next.js app in fe")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show here" }));
  expect(await screen.findByTitle("Preview of Bun app in be")).toBeTruthy();
});

test("Running section: running previews show their link and open the Preview tab", async () => {
  previews = [preview({ taskId: "tsk_1", target: "workspace" })];
  useUi.setState({ centerTab: "chat" });
  mount(<RunningSection />);
  const list = await screen.findByRole("list", { name: "Running previews" });
  expect(within(list).getByText("http://127.0.0.1:8000/")).toBeTruthy();
  expect(within(list).getByText(/task copy/)).toBeTruthy();
  expect(screen.queryByText("Nothing running")).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: "Open http://127.0.0.1:8000/ in your browser" }));
  await waitFor(() => expect(opened).toEqual(["http://127.0.0.1:8000/"]));
  fireEvent.click(within(list).getByText("http://127.0.0.1:8000/"));
  expect(useUi.getState().centerTab).toBe("preview");
  expect(usePreviewUi.getState()).toMatchObject({ projectId: "prj_1", taskId: "tsk_1", previewId: "prv_1" });
});

test("Diff Review: Preview these changes opens the Preview tab on the task's copy", async () => {
  useUi.setState({ centerTab: "diff" });
  mount(<DiffReviewPanel />);
  fireEvent.click(await screen.findByRole("button", { name: /Preview these changes/ }));
  expect(useUi.getState().centerTab).toBe("preview");
  expect(usePreviewUi.getState()).toMatchObject({ projectId: "prj_1", taskId: "tsk_1", autoStart: true });
});

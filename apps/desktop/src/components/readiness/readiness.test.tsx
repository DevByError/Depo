import type { DepoEvent, ReadinessCheck, ReadinessReport } from "@depo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useEngine } from "@/store/engine";

const calls: { method: string; params: Record<string, unknown>; opts?: { timeoutMs?: number } }[] = [];
let current: ReadinessReport;
let runImpl: (params: Record<string, unknown>) => Promise<unknown> = () =>
  Promise.reject(new Error("no run"));

vi.mock("@/lib/engine", () => ({
  call: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
    calls.push({ method, params, ...(opts ? { opts } : {}) });
    if (method === "readiness.get") return Promise.resolve({ report: current });
    if (method === "readiness.run") return runImpl(params);
    return Promise.reject(new Error(`unmocked ${method}`));
  },
}));

import { ReadinessCard } from "./ReadinessCard";
import { ReadinessBadge, ReadinessPill } from "./ReadinessPill";
import { shortVerdict, sortChecks } from "./readiness-view";
import { lastReadinessEvent } from "./use-readiness";

const check = (
  o: Partial<ReadinessCheck> & Pick<ReadinessCheck, "id" | "label" | "state">,
): ReadinessCheck => ({
  summary: `${o.label}.`,
  evidence: [],
  items: [],
  expected: false,
  reason: null,
  action: null,
  ...o,
});

const TESTS_ACTION = {
  run: "tests" as const,
  label: "Run again",
  detail: "npm test in the private copy",
  running: false,
};

function report(o: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    taskId: "tsk_1",
    projectId: "prj_1",
    changeSetId: "cs_1",
    at: "2026-11-07T12:00:00.000Z",
    verdict: "ready_with_warnings",
    headline: "Ready with 2 warnings",
    reasons: ["tests were not run after the last change", "1 open comment"],
    text: "Ready with 2 warnings: tests were not run after the last change; 1 open comment.",
    failures: 0,
    warnings: 2,
    checks: [
      check({
        id: "code",
        label: "Code checks",
        state: "not_run",
        summary: "Code checks are not available in this engine.",
      }),
      check({
        id: "tests",
        label: "Tests",
        state: "stale",
        summary: "Tests passed, but files changed after the last run.",
        evidence: ["Command: npm test", "0 failed, 12 passed", "Ran at 11:50 by the coding agent"],
        reason: "tests were not run after the last change",
        action: TESTS_ACTION,
      }),
      check({
        id: "security",
        label: "Security",
        state: "not_run",
        summary: "This copy was not scanned for security problems.",
        action: {
          run: "security",
          label: "Scan",
          detail: "Scans the private copy for secrets, risky code and known vulnerable packages",
          running: false,
        },
      }),
      check({
        id: "page",
        label: "Page check",
        state: "not_run",
        summary: "The page was not checked.",
        action: {
          run: "page",
          label: "Check the page",
          detail: "Starts the private copy, then opens it in a headless browser",
          running: false,
        },
      }),
      check({
        id: "comments",
        label: "Open comments",
        state: "warn",
        summary: "1 comment is still open.",
        evidence: ["Not sent to the agent yet"],
        items: [{ text: "app.py:5 Add a docstring.", ok: null }],
        reason: "1 open comment",
      }),
      check({
        id: "risky",
        label: "Risky changes",
        state: "pass",
        summary: "No migrations, auth, lockfiles, CI, environment files or deletions.",
      }),
    ],
    ...o,
  };
}

const ready = (): ReadinessReport =>
  report({
    verdict: "ready",
    headline: "Ready",
    reasons: ["tests passed after the last change"],
    text: "Ready: tests passed after the last change.",
    warnings: 0,
    checks: report().checks.map((c) =>
      c.id === "tests"
        ? {
            ...c,
            state: "pass",
            summary: "All 12 tests passed after the last change.",
            reason: "tests passed after the last change",
          }
        : c.id === "comments"
          ? { ...c, state: "pass", summary: "No open comments.", evidence: [], items: [], reason: null }
          : c,
    ),
  });

const notReady = (): ReadinessReport =>
  report({
    verdict: "not_ready",
    headline: "Not ready",
    reasons: ["2 of 12 tests failed"],
    text: "Not ready: 2 of 12 tests failed.",
    failures: 1,
    warnings: 0,
  });

let seq = 0;
const event = (o: Partial<DepoEvent>): DepoEvent => ({
  id: `evt_${String(++seq).padStart(28, "0")}`,
  ts: new Date().toISOString(),
  seq,
  projectId: "prj_1",
  taskId: "tsk_1",
  agent: "coder@1.0.0",
  type: "test_result",
  text: "Tests: 12 passed",
  details: null,
  durationMs: null,
  status: "succeeded",
  ephemeral: false,
  ...o,
});

const gets = () => calls.filter((c) => c.method === "readiness.get").length;

function mount(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return { qc, ...view };
}

beforeEach(() => {
  calls.length = 0;
  current = report();
  runImpl = () => Promise.reject(new Error("no run"));
  useEngine.setState({ status: "open", events: [] });
});
afterEach(() => {
  cleanup();
});

describe("ReadinessCard", () => {
  test("a region named Readiness: the verdict in words, problems first, rows that open for evidence", async () => {
    mount(<ReadinessCard taskId="tsk_1" />);
    const region = await screen.findByRole("region", { name: "Readiness" });
    await within(region).findByText("Ready with 2 warnings");
    expect(region.textContent).toContain("Tests were not run after the last change. 1 open comment.");
    expect(calls[0]).toEqual({ method: "readiness.get", params: { taskId: "tsk_1" } });

    const list = within(region).getByRole("list", { name: "Checks" });
    const rows = within(list).getAllByRole("listitem");
    // Out of date and warnings first, then what passed, then what did not run.
    expect(rows.map((r) => r.textContent?.split(":")[0])).toEqual([
      "Out of date",
      "Warning",
      "Passed",
      "Not run",
      "Not run",
      "Not run",
    ]);
    expect(rows[0]?.textContent).toContain("Tests");

    const tests = within(list).getByRole("button", { name: /^Out of date: Tests/ });
    expect(tests.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tests);
    expect(tests.getAttribute("aria-expanded")).toBe("true");
    const evidence = screen.getByRole("list", { name: "Tests evidence" });
    expect(
      within(evidence)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Command: npm test", "0 failed, 12 passed", "Ran at 11:50 by the coding agent"]);
    expect(document.getElementById(tests.getAttribute("aria-controls") ?? "")).toBeTruthy();

    fireEvent.click(within(list).getByRole("button", { name: /^Warning: Open comments/ }));
    expect(screen.getByRole("list", { name: "Open comments details" }).textContent).toContain(
      "app.py:5 Add a docstring.",
    );
    // Nothing more to show: a plain row, not a button.
    expect(within(list).queryByRole("button", { name: /Code checks/ })).toBeNull();
    fireEvent.click(tests);
    expect(screen.queryByRole("list", { name: "Tests evidence" })).toBeNull();
  });

  test("Run again runs the tests in the private copy and shows the new report", async () => {
    let finish: (v: unknown) => void = () => {};
    runImpl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    mount(<ReadinessCard taskId="tsk_1" />);
    const run = await screen.findByRole("button", { name: "Run again" });
    expect(run.getAttribute("title")).toBe("npm test in the private copy");
    expect(screen.getByRole("button", { name: "Check the page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan" })).toBeTruthy();

    fireEvent.click(run);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Running the tests in the private copy."),
    );
    expect(calls.find((c) => c.method === "readiness.run")).toEqual({
      method: "readiness.run",
      params: { taskId: "tsk_1", check: "tests" },
      opts: { timeoutMs: 20 * 60_000 },
    });
    // One run at a time from here.
    expect((screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Scan" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finish({ report: ready(), message: "Tests passed: 12 passed.", ok: true }));
    await screen.findByText("Ready");
    expect(screen.getByRole("status").textContent).toBe("Tests passed: 12 passed.");
    expect((screen.getByRole("button", { name: "Scan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("a run the command rules refuse says why", async () => {
    runImpl = () =>
      Promise.reject(new Error('Depo will not run "npm test": blocked by this project\'s command rules.'));
    mount(<ReadinessCard taskId="tsk_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Run again" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      'Depo will not run "npm test": blocked by this project\'s command rules.',
    );
  });

  test("a run started in another window shows as running", async () => {
    current = report({
      checks: report().checks.map((c) =>
        c.action ? { ...c, action: { ...c.action, running: c.id === "page" } } : c,
      ),
    });
    mount(<ReadinessCard taskId="tsk_1" />);
    const page = await screen.findByRole("button", { name: "Check the page" });
    expect((page as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("reads again after the task's test results, scans and decisions, and after comment changes", async () => {
    const { qc } = mount(<ReadinessCard taskId="tsk_1" />);
    await screen.findByText("Ready with 2 warnings");
    expect(gets()).toBe(1);

    // Another task's events and progress lines do not count.
    act(() =>
      useEngine.setState({
        events: [
          event({ taskId: "tsk_other" }),
          event({ type: "testing", ephemeral: true, status: "running" }),
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 450));
    expect(gets()).toBe(1);

    current = notReady();
    act(() => useEngine.setState((s) => ({ events: [...s.events, event({ status: "failed" })] })));
    await screen.findByText("Not ready", undefined, { timeout: 2000 });
    expect(gets()).toBe(2);

    // A burst (a scan and the decision after it) reads once.
    current = report();
    act(() =>
      useEngine.setState((s) => ({
        events: [
          ...s.events,
          event({ type: "security_scan", agent: "user" }),
          event({ type: "decision", details: { kind: "readiness" } }),
        ],
      })),
    );
    await screen.findByText("Ready with 2 warnings", undefined, { timeout: 2000 });
    expect(gets()).toBe(3);

    // A line comment added or resolved in Diff Review.
    current = ready();
    act(() => {
      qc.setQueryData(["changes", "comments", "cs_1"], { comments: [] });
    });
    await screen.findByText("Ready", undefined, { timeout: 2000 });
    expect(gets()).toBe(4);
    // Comments of another change set do not count.
    act(() => {
      qc.setQueryData(["changes", "comments", "cs_2"], { comments: [] });
    });
    await new Promise((r) => setTimeout(r, 450));
    expect(gets()).toBe(4);
  });

  test("when the engine cannot answer, it says so in words", async () => {
    current = undefined as unknown as ReadinessReport;
    mount(<ReadinessCard taskId="tsk_1" />);
    const region = await screen.findByRole("region", { name: "Readiness" });
    await waitFor(() => expect(region.textContent).toContain("Readiness is not available"));
  });
});

describe("ReadinessPill", () => {
  test("a button with the full label that opens the card; Escape closes it and gives focus back", async () => {
    mount(
      <div>
        <ReadinessPill taskId="tsk_1" />
        <button type="button">Elsewhere</button>
      </div>,
    );
    const pill = await screen.findByRole("button", {
      name: "Readiness: Ready with 2 warnings. Show details",
    });
    expect(pill.textContent).toBe("2 warnings");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Readiness" })).toBeNull();

    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(pill.getAttribute("aria-label")).toBe("Readiness: Ready with 2 warnings. Hide details");
    const region = screen.getByRole("region", { name: "Readiness" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(document.getElementById(pill.getAttribute("aria-controls") ?? "")?.contains(region)).toBe(true);

    const row = within(region).getByRole("button", { name: /^Out of date: Tests/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Readiness" })).toBeNull();
    expect(document.activeElement).toBe(pill);

    // A click elsewhere closes it too.
    fireEvent.click(pill);
    expect(screen.getByRole("region", { name: "Readiness" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("region", { name: "Readiness" })).toBeNull();
  });

  test("Ready and Not ready", async () => {
    current = notReady();
    const { unmount } = mount(<ReadinessPill taskId="tsk_1" />);
    expect(
      (await screen.findByRole("button", { name: "Readiness: Not ready. Show details" })).textContent,
    ).toBe("Not ready");
    unmount();
    current = ready();
    mount(<ReadinessPill taskId="tsk_1" />);
    expect((await screen.findByRole("button", { name: "Readiness: Ready. Show details" })).textContent).toBe(
      "Ready",
    );
  });

  test("the badge says the verdict in words", async () => {
    current = notReady();
    mount(<ReadinessBadge taskId="tsk_1" />);
    const badge = await screen.findByTestId("readiness-badge");
    expect(badge.textContent).toBe("Readiness: Not ready");
    expect(badge.getAttribute("title")).toBe("Not ready: 2 of 12 tests failed.");
  });
});

describe("helpers", () => {
  test("short verdicts, check order and the events that refresh", () => {
    expect(shortVerdict({ verdict: "ready_with_warnings", warnings: 1 })).toBe("1 warning");
    expect(shortVerdict({ verdict: "ready_with_warnings", warnings: 3 })).toBe("3 warnings");
    const expected = check({ id: "tests", label: "Tests", state: "not_run", expected: true });
    const sorted = sortChecks([
      check({ id: "size", label: "Size", state: "pass" }),
      check({ id: "code", label: "Code checks", state: "not_run" }),
      expected,
      check({ id: "page", label: "Page check", state: "fail" }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["page", "tests", "size", "code"]);

    const mine = event({ type: "rendering_screenshot" });
    expect(lastReadinessEvent([mine, event({ type: "reading_file" })], "tsk_1")).toBe(mine.id);
    expect(lastReadinessEvent([mine], "tsk_2")).toBeNull();
    expect(lastReadinessEvent([mine], null)).toBeNull();
  });
});

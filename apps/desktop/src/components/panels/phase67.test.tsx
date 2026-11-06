import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

import { AgentLabPanel } from "./AgentLabPanel";
import { SecurityPanel } from "./SecurityPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
  useEngine.setState({ status: "open" });
  useUi.setState({ projectId: "prj_1" });
});
afterEach(cleanup);

const report = {
  at: new Date().toISOString(),
  findings: [
    {
      tool: "depo",
      rule: "py.sql-injection",
      severity: "high" as const,
      file: "app.py",
      line: 9,
      title: "SQL built from user-controlled text (injection)",
      fix: "Use parameters.",
    },
  ],
  score: {
    overall: 85,
    grade: "B",
    blocksRelease: true,
    counts: { high: 1 },
    reasons: ["1 high severity finding(s)."],
  },
  ran: [{ tool: "depo built-in rules", note: "1 finding(s)" }],
  skipped: [{ tool: "Semgrep", install: "pip install semgrep" }],
};

test("Security panel: shows tools with install help, scans, lists findings with the fix and the score", async () => {
  responses["security.status"] = () => ({
    scanners: [
      {
        id: "semgrep",
        name: "Semgrep",
        kind: "code",
        purpose: "Finds insecure code",
        install: "pip install semgrep",
        installed: false,
      },
      {
        id: "k6",
        name: "k6",
        kind: "load",
        purpose: "Load tests",
        install: "winget install k6.k6",
        installed: true,
      },
    ],
    runtimes: [{ id: "docker", name: "Docker", install: "Install Docker Desktop", installed: false }],
  });
  responses["security.last"] = () => ({ report: null });
  responses["scores.get"] = () => ({ ux: null, security: null });
  responses["security.scan"] = () => report;
  wrap(<SecurityPanel />);
  expect(await screen.findByText("pip install semgrep")).toBeTruthy();
  expect(screen.getByText("Docker (missing)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Scan the project now" }));
  expect(await screen.findByText("app.py:9")).toBeTruthy();
  expect(screen.getByText("Fix: Use parameters.")).toBeTruthy();
  expect(screen.getByText(/Security score 85\/100/)).toBeTruthy();
  expect(screen.getByText(/blocks release/)).toBeTruthy();
  expect(calls.find((c) => c.method === "security.scan")?.params).toEqual({ projectId: "prj_1" });
});

test("Security panel: with no project the scan button is disabled", async () => {
  useUi.setState({ projectId: null });
  responses["security.status"] = () => ({ scanners: [], runtimes: [] });
  wrap(<SecurityPanel />);
  const b = (await screen.findByRole("button", { name: "Scan the project now" })) as HTMLButtonElement;
  expect(b.disabled).toBe(true);
});

const manifest = (version: string) => ({
  id: "backend",
  name: "Backend",
  version,
  group: "builders",
  role: "coder",
  mission: "Build the server",
  prompt: "You are the Backend agent.",
  tools: ["read_file"],
  reviewers: [],
  writes: [],
  skills: [],
  maxSteps: 40,
  outputs: "Code",
});
const versions = (activeId: string | null) => [
  {
    id: null,
    version: "1.0.0",
    note: "Ships with Depo",
    source: "builtin",
    createdAt: "",
    active: activeId === null,
    lastScore: 50,
    manifest: manifest("1.0.0"),
  },
  {
    id: "agv_1",
    version: "1.0.1",
    note: "More careful",
    source: "user",
    createdAt: new Date().toISOString(),
    active: activeId === "agv_1",
    lastScore: 100,
    manifest: manifest("1.0.1"),
  },
];

test("Agent Lab: lists versions, promotes one, shows the engine's refusal message, and rolls back", async () => {
  let active: string | null = null;
  responses["lab.agents"] = () => ({
    agents: [
      {
        id: "backend",
        name: "Backend",
        group: "builders",
        activeVersion: "1.0.0",
        versions: 2,
        lastScore: 50,
      },
    ],
  });
  responses["lab.versions"] = () => ({ versions: versions(active), history: [] });
  let refuse = true;
  responses["lab.promote"] = (p) => {
    if (refuse) throw new Error("It scores 50 where the current version scores 100 on the same checks.");
    active = (p as { versionId: string | null }).versionId;
    return { versions: versions(active) };
  };
  responses["lab.rollback"] = () => {
    active = null;
    return { versions: versions(active) };
  };
  wrap(<AgentLabPanel />);
  expect(await screen.findByText("Version 1.0.1")).toBeTruthy();
  expect(screen.getByText("last test 100/100")).toBeTruthy();
  const use = screen.getAllByRole("button", { name: "Use this version" });
  fireEvent.click(use[0] as HTMLElement);
  expect((await screen.findByRole("alert")).textContent).toContain("scores 50");
  refuse = false;
  fireEvent.click(screen.getAllByRole("button", { name: "Use this version" })[0] as HTMLElement);
  await waitFor(() => expect(calls.filter((c) => c.method === "lab.promote").length).toBe(2));
  expect(calls.filter((c) => c.method === "lab.promote").at(-1)?.params).toEqual({
    agentId: "backend",
    versionId: "agv_1",
  });
  await waitFor(() => expect(screen.getByText("in use")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /Go back to the previous version/ }));
  await waitFor(() => expect(calls.some((c) => c.method === "lab.rollback")).toBe(true));
});

test("Agent Lab: editing saves only the changed fields as a new version", async () => {
  responses["lab.agents"] = () => ({
    agents: [
      {
        id: "backend",
        name: "Backend",
        group: "builders",
        activeVersion: "1.0.0",
        versions: 1,
        lastScore: null,
      },
    ],
  });
  responses["lab.versions"] = () => ({ versions: versions(null).slice(0, 1), history: [] });
  responses["lab.createVersion"] = () => versions(null)[1];
  wrap(<AgentLabPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Edit" }));
  const prompt = (await screen.findByLabelText("Instructions")) as HTMLTextAreaElement;
  fireEvent.change(prompt, { target: { value: "You are the Backend agent. Be careful." } });
  fireEvent.change(screen.getByLabelText("What did you change?"), { target: { value: "careful" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
  await waitFor(() => expect(calls.some((c) => c.method === "lab.createVersion")).toBe(true));
  expect(calls.find((c) => c.method === "lab.createVersion")?.params).toEqual({
    agentId: "backend",
    patch: { prompt: "You are the Backend agent. Be careful." },
    note: "careful",
  });
});

test("Agent Lab: compare shows the winner and a per-check table; the playground keeps the conversation", async () => {
  responses["lab.agents"] = () => ({
    agents: [
      {
        id: "backend",
        name: "Backend",
        group: "builders",
        activeVersion: "1.0.0",
        versions: 2,
        lastScore: null,
      },
    ],
  });
  responses["lab.versions"] = () => ({ versions: versions(null), history: [] });
  responses["lab.suites"] = () => ({
    suites: [
      {
        id: "builtin:backend",
        agentId: "backend",
        name: "Starter checks",
        builtin: true,
        cases: [{ id: "role", prompt: "Who are you?", checks: [{ type: "contains", value: "x" }] }],
      },
    ],
  });
  const run = (version: string, score: number, passed: boolean) => ({
    id: "aer_1",
    agentId: "backend",
    versionId: null,
    version,
    suiteId: "builtin:backend",
    score,
    model: "m",
    createdAt: new Date().toISOString(),
    results: [{ caseId: "role", passed, checks: [], reply: "" }],
  });
  responses["lab.compare"] = () => ({
    a: run("1.0.0", 0, false),
    b: run("1.0.1", 100, true),
    winner: "b",
    cases: [{ caseId: "role", a: false, b: true }],
  });
  responses["lab.playground"] = () => ({ reply: "Hello from the agent", model: "m" });
  wrap(<AgentLabPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Compare" }));
  const go = await screen.findByRole("button", { name: "Compare" });
  await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(go);
  expect(await screen.findByText(/Version 1\.0\.1 did better: 0 against 100/)).toBeTruthy();
  expect(screen.getByText("Passed")).toBeTruthy();
  expect(screen.getByText("Failed")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Try it" }));
  fireEvent.change(await screen.findByLabelText("Message to the agent"), { target: { value: "hi there" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Hello from the agent")).toBeTruthy();
  expect(screen.getByText("hi there")).toBeTruthy();
  expect(calls.find((c) => c.method === "lab.playground")?.params).toEqual({
    agentId: "backend",
    versionId: null,
    messages: [{ role: "user", content: "hi there" }],
  });
});

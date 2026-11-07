import { afterEach, describe, expect, test } from "bun:test";

process.env.DEPO_NO_BROWSER = "1";

import fs from "node:fs";
import path from "node:path";
import type { ChatChunk, ChatRequest, ModelProvider, ToolCall } from "@depo/model-gateway";
import {
  ApiSchema,
  type ChangeSet,
  type DepoEvent,
  newId,
  type PageCheck,
  type PageView,
  type Plan,
  PlanSchema,
  type ReadinessAction,
  type ReadinessCheck,
  type ReadinessReport,
  ReadinessReportSchema,
  type ReviewComment,
  type RpcResponse,
} from "@depo/shared";
import { eq } from "drizzle-orm";
import { LANDING_HTML } from "../../../scripts/fake-ollama-lib";
import { Blackboard } from "../src/agents/blackboard";
import { agentTag } from "../src/agents/manifests";
import { tasks as tasksTable } from "../src/db/schema";
import { CdpConnection, sessionFor } from "../src/design/cdp";
import { createEngine, type Engine } from "../src/engine";
import { saveCheck } from "../src/qa/store";
import {
  codeCheck,
  commentsCheck,
  type DiagnosticsSource,
  decideVerdict,
  isAfter,
  pageCheck,
  pageEvidence,
  planCheck,
  type ReviewEvidence,
  reviewsCheck,
  riskyCheck,
  riskyFiles,
  type ScoreEvidence,
  securityCheck,
  shortVerdict,
  sizeCheck,
  type TestRunEvidence,
  testsCheck,
  uiFiles,
  uxCheck,
  when,
} from "../src/readiness/checks";
import { ReadinessService, whoRan } from "../src/readiness/service";
import { startFakeCdp } from "./fake-cdp";
import { TEST_TOKEN, tempDir, waitFor } from "./helpers";

/**
 * The readiness report: each check's states from stored evidence, the verdict rules, the checks the
 * owner runs from the report (tests, page, scan) in the private copy, the readiness decision at
 * review, and the RPCs.
 */

const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

// ---- pure rules ----------------------------------------------------------------------------------

const NOW = new Date("2026-11-07T12:00:00");
const T = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const never = () => false;
/** Files changed at `iso`. */
const changedAt = (iso: string) => (at: string) => isAfter(iso, at);

const testAction: ReadinessAction = {
  run: "tests",
  label: "Run tests",
  detail: "npm test in the private copy",
  running: false,
};

const testRun = (o: Partial<TestRunEvidence> = {}): TestRunEvidence => ({
  at: T(-10),
  command: "npm test",
  ok: true,
  passed: 12,
  failed: 0,
  exitCode: 0,
  timedOut: false,
  by: "the coding agent",
  ...o,
});

const score = (o: Partial<ScoreEvidence> = {}): ScoreEvidence => ({
  at: T(-10),
  score: 95,
  grade: "A",
  blocks: false,
  critical: 0,
  high: 0,
  findings: 1,
  scope: "copy",
  tools: ["depo built-in rules"],
  ...o,
});

function view(o: Partial<PageView> = {}): PageView {
  return {
    width: "desktop",
    viewport: { width: 1280, height: 800 },
    screenshot: null,
    thumbnail: null,
    loaded: true,
    status: 200,
    title: "Welcome",
    consoleErrors: [],
    consoleErrorCount: 0,
    failedRequests: [],
    failedRequestCount: 0,
    a11y: {
      ran: true,
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      violations: [],
      error: null,
    },
    expectFound: null,
    steps: [],
    error: null,
    durationMs: 10,
    ...o,
  };
}

function pageCheckOf(views: PageView[], o: Partial<PageCheck> = {}): PageCheck {
  return {
    id: newId("qa"),
    projectId: "prj_1",
    taskId: "tsk_1",
    url: "http://127.0.0.1:5173/",
    by: "frontend@1.0.0",
    at: T(-10),
    expectText: null,
    views,
    vision: null,
    summary: "ok",
    ok: true,
    durationMs: 10,
    ...o,
  };
}

const file = (p: string, o: Partial<{ kind: "added" | "modified" | "deleted"; additions: number }> = {}) => ({
  path: p,
  kind: o.kind ?? ("modified" as const),
  additions: o.additions ?? 3,
  deletions: 1,
  binary: false,
});

function c(id: ReadinessCheck["id"], state: ReadinessCheck["state"], reason: string | null = null) {
  return {
    id,
    label: id,
    state,
    summary: `${id} ${state}.`,
    evidence: [],
    items: [],
    expected: false,
    reason,
    action: null,
  } satisfies ReadinessCheck;
}

describe("Tests check", () => {
  test("passed after the last change", () => {
    const r = testsCheck({
      run: testRun(),
      changedAfter: never,
      command: null,
      action: testAction,
      now: NOW,
    });
    expect(r.state).toBe("pass");
    expect(r.summary).toBe("All 12 tests passed after the last change.");
    expect(r.evidence).toEqual([
      "Command: npm test",
      "0 failed, 12 passed",
      "Ran at 11:50 by the coding agent",
    ]);
    expect(r.action).toEqual(testAction);
  });

  test("stale when files changed after a passing run", () => {
    const r = testsCheck({ run: testRun(), changedAfter: changedAt(T(-5)), command: null, action: null });
    expect(r.state).toBe("stale");
    expect(r.reason).toBe("tests were not run after the last change");
  });

  test("failing tests fail, and say when files changed after the run", () => {
    const failing = testRun({ ok: false, passed: 10, failed: 2, exitCode: 1 });
    const r = testsCheck({ run: failing, changedAfter: never, command: null, action: null });
    expect(r.state).toBe("fail");
    expect(r.summary).toBe("2 of 12 tests failed.");
    expect(r.reason).toBe("2 of 12 tests failed");
    const later = testsCheck({ run: failing, changedAfter: changedAt(T(-1)), command: null, action: null });
    expect(later.state).toBe("fail");
    expect(later.summary).toContain("Files changed after it, and the tests did not run again.");
  });

  test("a time-out or a failure without counts", () => {
    const slow = testsCheck({
      run: testRun({ ok: false, timedOut: true, passed: null, failed: null, exitCode: null }),
      changedAfter: never,
      command: null,
      action: null,
    });
    expect(slow.reason).toBe("the last test run timed out");
    const crash = testsCheck({
      run: testRun({ ok: false, passed: null, failed: null, exitCode: 1 }),
      changedAfter: never,
      command: null,
      action: null,
    });
    expect(crash.summary).toBe("The last test run failed (exit code 1).");
    expect(crash.evidence).not.toContain("0 failed, 0 passed");
  });

  test("not run: a warning when a test command is known, neutral when not", () => {
    const known = testsCheck({
      run: null,
      changedAfter: never,
      command: { command: "npm test", source: "memory" },
      action: testAction,
    });
    expect(known).toMatchObject({ state: "not_run", expected: true, reason: "tests were not run" });
    expect(known.evidence).toEqual(["Test command: npm test (from memory)"]);
    const unknown = testsCheck({ run: null, changedAfter: never, command: null, action: null });
    expect(unknown).toMatchObject({ state: "not_run", expected: false, reason: null });
  });
});

describe("Code checks (diagnostics source)", () => {
  const result = (error: number, warning: number) => ({
    at: T(-10),
    tools: ["tsc", "eslint"],
    skipped: ["ruff"],
    counts: { error, warning, info: 4 },
  });

  test("absent source and a null result are not run", () => {
    expect(codeCheck({ available: false, result: null, changedAfter: never }).summary).toBe(
      "Code checks are not available in this engine.",
    );
    const none = codeCheck({ available: true, result: null, changedAfter: never });
    expect(none).toMatchObject({ state: "not_run", expected: false });
    expect(none.summary).toBe("Code checks have not run on this change.");
  });

  test("errors fail, warnings warn, clean passes, old results are stale", () => {
    const errors = codeCheck({ available: true, result: result(3, 1), changedAfter: never, now: NOW });
    expect(errors).toMatchObject({ state: "fail", reason: "3 code errors" });
    expect(errors.evidence).toEqual([
      "Checked with tsc, eslint",
      "3 errors, 1 warning",
      "Not installed: ruff",
      "Ran at 11:50",
    ]);
    expect(codeCheck({ available: true, result: result(0, 2), changedAfter: never })).toMatchObject({
      state: "warn",
      reason: "2 code warnings",
    });
    expect(codeCheck({ available: true, result: result(0, 2), changedAfter: changedAt(T(-1)) }).state).toBe(
      "stale",
    );
    expect(codeCheck({ available: true, result: result(0, 0), changedAfter: never })).toMatchObject({
      state: "pass",
      reason: "no code errors",
    });
    expect(codeCheck({ available: true, result: result(0, 0), changedAfter: changedAt(T(-1)) }).state).toBe(
      "stale",
    );
    // Errors stay a failure even when files changed after: they were found and nothing says they are fixed.
    expect(codeCheck({ available: true, result: result(1, 0), changedAfter: changedAt(T(-1)) }).state).toBe(
      "fail",
    );
  });
});

describe("Security check", () => {
  const sec = (copy: ScoreEvidence | null, project: ScoreEvidence | null, changed = never) =>
    securityCheck({ copy, project, changedAfter: changed, action: null, now: NOW });

  test("this copy's scan: high findings or a blocking score fail, a low score warns", () => {
    expect(sec(score({ critical: 1, high: 0 }), null)).toMatchObject({
      state: "fail",
      summary: "This copy has 1 high or critical finding.",
      reason: "1 high or critical security finding",
    });
    expect(sec(score({ score: 55, blocks: true }), null)).toMatchObject({
      state: "fail",
      reason: "security score 55/100",
    });
    expect(sec(score({ score: 70 }), null)).toMatchObject({ state: "warn", reason: "security score 70/100" });
  });

  test("a clean scan passes, unless files changed after it", () => {
    const ok = sec(score(), null);
    expect(ok.state).toBe("pass");
    expect(ok.evidence).toContain("Scanned this copy at 11:50");
    expect(sec(score(), null, changedAt(T(-1))).state).toBe("stale");
  });

  test("only the project's scan: not run when clean, a failure when it has serious findings", () => {
    const clean = sec(null, score({ scope: "project", score: 92 }));
    expect(clean.state).toBe("not_run");
    expect(clean.summary).toContain("This copy was not scanned. The project's last scan scored 92/100");
    const bad = sec(null, score({ scope: "project", high: 2 }));
    expect(bad.state).toBe("fail");
    expect(bad.summary).toBe(
      "The project's last scan has 2 high or critical findings. This copy was not scanned.",
    );
    expect(sec(null, null)).toMatchObject({ state: "not_run", expected: false });
  });
});

describe("UX check", () => {
  test("which files draw screens", () => {
    expect(
      uiFiles([
        file("src/App.tsx"),
        file("styles/site.css"),
        file("src/components/Button.ts"),
        file("public/logo.svg"),
        file("server/main.py"),
        file("README.md"),
        file("src/lib/util.ts"),
        file("src/author.ts"),
      ]),
    ).toEqual(["src/App.tsx", "styles/site.css", "src/components/Button.ts", "public/logo.svg"]);
  });

  test("states", () => {
    const ui = ["src/App.tsx"];
    expect(uxCheck({ ui: [], score: null, changedAfter: never }).state).toBe("not_run");
    expect(uxCheck({ ui, score: null, changedAfter: never }).evidence).toEqual([
      "Screens changed: src/App.tsx",
    ]);
    expect(uxCheck({ ui, score: score({ score: 40, blocks: true }), changedAfter: never }).state).toBe(
      "fail",
    );
    expect(uxCheck({ ui, score: score({ score: 72 }), changedAfter: never })).toMatchObject({
      state: "warn",
      reason: "UX score 72/100",
    });
    const older = uxCheck({ ui, score: score({ scope: "project", score: 90 }), changedAfter: never });
    expect(older.state).toBe("not_run");
    expect(older.summary).toContain("this change was not scored");
    expect(uxCheck({ ui, score: score({ score: 90 }), changedAfter: changedAt(T(-1)) }).state).toBe("stale");
    expect(uxCheck({ ui, score: score({ score: 90 }), changedAfter: never }).state).toBe("pass");
  });
});

describe("Page check", () => {
  const check = (pc: PageCheck, changed = never) =>
    pageCheck({ page: pageEvidence(pc, "you"), ui: [], changedAfter: changed, action: null, now: NOW });

  test("console errors and server failures fail", () => {
    const pc = pageCheckOf([
      view({
        width: "phone",
        consoleErrors: [
          { kind: "exception", text: "TypeError: x is undefined\n  at main.js:3", source: null },
        ],
        consoleErrorCount: 2,
        failedRequests: [
          {
            url: "http://127.0.0.1:5173/api/items",
            method: "GET",
            status: 500,
            error: null,
            type: "Fetch",
            blocked: false,
          },
          {
            url: "https://fonts.example.com/a.css",
            method: "GET",
            status: null,
            error: "blocked",
            type: "Stylesheet",
            blocked: true,
          },
        ],
        failedRequestCount: 2,
      }),
      view(),
    ]);
    const r = check(pc);
    expect(r.state).toBe("fail");
    expect(r.summary).toBe("The page has 2 console errors and 1 failed request.");
    expect(r.evidence).toEqual([
      "127.0.0.1:5173/ at phone, desktop widths",
      "2 console errors: TypeError: x is undefined",
      "1 failed request: GET /api/items (500)",
      "1 request to the internet blocked",
      "Checked at 11:50 by you",
    ]);
  });

  test("serious accessibility issues warn; a page that did not load fails; clean passes", () => {
    const a11y = view({
      a11y: {
        ran: true,
        counts: { critical: 1, serious: 2, moderate: 0, minor: 3 },
        violations: [],
        error: null,
      },
    });
    expect(check(pageCheckOf([a11y]))).toMatchObject({
      state: "warn",
      reason: "3 serious accessibility issues",
    });
    expect(check(pageCheckOf([a11y]), changedAt(T(-1))).state).toBe("stale");
    const missing = view({
      failedRequests: [
        {
          url: "http://127.0.0.1:5173/logo.png",
          method: "GET",
          status: 404,
          error: null,
          type: "Image",
          blocked: false,
        },
      ],
      failedRequestCount: 1,
    });
    expect(check(pageCheckOf([missing])).summary).toBe("The page loaded with 1 missing file or page.");
    expect(check(pageCheckOf([view({ loaded: false, error: "net::ERR_CONNECTION_REFUSED" })])).state).toBe(
      "fail",
    );
    expect(check(pageCheckOf([view()]))).toMatchObject({ state: "pass", reason: "the page check was clean" });
    expect(check(pageCheckOf([view()]), changedAt(T(-1))).state).toBe("stale");
    expect(pageCheck({ page: null, ui: ["index.html"], changedAfter: never, action: null }).summary).toBe(
      "Screens changed, but the page was not checked.",
    );
  });
});

describe("Plan criteria and reviews", () => {
  const node = (o: Partial<Plan["nodes"][number]> & { id: string }) => ({
    title: `Do ${o.id}`,
    owner: "backend" as const,
    ...o,
  });
  const plan = (nodes: ReturnType<typeof node>[]): Plan => PlanSchema.parse({ mode: "full", nodes });
  const name = (id: string) => id[0]?.toUpperCase() + id.slice(1);

  test("criteria met when their task is done; unmet ones are listed first", () => {
    const met = planCheck(
      plan([
        node({ id: "api", criteria: ["GET /health answers ok"], status: "done" }),
        node({ id: "ui", owner: "frontend", criteria: ["A button", "It works on phones"], status: "done" }),
      ]),
      name,
    );
    expect(met).toMatchObject({ state: "pass", summary: "All 3 acceptance criteria are met." });
    const unmet = planCheck(
      plan([
        node({ id: "api", criteria: ["GET /health answers ok"], status: "done" }),
        node({ id: "ui", owner: "frontend", criteria: ["A button", "It works on phones"], status: "doing" }),
      ]),
      name,
    );
    expect(unmet).toMatchObject({ state: "warn", reason: "2 of 3 plan criteria not met" });
    expect(unmet.items.map((i) => [i.text, i.ok])).toEqual([
      ["Frontend: A button", false],
      ["Frontend: It works on phones", false],
      ["Backend: GET /health answers ok", true],
    ]);
    expect(unmet.evidence).toContain("Not finished: Do ui");
  });

  test("a plan without criteria: every task finished, or not", () => {
    expect(planCheck(plan([node({ id: "a", status: "done" })]), name).state).toBe("pass");
    const open = planCheck(
      plan([node({ id: "a", status: "done" }), node({ id: "b", status: "blocked" })]),
      name,
    );
    expect(open).toMatchObject({ state: "warn", reason: "1 planned task did not finish" });
  });

  const ev = (kind: ReviewEvidence["kind"], nodeId: string, outcome: string | null): ReviewEvidence => ({
    ts: T(-5),
    kind,
    nodeId,
    outcome,
    text: "",
  });

  test("approved after a send-back passes; a rejection still open fails; unreviewed warns", () => {
    const p = plan([node({ id: "api", review: true, reviewer: "testing", status: "done" })]);
    const approved = reviewsCheck(
      p,
      [ev("review", "api", "changes"), ev("send_back", "api", null), ev("review", "api", "approved")],
      name,
    );
    expect(approved).toMatchObject({
      state: "pass",
      summary: "Every review approved the work, after 1 send-back.",
    });
    expect(approved.items[0]?.text).toBe("Do api: approved by Testing after 1 send-back");

    const rejected = reviewsCheck(
      plan([node({ id: "api", review: true, status: "review" })]),
      [ev("review", "api", "changes")],
      name,
    );
    expect(rejected).toMatchObject({ state: "fail", reason: "a reviewer still asks for changes" });
    expect(rejected.items[0]?.text).toBe("Do api: the reviewer still asks for changes");

    expect(reviewsCheck(plan([node({ id: "api", review: true, status: "failed" })]), [], name)).toMatchObject(
      {
        state: "warn",
        reason: "1 task not reviewed",
      },
    );
    expect(reviewsCheck(plan([node({ id: "api" })]), [], name).state).toBe("not_run");
  });
});

describe("Open comments, risky files and size", () => {
  test("open comments warn with each comment", () => {
    expect(commentsCheck(null).state).toBe("not_run");
    expect(commentsCheck([]).state).toBe("pass");
    const comment: ReviewComment = {
      id: "rvc_1",
      projectId: "prj_1",
      taskId: "tsk_1",
      changeSetId: "cs_1",
      path: "app.py",
      side: "new",
      line: 4,
      endSide: "new",
      endLine: 5,
      quote: "+x\n+y",
      body: "Add a **docstring**.",
      status: "open",
      addressedBy: null,
      addressedIn: null,
      sentAt: null,
      ref: null,
      createdAt: T(-3),
      updatedAt: T(-3),
    };
    const r = commentsCheck([comment]);
    expect(r).toMatchObject({ state: "warn", reason: "1 open comment" });
    expect(r.items).toEqual([{ text: "app.py:5 Add a docstring.", ok: null }]);
    expect(r.evidence).toEqual(["Not sent to the agent yet"]);
    expect(commentsCheck([comment, { ...comment, id: "rvc_2", sentAt: T(-1) }]).summary).toBe(
      "2 comments are still open.",
    );
  });

  test("risky files say why, without flagging look-alikes", () => {
    const files = [
      file("db/migrations/001_users.sql", { kind: "added" }),
      file("package-lock.json"),
      file(".github/workflows/ci.yml"),
      file(".env.local", { kind: "added" }),
      file("src/auth/session.ts"),
      file("old.txt", { kind: "deleted" }),
      { ...file("README.md"), conflict: true },
      file("src/author.ts"),
      file("design-tokens.json"),
      file("src/components/Sessions.tsx"),
      file("src/passwordless.md"),
    ];
    expect(riskyFiles(files)).toEqual([
      { path: "db/migrations/001_users.sql", why: "Migration" },
      { path: "package-lock.json", why: "Lockfile" },
      { path: ".github/workflows/ci.yml", why: "CI" },
      { path: ".env.local", why: "Environment file" },
      { path: "src/auth/session.ts", why: "Auth or secrets" },
      { path: "old.txt", why: "Deleted" },
      { path: "README.md", why: "Changed in the project since the copy was made" },
      { path: "src/components/Sessions.tsx", why: "Auth or secrets" },
    ]);
    const r = riskyCheck(files);
    expect(r.state).toBe("warn");
    expect(r.summary).toBe("8 files need a careful look: migration, lockfile, ci, environment file.");
    expect(riskyCheck([file("src/app.ts")]).state).toBe("pass");
    expect(riskyCheck(null).state).toBe("not_run");
  });

  test("a very large change warns", () => {
    expect(sizeCheck([file("a.ts", { additions: 20 })])).toMatchObject({
      state: "pass",
      summary: "1 file, +20 −1.",
    });
    expect(sizeCheck([file("a.ts", { additions: 1600 })]).state).toBe("warn");
    const many = Array.from({ length: 41 }, (_, i) => file(`f${i}.ts`, { additions: 1 }));
    expect(sizeCheck(many).reason).toBe("a very large change (41 files, 82 lines)");
  });
});

describe("the verdict", () => {
  test("the example line: two warnings", () => {
    const v = decideVerdict([
      c("tests", "stale", "tests were not run after the last change"),
      c("code", "not_run"),
      c("comments", "warn", "1 open comment"),
      c("risky", "pass"),
    ]);
    expect(v).toMatchObject({ verdict: "ready_with_warnings", warnings: 2, failures: 0 });
    expect(v.text).toBe("Ready with 2 warnings: tests were not run after the last change; 1 open comment.");
    expect(shortVerdict(v)).toBe("2 warnings");
  });

  test("any failure is not ready, failures named first, at most three reasons", () => {
    const v = decideVerdict([
      c("comments", "warn", "1 open comment"),
      c("tests", "fail", "2 of 12 tests failed"),
      c("page", "fail", "the page has 1 console error"),
      c("size", "warn", "a very large change (50 files, 3000 lines)"),
    ]);
    expect(v.verdict).toBe("not_ready");
    expect(v.reasons).toEqual(["2 of 12 tests failed", "the page has 1 console error", "1 open comment"]);
    expect(v.text).toBe("Not ready: 2 of 12 tests failed; the page has 1 console error; 1 open comment.");
    expect(shortVerdict(v)).toBe("Not ready");
  });

  test("ready when everything that ran passed", () => {
    const v = decideVerdict([
      c("tests", "pass", "tests passed after the last change"),
      c("code", "not_run"),
      c("comments", "pass"),
    ]);
    expect(v).toMatchObject({ verdict: "ready", warnings: 0 });
    expect(v.text).toBe("Ready: tests passed after the last change.");
    expect(shortVerdict(v)).toBe("Ready");
  });

  test("no tool checked the change: a warning, not a clean ready", () => {
    const v = decideVerdict([c("tests", "not_run"), c("code", "not_run"), c("comments", "pass")]);
    expect(v.text).toBe("Ready with 1 warning: no tests or checks ran on this change.");
    // Not counted twice when the tests already warn for not running.
    const expected = { ...c("tests", "not_run", "tests were not run"), expected: true };
    expect(decideVerdict([expected]).text).toBe("Ready with 1 warning: tests were not run.");
  });

  test("clock words and who ran it", () => {
    expect(when("2026-11-07T09:05:00", NOW)).toBe("at 09:05");
    expect(when("2026-11-05T14:32:00", NOW)).toBe("on 5 Nov at 14:32");
    expect(when("not a date", NOW)).toBe("");
    expect(whoRan("user")).toBe("you");
    expect(whoRan("engine")).toBe("Depo");
    expect(whoRan("coder@1.0.0")).toBe("the coding agent");
    expect(whoRan(agentTag("backend"))).toBe("Backend");
  });
});

// ---- with the engine -----------------------------------------------------------------------------

let callId = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `rd${++callId}`,
  name,
  arguments: args,
  rawArguments: JSON.stringify(args),
});

const SUM = "export const sum = (a: number, b: number): number => a + b;\n";
const SUM_TEST =
  'import { expect, test } from "bun:test";\nimport { sum } from "./sum";\n\ntest("adds", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n';
const AWS = `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`;

/** What the scripted coding agent does, by the words of the request. */
const SCRIPTS: { match: RegExp; steps: () => ToolCall[]; final: string }[] = [
  {
    match: /sum helper/,
    steps: () => [
      call("write_file", { path: "sum.ts", content: SUM }),
      call("write_file", { path: "sum.test.ts", content: SUM_TEST }),
      call("run_command", { command: "bun test" }),
    ],
    final: "Added sum() with a test. 1 pass.",
  },
  {
    match: /broken sum/,
    steps: () => [
      call("write_file", { path: "sum.ts", content: SUM.replace("a + b", "a - b") }),
      call("write_file", { path: "sum.test.ts", content: SUM_TEST }),
      call("run_command", { command: "bun test" }),
    ],
    final: "Done. All tests pass.",
  },
  {
    match: /landing page/,
    steps: () => [call("write_file", { path: "index.html", content: LANDING_HTML })],
    final: "Added a landing page in `index.html`.",
  },
  {
    match: /risky change/,
    steps: () => [
      call("write_file", { path: "db/migrations/001_users.sql", content: "create table users (id int);\n" }),
      call("write_file", { path: "package-lock.json", content: "{}\n" }),
      call("write_file", {
        path: "data/words.txt",
        content: Array.from({ length: 1600 }, (_, i) => `word ${i}`).join("\n"),
      }),
      call("delete_file", { path: "old.txt" }),
    ],
    final: "Done.",
  },
];

function scriptedCoder(requests: ChatRequest[]): ModelProvider {
  return {
    id: "fake",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:1",
    async health() {
      return { ok: true, version: "fake", message: null };
    },
    async listModels() {
      return [];
    },
    async embed(_m, inputs) {
      return inputs.map(() => [0]);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      requests.push(req);
      const first = req.messages.find((m) => m.role === "user")?.content ?? "";
      const script = req.tools?.length ? SCRIPTS.find((s) => s.match.test(first)) : undefined;
      const done = req.messages.filter((m) => m.role === "tool").length;
      const next = script?.steps()[done];
      if (next) {
        yield { type: "tool_call", call: next };
        yield { type: "done", finishReason: "tool_calls", usage: null };
        return;
      }
      yield { type: "text", delta: script?.final ?? "Done." };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
}

async function setup(o: { cdp?: boolean } = {}) {
  const t = tempDir("depo readiness");
  stops.push(t.cleanup);
  const cdp = o.cdp ? startFakeCdp({ title: "Welcome" }) : null;
  if (cdp) stops.push(cdp.stop);
  const requests: ChatRequest[] = [];
  const e = createEngine({
    dataRoot: path.join(t.dir, "data"),
    token: TEST_TOKEN,
    heartbeatMs: 60_000,
    tasks: { retryDelayMs: 10 },
    models: { providerFactory: () => scriptedCoder(requests) },
    ...(cdp
      ? { qa: { open: async () => sessionFor(await CdpConnection.connect(cdp.url)), hasBrowser: () => true } }
      : {}),
  });
  stops.push(() => e.stop("test"));
  const { port } = await e.start();
  e.models.setProviders([{ id: "fake", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }]);
  e.models.assign("coder", { providerId: "fake", model: "fake-model" });
  e.settings.set("memory.auto", false);
  e.settings.set("preview.auto_start", false);
  const proj = path.join(t.dir, "tiny app");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "README.md"), "# Tiny app\n");
  fs.writeFileSync(path.join(proj, "old.txt"), "old notes\n");
  const project = await e.projects.open(proj);
  const events: DepoEvent[] = [];
  e.bus.subscribe((ev) => events.push(ev));
  return { e, project, proj, port, events, requests };
}

/** Send a request and wait until its changes wait for review. */
async function toReview(e: Engine, projectId: string, text: string) {
  const task = e.tasks.send(projectId, text);
  await e.tasks.settled(task.id);
  expect(e.tasks.get(task.id).task.status).toBe("review");
  const cs = e.projects.listChangeSets(projectId).find((x) => x.taskId === task.id) as ChangeSet;
  const root = e.tasks.workspaceRoot(task.id) as string;
  expect(fs.existsSync(root)).toBe(true);
  return { task, cs, root };
}

const readinessDecisions = (events: DepoEvent[], taskId: string) =>
  events.filter((ev) => ev.type === "decision" && ev.taskId === taskId && ev.details?.kind === "readiness");

const byId = (r: ReadinessReport) => Object.fromEntries(r.checks.map((x) => [x.id, x]));

/** A readiness service on the engine's own parts, with a different diagnostics source or page source. */
function serviceOn(e: Engine, o: { diagnostics?: DiagnosticsSource; qa?: boolean } = {}) {
  return new ReadinessService({
    db: e.database.db,
    bus: e.bus,
    logger: e.logger,
    approvals: e.approvals,
    workspaceRoot: (id) => e.tasks.workspaceRoot(id),
    changeSet: (id) => e.projects.getChangeSet(id),
    comments: (id) => e.tasks.reviews.list(id),
    memory: (id) => e.memory.list(id),
    security: e.security,
    ...(o.qa ? { qa: e.qa } : {}),
    commandRules: () => null,
    ...(o.diagnostics ? { diagnostics: o.diagnostics } : {}),
  });
}

describe("the report from stored evidence", () => {
  test("a single task's readiness decision at review, then stale tests after an edit and an open comment", async () => {
    const { e, project, events } = await setup();
    const { task, cs, root } = await toReview(e, project.id, "add a sum helper with a test");
    const [decision, ...more] = readinessDecisions(events, task.id);
    expect(more).toEqual([]);
    expect(decision?.agent).toBe("engine");
    expect(decision?.text).toBe("Ready: tests passed after the last change.");
    expect(decision?.status).toBe("succeeded");
    expect(decision?.details?.outcome).toBe("ready");
    expect(decision?.details?.changeSetId).toBe(cs.id);
    expect(decision?.details?.reason).toContain("No model was asked.");
    // Recorded after the hand-off, so the timeline reads: ready for review, then how ready.
    const handoff = events.findIndex((ev) => ev.type === "handoff" && ev.taskId === task.id);
    expect(handoff).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(decision as DepoEvent)).toBeGreaterThan(handoff);

    let r = e.readiness.report(task.id);
    expect(ReadinessReportSchema.safeParse(r).success).toBe(true);
    expect(r.changeSetId).toBe(cs.id);
    const checks = byId(r);
    expect(checks.tests?.state).toBe("pass");
    expect(checks.tests?.evidence).toContain("Command: bun test");
    expect(checks.tests?.evidence.at(-1)).toMatch(/^Ran at \d\d:\d\d by the coding agent$/);
    // No package.json: the command is the one the agent used.
    expect(checks.tests?.action).toEqual({
      run: "tests",
      label: "Run again",
      detail: "bun test in the private copy",
      running: false,
    });
    expect(checks.code?.summary).toBe("Code checks are not available in this engine.");
    expect(checks.comments?.state).toBe("pass");
    expect(checks.plan).toBeUndefined();

    // An edit after the run: the tests are stale.
    await Bun.sleep(5);
    e.bus.emit({
      agent: "coder@1.0.0",
      projectId: project.id,
      taskId: task.id,
      type: "editing_file",
      text: "Edited sum.ts (1 change)",
      details: { path: "sum.ts", edits: 1 },
      status: "succeeded",
    });
    r = e.readiness.report(task.id);
    expect(byId(r).tests?.state).toBe("stale");
    expect(r.text).toBe("Ready with 1 warning: tests were not run after the last change.");

    // An open comment on the change set.
    e.tasks.reviews.add({
      changeSetId: cs.id,
      path: "sum.ts",
      start: { side: "new", line: 1 },
      body: "Name it add?",
    });
    r = e.readiness.report(task.id);
    expect(r.text).toBe("Ready with 2 warnings: tests were not run after the last change; 1 open comment.");
    expect(byId(r).comments?.items).toEqual([{ text: "sum.ts:1 Name it add?", ok: null }]);
    expect(fs.existsSync(path.join(root, "sum.ts"))).toBe(true);
  }, 60_000);

  test("files written after the last run (seen by their times) make the tests stale", async () => {
    const { e, project } = await setup();
    const { task, root } = await toReview(e, project.id, "add a sum helper with a test");
    expect(byId(e.readiness.report(task.id)).tests?.state).toBe("pass");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "sum.ts"), later, later);
    expect(byId(e.readiness.report(task.id)).tests?.state).toBe("stale");
  }, 60_000);

  test("failing tests: not ready, and the reviewer's brief says so", async () => {
    const { e, project, events } = await setup();
    const { task } = await toReview(e, project.id, "write a broken sum with a test");
    const decision = readinessDecisions(events, task.id).at(-1);
    expect(decision?.text).toBe("Not ready: 1 of 1 tests failed.");
    expect(decision?.status).toBe("failed");
    expect(decision?.details?.items).toEqual(["Tests: 1 of 1 tests failed."]);
    const brief = e.readiness.reviewBrief(task.id) ?? "";
    expect(brief).toContain("Readiness so far: Not ready: 1 of 1 tests failed.");
    expect(brief).toContain("- Tests: 1 of 1 tests failed.");
    expect(brief).toContain("Do not approve while a check fails");
  }, 60_000);

  test("risky files and a very large change", async () => {
    const { e, project, events } = await setup();
    const { task } = await toReview(e, project.id, "make a risky change");
    const r = e.readiness.report(task.id);
    const checks = byId(r);
    expect(checks.risky?.items.map((i) => i.text).sort()).toEqual([
      "db/migrations/001_users.sql (Migration)",
      "old.txt (Deleted)",
      "package-lock.json (Lockfile)",
    ]);
    expect(checks.size?.state).toBe("warn");
    expect(checks.size?.reason).toMatch(/^a very large change \(4 files, 16\d\d lines\)$/);
    expect(checks.size?.evidence[0]).toBe("3 new, 0 changed, 1 deleted");
    expect(r.verdict).toBe("ready_with_warnings");
    expect(r.reasons[0]).toMatch(/^3 risky files \((deleted|migration|lockfile)/);
    expect(readinessDecisions(events, task.id).at(-1)?.status).toBe("info");
  }, 60_000);

  test("page checks: the stored check in the copy, or its event when there is no copy to read", async () => {
    const { e, project } = await setup({ cdp: true });
    const { task, root } = await toReview(e, project.id, "make a landing page");
    let r = e.readiness.report(task.id);
    expect(r.text).toBe("Ready with 1 warning: no tests or checks ran on this change.");
    expect(byId(r).page?.action?.label).toBe("Check the page");
    expect(byId(r).ux?.summary).toBe("Screens changed, but there is no UX score for this change.");

    saveCheck(
      root,
      pageCheckOf(
        [
          view({
            consoleErrors: [{ kind: "console", text: "Failed to fetch /api/trips", source: null }],
            consoleErrorCount: 1,
          }),
        ],
        { projectId: project.id, taskId: task.id, by: "user", at: new Date(Date.now() + 5000).toISOString() },
      ),
    );
    r = e.readiness.report(task.id);
    expect(byId(r).page).toMatchObject({ state: "fail", summary: "The page has 1 console error." });
    expect(byId(r).page?.evidence).toContain("1 console error: Failed to fetch /api/trips");
    expect(byId(r).page?.action?.label).toBe("Check again");
    expect(r.text).toBe("Not ready: the page has 1 console error.");

    // Without the stored check, the check's own event still has the counts.
    e.bus.emit({
      agent: agentTag("frontend"),
      projectId: project.id,
      taskId: task.id,
      type: "rendering_screenshot",
      text: "Checked the page",
      details: {
        checkId: newId("qa"),
        url: "http://127.0.0.1:5173/",
        consoleErrors: 0,
        failedRequests: 0,
        a11y: { critical: 0, serious: 1 },
      },
      status: "failed",
    });
    const noStore = serviceOn(e).report(task.id);
    expect(byId(noStore).page).toMatchObject({ state: "warn", reason: "1 serious accessibility issue" });
    expect(byId(noStore).page?.evidence.at(-1)).toMatch(/by Frontend$/);
    expect(byId(noStore).page?.action).toBeNull();
  }, 60_000);

  test("security: this task's scan event, the project's score, and a UX score written during the task", async () => {
    const { e, project } = await setup();
    const { task } = await toReview(e, project.id, "make a landing page");
    expect(byId(e.readiness.report(task.id)).security?.state).toBe("not_run");

    // A score another task wrote: the project's, so this copy is still not scanned.
    const board = new Blackboard(e.database.db);
    board.write(
      project.id,
      "scores/security.json",
      JSON.stringify({
        overall: 88,
        grade: "B",
        blocksRelease: false,
        counts: { critical: 0, high: 0, medium: 2 },
        at: new Date().toISOString(),
        tools: ["semgrep"],
      }),
      agentTag("security"),
      "tsk_earlier",
    );
    let sec = byId(e.readiness.report(task.id)).security;
    expect(sec?.state).toBe("not_run");
    expect(sec?.summary).toContain("The project's last scan scored 88/100");

    await Bun.sleep(5);
    e.bus.emit({
      agent: agentTag("security"),
      projectId: project.id,
      taskId: task.id,
      type: "security_scan",
      text: "Security scan: 61/100",
      details: { score: 61, grade: "D", findings: 3, critical: 0, high: 1, tools: ["depo built-in rules"] },
      status: "succeeded",
    });
    sec = byId(e.readiness.report(task.id)).security;
    expect(sec).toMatchObject({ state: "fail", reason: "1 high or critical security finding" });
    expect(sec?.action?.label).toBe("Scan again");

    board.write(
      project.id,
      "scores/ux.json",
      JSON.stringify({
        overall: 74,
        grade: "C",
        blocksRelease: false,
        at: new Date(Date.now() + 5000).toISOString(),
      }),
      agentTag("ui-ux-design"),
      task.id,
    );
    expect(byId(e.readiness.report(task.id)).ux).toMatchObject({ state: "warn", reason: "UX score 74/100" });
  }, 60_000);

  test("team tasks: plan criteria met and unmet, and reviews of this plan only", async () => {
    const { e, project } = await setup();
    const { task } = await toReview(e, project.id, "add a sum helper with a test");
    const started = new Date().toISOString();
    // A review from an earlier plan of the same task does not count for this one.
    e.bus.emit({
      agent: agentTag("testing"),
      projectId: project.id,
      taskId: task.id,
      type: "decision",
      text: "QA approved",
      details: { kind: "review", nodeId: "api", outcome: "approved" },
      status: "succeeded",
    });
    await Bun.sleep(5);
    const plan = (apiStatus: string, reviews: boolean): Plan =>
      PlanSchema.parse({
        mode: "full",
        nodes: [
          {
            id: "api",
            title: "Add sum",
            owner: "backend",
            criteria: ["sum(1, 2) is 3", "A test covers it"],
            review: reviews,
            reviewer: "testing",
            status: apiStatus,
            startedAt: new Date(Date.parse(started) + 2).toISOString(),
          },
          {
            id: "docs",
            title: "Write docs",
            owner: "devops-docs",
            criteria: ["README mentions sum"],
            status: "done",
          },
        ],
      });
    const setPlan = (p: Plan) =>
      e.database.db
        .update(tasksTable)
        .set({ mode: "full", plan: JSON.stringify(p) })
        .where(eq(tasksTable.id, task.id))
        .run();

    setPlan(plan("review", true));
    let r = e.readiness.report(task.id);
    expect(byId(r).plan).toMatchObject({ state: "warn", reason: "2 of 3 plan criteria not met" });
    expect(byId(r).reviews).toMatchObject({ state: "warn", reason: "1 task not reviewed" });

    await Bun.sleep(5);
    e.bus.emit({
      agent: agentTag("testing"),
      projectId: project.id,
      taskId: task.id,
      type: "decision",
      text: "QA asks for changes",
      details: { kind: "review", nodeId: "api", outcome: "changes" },
      status: "failed",
    });
    r = e.readiness.report(task.id);
    expect(byId(r).reviews).toMatchObject({ state: "fail", reason: "a reviewer still asks for changes" });
    expect(r.text).toBe("Not ready: a reviewer still asks for changes; 2 of 3 plan criteria not met.");

    await Bun.sleep(5);
    for (const [kind, outcome] of [
      ["send_back", null],
      ["review", "approved"],
    ] as const)
      e.bus.emit({
        agent: kind === "review" ? agentTag("testing") : agentTag("manager"),
        projectId: project.id,
        taskId: task.id,
        type: "decision",
        text: kind,
        details: { kind, nodeId: "api", ...(outcome ? { outcome } : {}) },
        status: "info",
      });
    setPlan(plan("done", true));
    r = e.readiness.report(task.id);
    expect(byId(r).plan).toMatchObject({ state: "pass", summary: "All 3 acceptance criteria are met." });
    expect(byId(r).reviews?.items[0]?.text).toBe("Add sum: approved by Testing after 1 send-back");
    expect(r.verdict).toBe("ready");

    // The team's release line uses the live diff of the copy and the plan it is given.
    const line = e.readiness.releaseLine(task.id, plan("doing", false));
    expect(line?.verdict).toBe("ready_with_warnings");
    expect(line?.reasons).toContain("2 of 3 plan criteria not met");
  }, 60_000);

  test("the diagnostics source: present, absent, null, and broken", async () => {
    const { e, project } = await setup();
    const { task } = await toReview(e, project.id, "add a sum helper with a test");
    const asked: [string, string | null][] = [];
    const later = new Date(Date.now() + 5000).toISOString();
    const present = serviceOn(e, {
      diagnostics: {
        latest(projectId, taskId) {
          asked.push([projectId, taskId]);
          return { at: later, tools: ["tsc"], skipped: [], counts: { error: 2, warning: 0, info: 0 } };
        },
      },
    }).report(task.id);
    expect(asked).toEqual([[project.id, task.id]]);
    expect(byId(present).code).toMatchObject({ state: "fail", summary: "The code checks found 2 errors." });
    expect(present.text).toBe("Not ready: 2 code errors.");

    expect(byId(serviceOn(e).report(task.id)).code?.summary).toBe(
      "Code checks are not available in this engine.",
    );
    const none = serviceOn(e, { diagnostics: { latest: () => null } }).report(task.id);
    expect(byId(none).code?.summary).toBe("Code checks have not run on this change.");
    expect(none.verdict).toBe("ready");
    const broken = serviceOn(e, {
      diagnostics: {
        latest() {
          throw new Error("diagnostics crashed");
        },
      },
    }).report(task.id);
    expect(byId(broken).code?.state).toBe("not_run");
  }, 60_000);
});

describe("running checks from the report", () => {
  test("tests run the known command in the private copy, pass, then fail after a change", async () => {
    const { e, project, events } = await setup();
    const { task, root } = await toReview(e, project.id, "add a sum helper with a test");
    e.memory.upsertAuto(project.id, "fact", "Tests pass with: bun test", "auto:test-command");
    expect(byId(e.readiness.report(task.id)).tests?.evidence).toContain("Command: bun test");

    const passed = await e.readiness.run(task.id, "tests");
    expect(passed.ok).toBe(true);
    expect(passed.message).toBe("Tests passed: 1 pass, 0 fail.");
    expect(byId(passed.report).tests?.evidence.at(-1)).toMatch(/by you$/);
    const result = events.filter((ev) => ev.type === "test_result" && ev.taskId === task.id).at(-1);
    expect(result?.agent).toBe("user");
    expect(result?.details?.readiness).toBe(true);
    expect(result?.details?.command).toBe("bun test");
    expect(events.some((ev) => ev.type === "testing" && ev.details?.readiness === true)).toBe(true);

    fs.writeFileSync(path.join(root, "sum.ts"), SUM.replace("a + b", "a * b"));
    const failed = await e.readiness.run(task.id, "tests");
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe("Tests failed: 0 pass, 1 fail.");
    expect(byId(failed.report).tests).toMatchObject({ state: "fail", reason: "1 of 1 tests failed" });
    expect(failed.report.verdict).toBe("not_ready");
    // Nothing reached the real project.
    expect(fs.existsSync(path.join(project.rootPath, "sum.ts"))).toBe(false);
  }, 60_000);

  test("the command policy decides: a project deny rule refuses, a question can be declined", async () => {
    const { e, project } = await setup();
    const { task } = await toReview(e, project.id, "add a sum helper with a test");
    e.registry.setSettings(project.id, { commandDeny: ["bun test"] });
    await expect(e.readiness.run(task.id, "tests")).rejects.toThrow(
      'Depo will not run "bun test": blocked by this project\'s command rules.',
    );
    e.registry.setSettings(project.id, { commandDeny: [] });

    e.memory.upsertAuto(project.id, "fact", "Tests pass with: flutter test", "auto:test-command");
    const running = e.readiness.run(task.id, "tests");
    const req = await waitFor(() => e.approvals.list().find((a) => a.taskId === task.id));
    expect(req.title).toBe('Run "flutter test"?');
    expect(byId(e.readiness.report(task.id)).tests?.action?.running).toBe(true);
    e.approvals.respond(req.id, false);
    const res = await running;
    expect(res).toMatchObject({ ok: false, message: 'The tests did not run: "flutter test" was declined.' });
    expect(byId(res.report).tests?.action?.running).toBe(false);
  }, 60_000);

  test("the page check starts the copy when it is not running and opens it in the browser", async () => {
    const { e, project, events } = await setup({ cdp: true });
    const { task } = await toReview(e, project.id, "make a landing page");
    expect(e.previews.list().filter((p) => p.taskId === task.id)).toEqual([]);
    const res = await e.readiness.run(task.id, "page");
    const started = e.previews.list().find((p) => p.taskId === task.id);
    expect(started?.state).toBe("running");
    expect(started?.startedBy).toBe("user");
    // The fake browser's page has console errors and a failing API call.
    expect(res.ok).toBe(false);
    const page = byId(res.report).page;
    expect(page?.state).toBe("fail");
    expect(page?.summary).toMatch(/^The page has \d+ console errors? and \d+ failed requests?\.$/);
    expect(page?.evidence.at(-1)).toMatch(/by you$/);
    expect(res.report.verdict).toBe("not_ready");
    expect(events.some((ev) => ev.type === "rendering_screenshot" && ev.taskId === task.id)).toBe(true);
  }, 60_000);

  test("a scan of the private copy", async () => {
    const { e, project } = await setup();
    const { task, root } = await toReview(e, project.id, "make a landing page");
    const clean = await e.readiness.run(task.id, "security");
    expect(clean.ok).toBe(true);
    expect(byId(clean.report).security?.state).toBe("pass");
    // Not the project's report: a scan of the copy says nothing about the project folder.
    expect(e.security.lastReport(project.id)).toBeNull();

    fs.writeFileSync(path.join(root, "config.ts"), `export const key = "${AWS}";\n`);
    const bad = await e.readiness.run(task.id, "security");
    expect(bad.message).toMatch(/^Scanned the private copy: \d+\/100, \d+ high or critical findings?\.$/);
    expect(byId(bad.report).security?.state).toBe("fail");
  }, 60_000);
});

describe("over WebSocket", () => {
  function connect(port: number) {
    return new Promise<{ ws: WebSocket; call(method: string, params?: unknown): Promise<RpcResponse> }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${TEST_TOKEN}`);
        let n = 1;
        const pending = new Map<number, (r: RpcResponse) => void>();
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
        };
        ws.onerror = () => reject(new Error("socket error"));
        ws.onopen = () =>
          resolve({
            ws,
            call: (method, params) =>
              new Promise((res) => {
                const id = n++;
                pending.set(id, res);
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
              }),
          });
      },
    );
  }

  test("readiness.get and readiness.run answer with what their schemas promise", async () => {
    const { e, project, port } = await setup();
    const { task } = await toReview(e, project.id, "add a sum helper with a test");
    const c = await connect(port);
    stops.push(() => c.ws.close());
    const ok = async (method: keyof typeof ApiSchema, params: unknown) => {
      const res = await c.call(method, params);
      if ("error" in res) throw new Error(`${method}: ${res.error.message}`);
      const parsed = ApiSchema[method].result.safeParse(res.result);
      if (!parsed.success)
        throw new Error(`${method} broke its contract: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
      return parsed.data as Record<string, unknown>;
    };
    const fails = async (method: string, params: unknown, text: string) => {
      const res = await c.call(method, params);
      expect("error" in res && res.error.message).toContain(text);
    };
    const got = await ok("readiness.get", { taskId: task.id });
    expect((got.report as ReadinessReport).verdict).toBe("ready");
    const ran = await ok("readiness.run", { taskId: task.id, check: "tests" });
    expect(ran.ok).toBe(true);
    expect((ran.report as ReadinessReport).checks.find((x) => x.id === "tests")?.state).toBe("pass");
    await fails("readiness.get", { taskId: "tsk_missing" }, "Unknown task");
    await fails("readiness.run", { taskId: task.id, check: "lint" }, "Invalid");
  }, 60_000);
});

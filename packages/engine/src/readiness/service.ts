import fs from "node:fs";
import path from "node:path";
import {
  AGENT_IDS,
  type AgentId,
  type JsonValue,
  newId,
  type PageCheck,
  type Plan,
  PlanSchema,
  type PreviewDetection,
  type PreviewInfo,
  type ReadinessAction,
  type ReadinessCheck,
  type ReadinessReport,
  type ReadinessRunKind,
  type ReviewComment,
  type RunRecipe,
} from "@depo/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { venvEnv } from "../agent/prompt";
import { detectStack } from "../agent/stack";
import { clip, decisionDetails } from "../agents/decisions";
import { agentTag, manifestOf } from "../agents/manifests";
import type { ApprovalCenter } from "../approvals";
import type { AppDb } from "../db";
import { blackboard, changeSets, events, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ScanReport } from "../security/service";
import { matchesRule, summarizeTests } from "../tools/index";
import { classifyCommand } from "../tools/shell/policy";
import { runShell } from "../tools/shell/run";
import { computeChanges } from "../workspace/changes";
import type { Manifest } from "../workspace/snapshot";
import {
  codeCheck,
  commentsCheck,
  type DiagnosticsSource,
  decideVerdict,
  type FileLike,
  isAfter,
  type PageEvidence,
  pageCheck,
  pageEvidence,
  planCheck,
  type ReviewEvidence,
  reviewsCheck,
  riskyCheck,
  type ScoreEvidence,
  securityCheck,
  sizeCheck,
  type TestCommand,
  type TestRunEvidence,
  testsCheck,
  uiFiles,
  uxCheck,
  type Verdict,
} from "./checks";

/**
 * The readiness report: one honest answer to "is this ready to apply?" at review time. It reads
 * what Depo already stored (test runs, code checks, scans and scores, page checks, the plan, the
 * reviewers' verdicts, open comments, the diff) and never calls a model. Three checks can be run
 * on the owner's request in the task's private copy: the tests, a page check and a security scan.
 */

/** What the task manager and the team runner call (kept narrow so they stay testable apart). */
export interface ReadinessHooks {
  /** A task reached review with a change set: record the readiness decision once. */
  atReview(o: { projectId: string; taskId: string; changeSetId: string }): void;
  /** A short note for a reviewer: the verdict so far and the failing checks (null when unknown). */
  reviewBrief(taskId: string): string | null;
  /** The verdict for the team's release decision, from the live diff of the private copy. */
  releaseLine(taskId: string, plan: Plan): Verdict | null;
}

/** The running app of a task (narrow view of the preview manager). */
export interface ReadinessPreviews {
  list(projectId?: string): PreviewInfo[];
  settled(id: string): Promise<PreviewInfo | null>;
  detect(projectId: string, taskId?: string | null): Promise<PreviewDetection>;
  start(req: {
    projectId: string;
    taskId?: string | null;
    recipe?: RunRecipe;
    by?: string;
  }): Promise<{ preview: PreviewInfo; related: PreviewInfo[] }>;
}

export interface ReadinessServiceOptions {
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  approvals: Pick<ApprovalCenter, "request">;
  /** The private copy of a task, or null when it is gone. */
  workspaceRoot(taskId: string): string | null;
  /** Load a change set (throws when unknown). */
  changeSet(id: string): {
    id: string;
    status: string;
    files: (FileLike & { status: string })[];
  };
  /** Line comments of a change set (Diff Review). */
  comments(changeSetId: string): ReviewComment[];
  /** Memory facts of a project (the test command that passed before). */
  memory?: (projectId: string) => { signature: string | null; text: string }[];
  security: {
    scan(root: string, opts: { projectId?: string | null; signal?: AbortSignal }): Promise<ScanReport>;
    lastReport(projectId: string): ScanReport | null;
  };
  qa?: {
    list(projectId: string, taskId: string | null, limit?: number): PageCheck[];
    baseUrl(projectId: string, taskId: string | null): string | null;
    check(req: {
      projectId: string;
      taskId: string | null;
      by: string;
      signal?: AbortSignal;
    }): Promise<PageCheck>;
  };
  previews?: ReadinessPreviews;
  /** Starts a task's copy the way Depo does at review (null when not wired). */
  autoPreview?: {
    onReview(
      projectId: string,
      taskId: string,
    ): Promise<
      { started: true; previews: PreviewInfo[] } | { started: false; reason: string; detail?: string }
    >;
  };
  /** The project's own command rules (a deny rule wins, an allow rule skips the question). */
  commandRules(projectId: string): { allow: string[]; deny: string[] } | null;
  /** Compiler and linter findings, from the diagnostics service when there is one. */
  diagnostics?: DiagnosticsSource;
  /** How long a test run may take (default 10 minutes). */
  testTimeoutMs?: number;
  /** How long to wait for the app to start before a page check (default 2 minutes). */
  previewTimeoutMs?: number;
}

type TaskRow = typeof tasks.$inferSelect;

interface StoredEvent {
  ts: string;
  agent: string;
  type: string;
  status: string;
  details: Record<string, JsonValue> | null;
}

const EVIDENCE_TYPES = [
  "test_result",
  "testing",
  "writing_file",
  "editing_file",
  "security_scan",
  "rendering_screenshot",
  "decision",
];
const TEST_TIMEOUT_MS = 10 * 60_000;
const PREVIEW_TIMEOUT_MS = 120_000;
/** File times within this margin of a run count as written by the run itself (snapshots, caches). */
const MTIME_SLACK_MS = 2000;

const num = (v: JsonValue | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

/** "you", "Backend", "the coding agent". */
export function whoRan(tag: string): string {
  if (tag === "user") return "you";
  if (tag === "engine") return "Depo";
  const id = tag.split("@")[0] ?? "";
  if (id === "coder") return "the coding agent";
  if ((AGENT_IDS as readonly string[]).includes(id)) return manifestOf(id as AgentId).name;
  return id || "an agent";
}

function agentLabel(id: string): string {
  return (AGENT_IDS as readonly string[]).includes(id) ? manifestOf(id as AgentId).name : id;
}

export class ReadinessService implements ReadinessHooks {
  private readonly log: Logger;
  private readonly inflight = new Map<string, Promise<{ message: string; ok: boolean }>>();
  private readonly closing = new AbortController();

  constructor(private readonly o: ReadinessServiceOptions) {
    this.log = o.logger.child({ component: "readiness" });
  }

  // ---- reading ---------------------------------------------------------------------------------

  private task(taskId: string): TaskRow {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    return row;
  }

  /** The task's newest change set, preferring one that still waits for review. */
  private latestChangeSet(taskId: string) {
    const rows = this.o.db
      .select({ id: changeSets.id, status: changeSets.status })
      .from(changeSets)
      .where(eq(changeSets.taskId, taskId))
      .orderBy(desc(changeSets.createdAt))
      .limit(5)
      .all();
    const pick = rows.find((r) => r.status === "pending" || r.status === "partially_applied") ?? rows[0];
    if (!pick) return null;
    try {
      return this.o.changeSet(pick.id);
    } catch {
      return null;
    }
  }

  /** The task's evidence events, newest first. */
  private taskEvents(projectId: string, taskId: string): StoredEvent[] {
    return this.o.db
      .select({
        ts: events.ts,
        agent: events.agent,
        type: events.type,
        status: events.status,
        details: events.details,
      })
      .from(events)
      .where(
        and(eq(events.projectId, projectId), eq(events.taskId, taskId), inArray(events.type, EVIDENCE_TYPES)),
      )
      .orderBy(desc(sql`rowid`))
      .limit(1500)
      .all()
      .map((r) => {
        let details: Record<string, JsonValue> | null = null;
        try {
          const parsed: unknown = r.details ? JSON.parse(r.details) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            details = parsed as Record<string, JsonValue>;
        } catch {
          // A damaged details column says nothing.
        }
        return { ...r, details };
      });
  }

  /** The command of the project's newest test run outside this task (what agents used before). */
  private projectTestCommand(projectId: string): string | null {
    const row = this.o.db
      .select({ details: events.details })
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.type, "test_result")))
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
    try {
      const d = row?.details ? (JSON.parse(row.details) as { command?: unknown }) : null;
      return typeof d?.command === "string" ? d.command : null;
    } catch {
      return null;
    }
  }

  /** The project's known test command: from memory, the project files, or the agents' last run. */
  testCommand(
    projectId: string,
    taskId: string,
    root: string | null,
    evs?: StoredEvent[],
  ): TestCommand | null {
    const ok = (c: string | null | undefined): c is string =>
      !!c && c.trim().length > 0 && c.length <= 300 && !/[\r\n]/.test(c);
    const fact = this.o.memory?.(projectId).find((f) => f.signature === "auto:test-command");
    const remembered = fact?.text.replace(/^Tests pass with:\s*/i, "").trim();
    if (ok(remembered)) return { command: remembered, source: "memory" };
    const base = root ?? this.projectRoot(projectId);
    if (base) {
      try {
        const detected = detectStack(base).testCommand;
        if (ok(detected)) return { command: detected, source: "stack" };
      } catch {
        // An unreadable folder detects nothing.
      }
    }
    const fromTask = (evs ?? this.taskEvents(projectId, taskId)).find((e) => e.type === "test_result")
      ?.details?.command;
    const used = typeof fromTask === "string" ? fromTask : this.projectTestCommand(projectId);
    return ok(used) ? { command: used, source: "agents" } : null;
  }

  private projectRoot(projectId: string): string | null {
    return (
      this.o.db.select({ root: projects.rootPath }).from(projects).where(eq(projects.id, projectId)).get()
        ?.root ?? null
    );
  }

  private section(projectId: string, name: string) {
    return (
      this.o.db
        .select({ content: blackboard.content, taskId: blackboard.taskId, updatedAt: blackboard.updatedAt })
        .from(blackboard)
        .where(and(eq(blackboard.projectId, projectId), eq(blackboard.section, name)))
        .get() ?? null
    );
  }

  /** A score file on the blackboard (scores/security.json, scores/ux.json). */
  private boardScore(projectId: string, taskId: string, name: string): ScoreEvidence | null {
    const e = this.section(projectId, name);
    if (!e) return null;
    try {
      const j = JSON.parse(e.content) as {
        overall?: unknown;
        grade?: unknown;
        blocksRelease?: unknown;
        at?: unknown;
        counts?: { critical?: unknown; high?: unknown };
        tools?: unknown;
      };
      if (typeof j.overall !== "number") return null;
      const counts = j.counts && typeof j.counts === "object" ? j.counts : null;
      const total =
        counts && typeof counts === "object"
          ? Object.values(counts).reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0)
          : null;
      return {
        at: typeof j.at === "string" ? j.at : e.updatedAt,
        score: j.overall,
        grade: typeof j.grade === "string" ? j.grade : null,
        blocks: j.blocksRelease === true,
        critical: typeof counts?.critical === "number" ? counts.critical : null,
        high: typeof counts?.high === "number" ? counts.high : null,
        findings: total,
        scope: e.taskId === taskId ? "copy" : "project",
        tools: Array.isArray(j.tools) ? j.tools.filter((t): t is string => typeof t === "string") : [],
      };
    } catch {
      return null;
    }
  }

  private securityEvidence(projectId: string, taskId: string, evs: StoredEvent[]) {
    const ev = evs.find(
      (e) => e.type === "security_scan" && e.status !== "started" && num(e.details?.score) !== null,
    );
    const fromEvent: ScoreEvidence | null = ev
      ? {
          at: ev.ts,
          score: num(ev.details?.score) ?? 0,
          grade: str(ev.details?.grade),
          blocks: ev.status === "failed",
          critical: num(ev.details?.critical),
          high: num(ev.details?.high),
          findings: num(ev.details?.findings),
          scope: "copy",
          tools: Array.isArray(ev.details?.tools)
            ? ev.details.tools.filter((t): t is string => typeof t === "string")
            : [],
        }
      : null;
    const board = this.boardScore(projectId, taskId, "scores/security.json");
    let copy = fromEvent;
    if (board?.scope === "copy") {
      // An agent's scan writes both; the score file has the counts.
      const sameScan = fromEvent && Math.abs(Date.parse(board.at) - Date.parse(fromEvent.at)) < 10_000;
      if (!copy || sameScan || isAfter(board.at, copy.at)) copy = board;
    }
    let project = board?.scope === "project" ? board : null;
    const last = this.o.security.lastReport(projectId);
    if (last && (!project || isAfter(last.at, project.at)) && (!copy || isAfter(last.at, copy.at))) {
      // The project's in-memory report can come from any scan of the project (or an agent's copy).
      project = {
        at: last.at,
        score: last.score.overall,
        grade: last.score.grade,
        blocks: last.score.blocksRelease,
        critical: last.score.counts.critical,
        high: last.score.counts.high,
        findings: last.findings.length,
        scope: "project",
        tools: last.ran.map((r) => r.tool),
      };
    }
    return { copy, project };
  }

  private pageEvidenceFor(projectId: string, taskId: string, evs: StoredEvent[]): PageEvidence | null {
    let stored: PageCheck | undefined;
    try {
      stored = this.o.qa?.list(projectId, taskId, 1)[0];
    } catch {
      stored = undefined;
    }
    if (stored) return pageEvidence(stored, whoRan(stored.by));
    // The copy is gone: the check's event still has the counts.
    const ev = evs.find(
      (e) =>
        e.type === "rendering_screenshot" && e.status !== "started" && typeof e.details?.checkId === "string",
    );
    if (!ev?.details) return null;
    const a11y = ev.details.a11y;
    const counts = a11y && typeof a11y === "object" && !Array.isArray(a11y) ? a11y : {};
    return {
      at: ev.ts,
      url: str(ev.details.url) ?? "",
      widths: [],
      loaded: true,
      consoleErrors: num(ev.details.consoleErrors) ?? 0,
      firstConsoleError: null,
      serverFailures: num(ev.details.failedRequests) ?? 0,
      clientFailures: 0,
      blocked: 0,
      firstFailure: null,
      critical: num(counts.critical) ?? 0,
      serious: num(counts.serious) ?? 0,
      by: whoRan(ev.agent),
    };
  }

  private latestTestRun(evs: StoredEvent[]): TestRunEvidence | null {
    const ev = evs.find(
      (e) => e.type === "test_result" && e.details?.cancelled !== true && e.status !== "cancelled",
    );
    if (!ev) return null;
    return {
      at: ev.ts,
      command: str(ev.details?.command),
      ok: ev.status === "succeeded",
      passed: num(ev.details?.passed),
      failed: num(ev.details?.failed),
      exitCode: num(ev.details?.exitCode),
      timedOut: ev.details?.timedOut === true,
      by: whoRan(ev.agent),
    };
  }

  /** The newest time a file of the change was written (edits, or files written by commands). */
  private changeClock(root: string | null, files: FileLike[] | null, evs: StoredEvent[]) {
    const lastEdit =
      evs.find((e) => (e.type === "writing_file" || e.type === "editing_file") && e.status === "succeeded")
        ?.ts ?? null;
    let mtime: number | null = null;
    if (root && files) {
      for (const f of files.slice(0, 400)) {
        if (f.kind === "deleted") continue;
        try {
          const t = fs.statSync(path.join(root, f.path)).mtimeMs;
          if (mtime === null || t > mtime) mtime = t;
        } catch {
          // A file that is gone has no time.
        }
      }
    }
    return (at: string) => {
      if (isAfter(lastEdit, at)) return true;
      const t = Date.parse(at);
      return mtime !== null && !Number.isNaN(t) && mtime > t + MTIME_SLACK_MS;
    };
  }

  private actions(
    row: TaskRow,
    root: string | null,
    command: TestCommand | null,
    ran: Set<ReadinessRunKind>,
  ) {
    const running = (k: ReadinessRunKind) => this.inflight.has(`${row.id}:${k}`);
    const act = (run: ReadinessRunKind, label: string, detail: string): ReadinessAction => ({
      run,
      label,
      detail,
      running: running(run),
    });
    if (!root) return { tests: null, page: null, security: null };
    const app = this.o.qa?.baseUrl(row.projectId, row.id) ?? null;
    return {
      tests: command
        ? act("tests", ran.has("tests") ? "Run again" : "Run tests", `${command.command} in the private copy`)
        : null,
      page: this.o.qa
        ? act(
            "page",
            ran.has("page") ? "Check again" : "Check the page",
            app
              ? "Opens the running copy in a headless browser at phone, tablet and desktop widths"
              : "Starts the private copy, then opens it in a headless browser",
          )
        : null,
      security: act(
        "security",
        ran.has("security") ? "Scan again" : "Scan",
        "Scans the private copy for secrets, risky code and known vulnerable packages",
      ),
    };
  }

  /**
   * Build the report. `files` defaults to the task's latest change set; `only` limits the checks
   * (the reviewer's brief uses the tool checks only).
   */
  private build(
    row: TaskRow,
    o: { files?: FileLike[] | null; changeSetId?: string | null; plan?: Plan | null; only?: string[] } = {},
  ): ReadinessReport {
    const now = new Date();
    const projectId = row.projectId;
    const taskId = row.id;
    let files: FileLike[] | null;
    let changeSetId: string | null;
    if (o.files !== undefined) {
      files = o.files;
      changeSetId = o.changeSetId ?? null;
    } else {
      const cs = this.latestChangeSet(taskId);
      files = cs ? cs.files : null;
      changeSetId = cs?.id ?? null;
    }
    const root = this.o.workspaceRoot(taskId);
    const evs = this.taskEvents(projectId, taskId);
    const changedAfter = this.changeClock(root, files, evs);
    const want = (id: string) => !o.only || o.only.includes(id);
    const command = this.testCommand(projectId, taskId, root, evs);
    const run = this.latestTestRun(evs);
    const sec = this.securityEvidence(projectId, taskId, evs);
    const page = this.pageEvidenceFor(projectId, taskId, evs);
    const ran = new Set<ReadinessRunKind>([
      ...(run ? (["tests"] as const) : []),
      ...(page ? (["page"] as const) : []),
      ...(sec.copy ? (["security"] as const) : []),
    ]);
    const act = this.actions(row, root, command, ran);
    const ui = files ? uiFiles(files) : [];
    let diagnostics = null;
    try {
      diagnostics = this.o.diagnostics?.latest(projectId, taskId) ?? null;
    } catch (err) {
      this.log.warn("diagnostics source failed", { taskId, err });
    }
    const checks: ReadinessCheck[] = [];
    if (want("tests")) checks.push(testsCheck({ run, changedAfter, command, action: act.tests, now }));
    if (want("code"))
      checks.push(codeCheck({ available: !!this.o.diagnostics, result: diagnostics, changedAfter, now }));
    if (want("security"))
      checks.push(
        securityCheck({ copy: sec.copy, project: sec.project, changedAfter, action: act.security, now }),
      );
    if (want("ux"))
      checks.push(
        uxCheck({ ui, score: this.boardScore(projectId, taskId, "scores/ux.json"), changedAfter, now }),
      );
    if (want("page")) checks.push(pageCheck({ page, ui, changedAfter, action: act.page, now }));
    const plan = o.plan !== undefined ? o.plan : this.plan(row);
    if (row.mode !== "single" && plan) {
      const reviews = this.reviewEvidence(evs);
      if (want("plan")) checks.push(planCheck(plan, agentLabel));
      if (want("reviews")) checks.push(reviewsCheck(plan, reviews, agentLabel));
    }
    if (want("comments")) {
      let open: ReviewComment[] | null = null;
      if (changeSetId) {
        try {
          open = this.o
            .comments(changeSetId)
            .filter((c) => c.changeSetId === changeSetId && c.status === "open");
        } catch {
          open = [];
        }
      } else if (files) open = [];
      checks.push(commentsCheck(open));
    }
    if (want("risky")) checks.push(riskyCheck(files));
    if (want("size")) checks.push(sizeCheck(files));
    const v = decideVerdict(checks);
    return {
      taskId,
      projectId,
      changeSetId,
      at: now.toISOString(),
      verdict: v.verdict,
      headline: v.headline,
      reasons: v.reasons,
      text: v.text,
      failures: v.failures,
      warnings: v.warnings,
      checks,
    };
  }

  private plan(row: TaskRow): Plan | null {
    if (!row.plan) return null;
    try {
      const p = PlanSchema.safeParse(JSON.parse(row.plan));
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  }

  private reviewEvidence(evs: StoredEvent[]): ReviewEvidence[] {
    const out: ReviewEvidence[] = [];
    for (const e of evs) {
      if (e.type !== "decision") continue;
      const kind = e.details?.kind;
      if (kind !== "review" && kind !== "send_back" && kind !== "escalate") continue;
      out.push({
        ts: e.ts,
        kind,
        nodeId: str(e.details?.nodeId),
        outcome: str(e.details?.outcome),
        text: "",
      });
    }
    return out.reverse();
  }

  /** The report for the task's latest change set. */
  report(taskId: string): ReadinessReport {
    return this.build(this.task(taskId));
  }

  // ---- hooks for the task manager and the team ---------------------------------------------------

  atReview(o: { projectId: string; taskId: string; changeSetId: string }): void {
    try {
      const row = this.task(o.taskId);
      const cs = this.o.changeSet(o.changeSetId);
      const report = this.build(row, { files: cs.files, changeSetId: cs.id });
      const items = report.checks
        .filter(
          (c) =>
            c.state === "fail" ||
            c.state === "warn" ||
            c.state === "stale" ||
            (c.state === "not_run" && c.expected),
        )
        .map((c) => `${c.label}: ${c.summary}`)
        .slice(0, 8);
      this.o.bus.emit({
        agent: row.mode === "single" ? "engine" : agentTag("manager"),
        projectId: o.projectId,
        taskId: o.taskId,
        type: "decision",
        text: report.text,
        details: decisionDetails("readiness", {
          outcome: report.verdict,
          reason:
            "Built from the stored test runs, checks, scores, page checks, reviews and comments of this task. No model was asked.",
          items,
          changeSetId: cs.id,
          failures: report.failures,
          warnings: report.warnings,
          checks: report.checks.map((c) => `${c.id}:${c.state}`),
        }),
        status: report.verdict === "ready" ? "succeeded" : report.verdict === "not_ready" ? "failed" : "info",
      });
    } catch (err) {
      // Readiness never stops a task from reaching review.
      this.log.warn("readiness at review failed", { taskId: o.taskId, err });
    }
  }

  reviewBrief(taskId: string): string | null {
    try {
      const row = this.task(taskId);
      const r = this.build(row, { files: null, only: ["tests", "code", "security", "page"] });
      const bad = r.checks.filter((c) => c.state === "fail" || c.state === "stale");
      const lines = [`Readiness so far: ${r.text}`];
      for (const c of bad.slice(0, 3)) lines.push(`- ${c.label}: ${c.summary}`);
      if (r.checks.some((c) => c.state === "fail"))
        lines.push(
          "Do not approve while a check fails, unless the failure is clearly outside this task; then say so in a finding.",
        );
      return clip(lines.join("\n"), 900);
    } catch (err) {
      this.log.warn("readiness brief failed", { taskId, err });
      return null;
    }
  }

  releaseLine(taskId: string, plan: Plan): Verdict | null {
    try {
      const row = this.task(taskId);
      let files: FileLike[] | null = null;
      const root = this.projectRoot(row.projectId);
      if (row.workspacePath && root) {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(row.workspacePath, "manifest.json"), "utf8"),
        ) as Manifest;
        files = computeChanges(root, path.join(row.workspacePath, "tree"), manifest);
      }
      return decideVerdict(this.build(row, { files, changeSetId: null, plan }).checks);
    } catch (err) {
      this.log.warn("readiness for the release failed", { taskId, err });
      return null;
    }
  }

  // ---- running checks on request -------------------------------------------------------------

  /** Run one check now in the task's private copy and return the updated report. */
  async run(
    taskId: string,
    kind: ReadinessRunKind,
  ): Promise<{ report: ReadinessReport; message: string; ok: boolean }> {
    if (this.closing.signal.aborted) throw new Error("Depo is closing.");
    const row = this.task(taskId);
    const key = `${taskId}:${kind}`;
    let p = this.inflight.get(key);
    if (!p) {
      const started =
        kind === "tests" ? this.runTests(row) : kind === "page" ? this.runPage(row) : this.runSecurity(row);
      p = started.finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const res = await p;
    return { ...res, report: this.build(this.task(taskId)) };
  }

  /** Engine shutdown: stop runs under way. */
  async close(): Promise<void> {
    this.closing.abort();
    await Promise.allSettled([...this.inflight.values()]);
  }

  private needCopy(row: TaskRow): string {
    const root = this.o.workspaceRoot(row.id);
    if (!root) throw new Error("This task's private copy no longer exists, so there is nothing to check.");
    return root;
  }

  private emit(row: TaskRow, e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) {
    return this.o.bus.emit({ ...e, agent: "user", projectId: row.projectId, taskId: row.id });
  }

  private async runTests(row: TaskRow): Promise<{ message: string; ok: boolean }> {
    const root = this.needCopy(row);
    const cmd = this.testCommand(row.projectId, row.id, root);
    if (!cmd)
      throw new Error(
        "Depo does not know how to run this project's tests yet. Ask the agent to add a test script, then try again.",
      );
    let verdict = classifyCommand(cmd.command, root);
    const rules = this.o.commandRules(row.projectId);
    if (rules?.deny.some((r) => matchesRule(cmd.command, r)))
      verdict = { ...verdict, decision: "deny", reason: "blocked by this project's command rules" };
    else if (verdict.decision === "ask" && rules?.allow.some((r) => matchesRule(cmd.command, r)))
      verdict = { ...verdict, decision: "allow", reason: "allowed by this project's command rules" };
    if (verdict.decision === "deny")
      throw new Error(`Depo will not run "${cmd.command}": ${verdict.reason}.`);
    if (verdict.decision === "ask") {
      const ok = await this.o.approvals.request(
        {
          projectId: row.projectId,
          taskId: row.id,
          agent: "engine",
          kind: "command",
          title: `Run "${cmd.command}"?`,
          reason: `${verdict.reason}. It runs in the task's private copy, not in your project.`,
          details: { command: cmd.command, category: verdict.category },
        },
        this.closing.signal,
      );
      if (!ok) return { ok: false, message: `The tests did not run: "${cmd.command}" was declined.` };
    }
    const jobId = newId("job");
    this.emit(row, {
      type: "testing",
      text: `Running tests: ${cmd.command}`,
      details: { command: cmd.command, category: "test", jobId, readiness: true },
      status: "started",
    });
    const timeoutMs = this.o.testTimeoutMs ?? TEST_TIMEOUT_MS;
    const res = await runShell({
      command: cmd.command,
      cwd: root,
      timeoutMs,
      signal: this.closing.signal,
      memoryLimitBytes: 8 * 1024 ** 3,
      env: venvEnv(root),
    });
    const summary = summarizeTests(res.output);
    const ok = res.exitCode === 0 && !res.timedOut && !res.cancelled;
    this.log[ok || res.cancelled ? "info" : "warn"]("readiness test run", {
      taskId: row.id,
      projectId: row.projectId,
      command: cmd.command,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
    });
    this.emit(row, {
      type: "test_result",
      text: summary
        ? `Tests: ${summary.text}`
        : ok
          ? "Tests passed"
          : res.cancelled
            ? "Tests stopped"
            : "Tests failed",
      details: {
        command: cmd.command,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        containment: res.containment,
        jobId,
        outputTail: res.output.slice(-4000),
        readiness: true,
        ...(summary ? { passed: summary.passed, failed: summary.failed } : {}),
      },
      durationMs: res.durationMs,
      status: ok ? "succeeded" : res.cancelled ? "cancelled" : "failed",
    });
    if (res.cancelled) return { ok: false, message: "The test run was stopped." };
    if (res.timedOut)
      return {
        ok: false,
        message: `The tests did not finish within ${Math.round(timeoutMs / 60_000) || 1} minutes.`,
      };
    if (ok) return { ok, message: `Tests passed${summary ? `: ${summary.text}` : ""}.` };
    return {
      ok,
      message: `Tests failed${summary ? `: ${summary.text}` : ` with exit code ${res.exitCode ?? "unknown"}`}.`,
    };
  }

  /** Wait until the previews are running (or failed), at most the preview timeout. */
  private async settle(list: PreviewInfo[]): Promise<void> {
    const previews = this.o.previews;
    if (!previews) return;
    const limit = this.o.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limit);
    });
    try {
      await Promise.race([Promise.all(list.map((p) => previews.settled(p.id))), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start the task's copy like Depo does at review; the owner asked, so the auto-start setting does not apply. */
  private async startApp(row: TaskRow): Promise<void> {
    const previews = this.o.previews;
    if (!previews) throw new Error("Previews are not available in this engine.");
    const live = previews
      .list(row.projectId)
      .filter((p) => p.taskId === row.id && (p.state === "running" || p.state === "starting"));
    if (live.length) return this.settle(live);
    const auto = await this.o.autoPreview?.onReview(row.projectId, row.id);
    if (auto?.started) return this.settle(auto.previews);
    const reason = auto && !auto.started ? auto.reason : "disabled";
    if (reason === "running") {
      return this.settle(previews.list(row.projectId).filter((p) => p.taskId === row.id));
    }
    if (reason === "no_recipe")
      throw new Error(
        "Depo does not know how to start this app. Start it in the Preview tab, then check the page.",
      );
    if (reason === "needs_install")
      throw new Error(
        "The app needs its packages installed first. Start it once from the Preview tab, then check the page.",
      );
    if (reason === "failed")
      throw new Error(
        `The app could not start${auto && !auto.started && auto.detail ? `: ${auto.detail}` : "."}`,
      );
    // Auto start is turned off (or not wired): start it the same careful way, as the owner's own preview.
    const d = await previews.detect(row.projectId, row.id);
    const recipe = d.recipes[d.suggested];
    if (!recipe)
      throw new Error(
        "Depo does not know how to start this app. Start it in the Preview tab, then check the page.",
      );
    const parts = recipe.kind === "both" ? (recipe.parts ?? []) : [recipe];
    if (recipe.missing || parts.some((p) => p.missing))
      throw new Error(
        "The app needs its packages installed first. Start it once from the Preview tab, then check the page.",
      );
    const res = await previews.start({ projectId: row.projectId, taskId: row.id, recipe, by: "user" });
    await this.settle([...res.related, res.preview]);
  }

  private async runPage(row: TaskRow): Promise<{ message: string; ok: boolean }> {
    const qa = this.o.qa;
    if (!qa) throw new Error("Page checks are not available in this engine.");
    this.needCopy(row);
    if (!qa.baseUrl(row.projectId, row.id)) await this.startApp(row);
    if (!qa.baseUrl(row.projectId, row.id))
      throw new Error("The app did not start in time. Open the Preview tab to see why.");
    const c = await qa.check({
      projectId: row.projectId,
      taskId: row.id,
      by: "user",
      signal: this.closing.signal,
    });
    return { ok: c.ok, message: c.ok ? "The page check found no problems." : clip(c.summary, 600) };
  }

  private async runSecurity(row: TaskRow): Promise<{ message: string; ok: boolean }> {
    const root = this.needCopy(row);
    this.emit(row, {
      type: "security_scan",
      text: "Scanning the task's private copy",
      details: { scope: "copy", readiness: true },
      status: "started",
    });
    // projectId null: a scan of the copy must not stand in for the project's own report.
    const r = await this.o.security.scan(root, { projectId: null, signal: this.closing.signal });
    const c = r.score.counts;
    this.emit(row, {
      type: "security_scan",
      text: `Security scan of the private copy: ${r.score.overall}/100, ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`,
      details: {
        score: r.score.overall,
        grade: r.score.grade,
        findings: r.findings.length,
        critical: c.critical,
        high: c.high,
        medium: c.medium,
        low: c.low,
        tools: r.ran.map((x) => x.tool),
        scope: "copy",
        readiness: true,
      },
      status: r.score.blocksRelease ? "failed" : "succeeded",
    });
    const serious = c.critical + c.high;
    return {
      ok: !r.score.blocksRelease,
      message: `Scanned the private copy: ${r.score.overall}/100${serious ? `, ${serious} high or critical finding${serious === 1 ? "" : "s"}` : ", nothing high or critical"}.`,
    };
  }
}

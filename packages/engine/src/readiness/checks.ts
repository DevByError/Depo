import type {
  PageCheck,
  Plan,
  ReadinessAction,
  ReadinessCheck,
  ReadinessCheckId,
  ReadinessItem,
  ReadinessState,
  ReadinessVerdict,
  ReviewComment,
} from "@depo/shared";
import { clip, plainText } from "../agents/decisions";

/**
 * The readiness checks as pure functions of stored evidence, and the verdict rules. Nothing here
 * reads files or the database, so every state can be tested with plain objects.
 */

export const CHECK_LABEL: Record<ReadinessCheckId, string> = {
  tests: "Tests",
  code: "Code checks",
  security: "Security",
  ux: "UX",
  page: "Page check",
  plan: "Plan criteria",
  reviews: "Reviews",
  comments: "Open comments",
  risky: "Risky changes",
  size: "Size",
};

/** A file of the change set (or of the live diff before one exists). */
export interface FileLike {
  path: string;
  kind: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
  conflict?: boolean;
}

/** The newest test run of the task (a `test_result` event). */
export interface TestRunEvidence {
  at: string;
  command: string | null;
  ok: boolean;
  passed: number | null;
  failed: number | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Who ran it: "you", "Backend", "the coding agent". */
  by: string;
}

export interface TestCommand {
  command: string;
  source: "memory" | "stack" | "agents";
}

/** What the diagnostics service (compilers, linters) found; another part of Depo provides it. */
export interface DiagnosticsResult {
  at: string;
  tools: string[];
  skipped: string[];
  counts: { error: number; warning: number; info: number };
}

/** The optional diagnostics source. A missing source or a null result means "not run". */
export interface DiagnosticsSource {
  latest(projectId: string, taskId: string | null): DiagnosticsResult | null;
}

/** A security scan or a UX audit score. */
export interface ScoreEvidence {
  at: string;
  score: number;
  grade: string | null;
  blocks: boolean;
  critical: number | null;
  high: number | null;
  findings: number | null;
  /** copy: this task's private copy (or a score written during this task); project: anything else. */
  scope: "copy" | "project";
  tools: string[];
}

/** A page check, from the stored check or (when the copy is gone) its event. */
export interface PageEvidence {
  at: string;
  url: string;
  widths: string[];
  loaded: boolean;
  consoleErrors: number;
  firstConsoleError: string | null;
  /** 5xx answers and requests that got no answer. */
  serverFailures: number;
  /** 4xx answers (a missing image, a wrong path). */
  clientFailures: number;
  /** Requests to the internet that Depo blocked (apps must work offline). */
  blocked: number;
  firstFailure: string | null;
  critical: number;
  serious: number;
  by: string;
}

/** A reviewer's verdict or the Manager's send-back / escalation for a plan node. */
export interface ReviewEvidence {
  ts: string;
  kind: "review" | "send_back" | "escalate";
  nodeId: string | null;
  outcome: string | null;
  text: string;
}

/** Clock time for evidence lines: "at 14:32", or "on 5 Nov at 14:32" for another day. */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `at ${hm}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `on ${d.getDate()} ${months[d.getMonth()]} at ${hm}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Is `later` after `at`? Missing values are never later. */
export function isAfter(later: string | null, at: string): boolean {
  if (!later) return false;
  const a = Date.parse(later);
  const b = Date.parse(at);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
}

function check(
  id: ReadinessCheckId,
  state: ReadinessState,
  summary: string,
  o: {
    evidence?: (string | null | false | undefined)[];
    items?: ReadinessItem[];
    expected?: boolean;
    reason?: string | null;
    action?: ReadinessAction | null;
  } = {},
): ReadinessCheck {
  return {
    id,
    label: CHECK_LABEL[id],
    state,
    summary: clip(summary, 400),
    evidence: (o.evidence ?? [])
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => clip(e, 300))
      .slice(0, 8),
    items: (o.items ?? []).slice(0, 40).map((i) => ({ text: clip(i.text, 400), ok: i.ok })),
    expected: o.expected ?? false,
    reason: o.reason ? clip(o.reason, 200) : null,
    action: o.action ?? null,
  };
}

// ---- Tests ---------------------------------------------------------------------------------

export function testsCheck(o: {
  run: TestRunEvidence | null;
  /** When files of the change last changed (edits, or files written by commands). */
  changedAfter(at: string): boolean;
  command: TestCommand | null;
  action: ReadinessAction | null;
  now?: Date;
}): ReadinessCheck {
  const { run, command, action } = o;
  const source = command
    ? `Test command: ${command.command} (${command.source === "memory" ? "from memory" : command.source === "stack" ? "read from the project files" : "the one the agents used"})`
    : null;
  if (!run) {
    if (command)
      return check("tests", "not_run", "No tests ran for this change.", {
        evidence: [source],
        expected: true,
        reason: "tests were not run",
        action,
      });
    return check("tests", "not_run", "No test command is known for this project, and no tests ran.", {
      evidence: ["Add tests and a test script so Depo can check changes for you."],
      action,
    });
  }
  const counts =
    run.passed !== null || run.failed !== null
      ? `${run.failed ?? 0} failed, ${run.passed ?? 0} passed`
      : null;
  const ran = `Ran ${when(run.at, o.now)} by ${run.by}`;
  const stale = o.changedAfter(run.at);
  const evidence = [run.command ? `Command: ${run.command}` : null, counts, ran];
  if (!run.ok) {
    const total = (run.passed ?? 0) + (run.failed ?? 0);
    const what = run.timedOut
      ? "The last test run timed out."
      : run.failed
        ? `${run.failed} of ${total} tests failed.`
        : `The last test run failed${run.exitCode !== null ? ` (exit code ${run.exitCode})` : ""}.`;
    return check(
      "tests",
      "fail",
      stale ? `${what} Files changed after it, and the tests did not run again.` : what,
      {
        evidence,
        reason: run.timedOut
          ? "the last test run timed out"
          : run.failed
            ? `${run.failed} of ${total} tests failed`
            : "the last test run failed",
        action,
      },
    );
  }
  if (stale)
    return check("tests", "stale", "Tests passed, but files changed after the last run.", {
      evidence,
      reason: "tests were not run after the last change",
      action,
    });
  return check(
    "tests",
    "pass",
    run.passed
      ? `All ${plural(run.passed, "test")} passed after the last change.`
      : "Tests passed after the last change.",
    { evidence, reason: "tests passed after the last change", action },
  );
}

// ---- Code checks (diagnostics) ---------------------------------------------------------------

export function codeCheck(o: {
  available: boolean;
  result: DiagnosticsResult | null;
  changedAfter(at: string): boolean;
  now?: Date;
}): ReadinessCheck {
  const r = o.result;
  if (!o.available || !r)
    return check(
      "code",
      "not_run",
      o.available
        ? "Code checks have not run on this change."
        : "Code checks are not available in this engine.",
    );
  const tools = r.tools.length ? `Checked with ${r.tools.join(", ")}` : null;
  const evidence = [
    tools,
    `${plural(r.counts.error, "error")}, ${plural(r.counts.warning, "warning")}`,
    r.skipped.length ? `Not installed: ${r.skipped.join(", ")}` : null,
    `Ran ${when(r.at, o.now)}`,
  ];
  if (r.counts.error > 0)
    return check("code", "fail", `The code checks found ${plural(r.counts.error, "error")}.`, {
      evidence,
      reason: plural(r.counts.error, "code error"),
    });
  const stale = o.changedAfter(r.at);
  if (r.counts.warning > 0)
    return check(
      "code",
      stale ? "stale" : "warn",
      `The code checks found ${plural(r.counts.warning, "warning")}${stale ? ", and files changed after they ran" : ""}.`,
      {
        evidence,
        reason: stale
          ? "code checks are older than the last change"
          : plural(r.counts.warning, "code warning"),
      },
    );
  if (stale)
    return check("code", "stale", "The code checks were clean, but files changed after they ran.", {
      evidence,
      reason: "code checks are older than the last change",
    });
  return check("code", "pass", "No errors or warnings from the code checks.", {
    evidence,
    reason: "no code errors",
  });
}

// ---- Security --------------------------------------------------------------------------------

function scoreFacts(s: ScoreEvidence, now?: Date): string[] {
  const out = [`Score ${s.score}/100${s.grade ? ` (${s.grade})` : ""}`];
  if (s.critical !== null || s.high !== null)
    out.push(
      `${s.critical ?? 0} critical, ${s.high ?? 0} high${s.findings !== null ? `, ${s.findings} in all` : ""}`,
    );
  else if (s.findings !== null) out.push(plural(s.findings, "finding"));
  if (s.tools.length) out.push(`Checked with ${s.tools.slice(0, 4).join(", ")}`);
  out.push(`${s.scope === "copy" ? "Scanned this copy" : "The project's last scan"} ${when(s.at, now)}`);
  return out;
}

export function securityCheck(o: {
  copy: ScoreEvidence | null;
  project: ScoreEvidence | null;
  changedAfter(at: string): boolean;
  action: ReadinessAction | null;
  now?: Date;
}): ReadinessCheck {
  const s = o.copy ?? o.project;
  if (!s)
    return check("security", "not_run", "This copy was not scanned for security problems.", {
      action: o.action,
    });
  const serious = (s.critical ?? 0) + (s.high ?? 0);
  const evidence = scoreFacts(s, o.now);
  const where = s.scope === "copy" ? "This copy" : "The project's last scan";
  if (s.blocks || serious > 0) {
    const what =
      serious > 0
        ? `${where} has ${plural(serious, "high or critical finding")}.`
        : `${where} scored ${s.score}/100, which blocks the release.`;
    return check("security", "fail", s.scope === "copy" ? what : `${what} This copy was not scanned.`, {
      evidence,
      reason:
        serious > 0 ? plural(serious, "high or critical security finding") : `security score ${s.score}/100`,
      action: o.action,
    });
  }
  if (s.score < 80)
    return check(
      "security",
      "warn",
      `${where} scored ${s.score}/100.${s.scope === "copy" ? "" : " This copy was not scanned."}`,
      { evidence, reason: `security score ${s.score}/100`, action: o.action },
    );
  if (s.scope === "project")
    return check(
      "security",
      "not_run",
      `This copy was not scanned. The project's last scan scored ${s.score}/100 with nothing high or critical.`,
      { evidence, action: o.action },
    );
  if (o.changedAfter(s.at))
    return check("security", "stale", "The scan was clean, but files changed after it.", {
      evidence,
      reason: "the security scan is older than the last change",
      action: o.action,
    });
  return check("security", "pass", `Scanned this copy: ${s.score}/100, nothing high or critical.`, {
    evidence,
    reason: "no high or critical security findings",
    action: o.action,
  });
}

// ---- UX --------------------------------------------------------------------------------------

const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl)$/i;
const UI_DIR = /(^|\/)(components?|pages|views|screens|layouts|templates|static|public|ui)\//i;

/** Files of the change that draw screens (markup, styles, components). */
export function uiFiles(files: FileLike[]): string[] {
  return files
    .filter((f) => !f.binary || /\.(svg|png|jpe?g|gif|webp|ico)$/i.test(f.path))
    .map((f) => f.path)
    .filter((p) => UI_EXT.test(p) || (UI_DIR.test(p) && /\.(m?[jt]s|svg)$/i.test(p)));
}

export function uxCheck(o: {
  ui: string[];
  score: ScoreEvidence | null;
  changedAfter(at: string): boolean;
  now?: Date;
}): ReadinessCheck {
  if (o.ui.length === 0) return check("ux", "not_run", "No screens changed, so there is nothing to score.");
  const filesLine = `Screens changed: ${o.ui.slice(0, 4).join(", ")}${o.ui.length > 4 ? ` and ${o.ui.length - 4} more` : ""}`;
  const s = o.score;
  if (!s)
    return check("ux", "not_run", "Screens changed, but there is no UX score for this change.", {
      evidence: [filesLine],
    });
  const facts = [
    `Score ${s.score}/100${s.grade ? ` (${s.grade})` : ""}`,
    `Scored ${when(s.at, o.now)}`,
    filesLine,
  ];
  const mine = s.scope === "copy";
  if (s.blocks)
    return check("ux", "fail", `The UX score is ${s.score}/100, which blocks the release.`, {
      evidence: facts,
      reason: `the UX score blocks the release (${s.score}/100)`,
    });
  if (s.score < 80)
    return check(
      "ux",
      "warn",
      `The UX score is ${s.score}/100.${mine ? "" : " It is from an earlier task."}`,
      {
        evidence: facts,
        reason: `UX score ${s.score}/100`,
      },
    );
  if (!mine)
    return check(
      "ux",
      "not_run",
      `Screens changed, but this change was not scored. The last UX score was ${s.score}/100.`,
      { evidence: facts },
    );
  if (o.changedAfter(s.at))
    return check("ux", "stale", `The UX score was ${s.score}/100, but files changed after it.`, {
      evidence: facts,
      reason: "the UX score is older than the last change",
    });
  return check("ux", "pass", `The UX score is ${s.score}/100.`, {
    evidence: facts,
    reason: `UX score ${s.score}/100`,
  });
}

// ---- Page check ------------------------------------------------------------------------------

/** The counts that matter from a stored page check. */
export function pageEvidence(c: PageCheck, by: string): PageEvidence {
  let server = 0;
  let client = 0;
  let blocked = 0;
  let firstFailure: string | null = null;
  let consoleErrors = 0;
  let firstConsole: string | null = null;
  const a11y = { critical: 0, serious: 0 };
  for (const v of c.views) {
    let s = 0;
    let cl = 0;
    let b = 0;
    for (const r of v.failedRequests) {
      if (r.blocked) b++;
      else if (r.status !== null && r.status < 500) cl++;
      else s++;
      if (!r.blocked && !firstFailure)
        firstFailure = `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "") || "/"} (${r.status ?? r.error ?? "no answer"})`;
    }
    // The stored list is capped; the count is not.
    const extra = Math.max(0, v.failedRequestCount - v.failedRequests.length);
    server = Math.max(server, s + extra);
    client = Math.max(client, cl);
    blocked = Math.max(blocked, b);
    consoleErrors = Math.max(consoleErrors, v.consoleErrorCount);
    firstConsole ??= v.consoleErrors[0]?.text.split("\n")[0] ?? null;
    a11y.critical = Math.max(a11y.critical, v.a11y.counts.critical);
    a11y.serious = Math.max(a11y.serious, v.a11y.counts.serious);
  }
  return {
    at: c.at,
    url: c.url,
    widths: c.views.map((v) => v.width),
    loaded: c.views.length > 0 && c.views.every((v) => v.loaded && !v.error),
    consoleErrors,
    firstConsoleError: firstConsole,
    serverFailures: server,
    clientFailures: client,
    blocked,
    firstFailure,
    critical: a11y.critical,
    serious: a11y.serious,
    by,
  };
}

export function pageCheck(o: {
  page: PageEvidence | null;
  ui: string[];
  changedAfter(at: string): boolean;
  action: ReadinessAction | null;
  now?: Date;
}): ReadinessCheck {
  const p = o.page;
  if (!p)
    return check(
      "page",
      "not_run",
      o.ui.length ? "Screens changed, but the page was not checked." : "The page was not checked.",
      { action: o.action },
    );
  const a11y = p.critical + p.serious;
  const evidence = [
    `${p.url.replace(/^https?:\/\//, "")} at ${p.widths.join(", ") || "no"} width${p.widths.length === 1 ? "" : "s"}`,
    p.consoleErrors
      ? `${plural(p.consoleErrors, "console error")}${p.firstConsoleError ? `: ${p.firstConsoleError}` : ""}`
      : null,
    p.serverFailures + p.clientFailures
      ? `${plural(p.serverFailures + p.clientFailures, "failed request")}${p.firstFailure ? `: ${p.firstFailure}` : ""}`
      : null,
    p.blocked ? `${plural(p.blocked, "request")} to the internet blocked` : null,
    a11y ? `Accessibility: ${p.critical} critical, ${p.serious} serious` : null,
    `Checked ${when(p.at, o.now)} by ${p.by}`,
  ];
  if (!p.loaded)
    return check("page", "fail", "The page did not load.", {
      evidence,
      reason: "the page did not load",
      action: o.action,
    });
  if (p.consoleErrors > 0 || p.serverFailures > 0) {
    const parts = [
      p.consoleErrors ? plural(p.consoleErrors, "console error") : null,
      p.serverFailures ? plural(p.serverFailures, "failed request") : null,
    ].filter(Boolean);
    return check("page", "fail", `The page has ${parts.join(" and ")}.`, {
      evidence,
      reason: `the page has ${parts.join(" and ")}`,
      action: o.action,
    });
  }
  const stale = o.changedAfter(p.at);
  if (a11y > 0 || p.clientFailures > 0 || p.blocked > 0) {
    const parts = [
      a11y ? plural(a11y, "serious accessibility issue") : null,
      p.clientFailures ? plural(p.clientFailures, "missing file or page", "missing files or pages") : null,
      p.blocked ? plural(p.blocked, "blocked internet request") : null,
    ].filter((x): x is string => !!x);
    return check(
      "page",
      stale ? "stale" : "warn",
      `The page loaded with ${parts.join(", ")}${stale ? ", and files changed after the check" : ""}.`,
      {
        evidence,
        reason: stale ? "the page check is older than the last change" : parts.join(", "),
        action: o.action,
      },
    );
  }
  if (stale)
    return check("page", "stale", "The page check was clean, but files changed after it.", {
      evidence,
      reason: "the page check is older than the last change",
      action: o.action,
    });
  return check("page", "pass", "The page loaded with no errors and no serious accessibility issues.", {
    evidence,
    reason: "the page check was clean",
    action: o.action,
  });
}

// ---- Plan criteria and reviews (team tasks) ---------------------------------------------------

export function planCheck(plan: Plan, name: (owner: string) => string): ReadinessCheck {
  const items: ReadinessItem[] = [];
  let met = 0;
  let total = 0;
  for (const n of plan.nodes) {
    const done = n.status === "done";
    const crit = n.criteria.length ? n.criteria : [];
    for (const c of crit) {
      total++;
      if (done) met++;
      items.push({ text: `${name(n.owner)}: ${plainText(c)}`, ok: done });
    }
  }
  const unfinished = plan.nodes.filter((n) => n.status !== "done");
  if (total === 0) {
    if (unfinished.length === 0)
      return check(
        "plan",
        "pass",
        `The plan had no written criteria, and all ${plural(plan.nodes.length, "task")} finished.`,
        {
          reason: "every planned task finished",
        },
      );
    return check("plan", "warn", `${plural(unfinished.length, "planned task")} did not finish.`, {
      items: unfinished.map((n) => ({
        text: `${name(n.owner)}: ${plainText(n.title)} (${n.status})`,
        ok: false,
      })),
      reason: `${plural(unfinished.length, "planned task")} did not finish`,
    });
  }
  const evidence = [
    `${met} of ${total} criteria met`,
    `${plan.nodes.length - unfinished.length} of ${plural(plan.nodes.length, "task")} done`,
    unfinished.length
      ? `Not finished: ${unfinished
          .map((n) => plainText(n.title))
          .slice(0, 3)
          .join("; ")}`
      : null,
  ];
  // Unmet first, so the open ones are visible when the list is cut.
  items.sort((a, b) => Number(a.ok) - Number(b.ok));
  if (met < total)
    return check("plan", "warn", `${total - met} of ${total} acceptance criteria are not met.`, {
      evidence,
      items,
      reason: `${total - met} of ${total} plan criteria not met`,
    });
  return check("plan", "pass", `All ${total} acceptance criteria are met.`, {
    evidence,
    items,
    reason: "every plan criterion met",
  });
}

export function reviewsCheck(
  plan: Plan,
  decisions: ReviewEvidence[],
  name: (owner: string) => string,
): ReadinessCheck {
  const reviewed = plan.nodes.filter((n) => n.review);
  if (reviewed.length === 0) return check("reviews", "not_run", "No task in this run needed a review.");
  const items: ReadinessItem[] = [];
  let approved = 0;
  let open = 0;
  let missing = 0;
  for (const n of reviewed) {
    const mine = decisions.filter((d) => d.kind === "review" && d.nodeId === n.id);
    const last = mine.at(-1);
    const backs = decisions.filter((d) => d.kind === "send_back" && d.nodeId === n.id).length;
    const who = n.reviewer ? name(n.reviewer) : "the reviewer";
    const title = plainText(n.title);
    if (!last) {
      missing++;
      items.push({ text: `${title}: not reviewed (${n.status})`, ok: false });
    } else if (last.outcome === "changes" && n.status !== "done") {
      open++;
      items.push({ text: `${title}: ${who} still asks for changes`, ok: false });
    } else {
      approved++;
      items.push({
        text: `${title}: approved by ${who}${backs ? ` after ${plural(backs, "send-back")}` : ""}`,
        ok: true,
      });
    }
  }
  const sentBack = decisions.filter((d) => d.kind === "send_back").length;
  const evidence = [
    `${approved} approved${open ? `, ${open} still rejected` : ""}${missing ? `, ${missing} not reviewed` : ""}`,
    sentBack ? `${plural(sentBack, "send-back")} during the run` : null,
  ];
  items.sort((a, b) => Number(a.ok) - Number(b.ok));
  if (open > 0)
    return check(
      "reviews",
      "fail",
      `${plural(open, "review")} still ${open === 1 ? "asks" : "ask"} for changes.`,
      {
        evidence,
        items,
        reason: open === 1 ? "a reviewer still asks for changes" : `${open} reviewers still ask for changes`,
      },
    );
  if (missing > 0)
    return check(
      "reviews",
      "warn",
      `${plural(missing, "task")} that needed a review ${missing === 1 ? "was" : "were"} not reviewed.`,
      {
        evidence,
        items,
        reason: `${plural(missing, "task")} not reviewed`,
      },
    );
  return check(
    "reviews",
    "pass",
    `Every review approved the work${sentBack ? `, after ${plural(sentBack, "send-back")}` : ""}.`,
    { evidence, items, reason: "every review approved" },
  );
}

// ---- Comments, risky files, size ---------------------------------------------------------------

export function commentsCheck(open: ReviewComment[] | null): ReadinessCheck {
  if (open === null) return check("comments", "not_run", "There are no changes to comment on.");
  if (open.length === 0) return check("comments", "pass", "No open comments.");
  return check(
    "comments",
    "warn",
    `${plural(open.length, "comment")} ${open.length === 1 ? "is" : "are"} still open.`,
    {
      evidence: [
        open.some((c) => c.sentAt)
          ? "Some were sent to the agent and wait for an answer"
          : "Not sent to the agent yet",
      ],
      items: open.map((c) => ({ text: `${c.path}:${c.endLine} ${plainText(c.body)}`, ok: null })),
      reason: plural(open.length, "open comment"),
    },
  );
}

const RISKY: [RegExp, string][] = [
  [
    /(^|\/)(migrations?|alembic|db\/migrate|prisma\/migrations)\/|(^|\/)schema\.prisma$|\.migration\.[a-z]+$/i,
    "Migration",
  ],
  [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|pubspec\.lock)$/i,
    "Lockfile",
  ],
  [
    /(^|\/)\.github\/(workflows|actions)\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$|(^|\/)bitbucket-pipelines\.yml$/i,
    "CI",
  ],
  [/(^|\/)\.env(\.[\w-]+)?$|(^|\/)env\.(example|sample|template)$/i, "Environment file"],
  [
    /(^|[/._-])(auth|authn|authz|authentication|authori[sz]ation|login|logout|signin|signup|sessions?|passwords?|passwd|oauth\d?|jwt|permissions?|rbac|acl|crypto|secrets?)([/._-]|$)/i,
    "Auth or secrets",
  ],
];

/** Files worth a second look before applying, with why. */
export function riskyFiles(files: FileLike[]): { path: string; why: string }[] {
  const out: { path: string; why: string }[] = [];
  for (const f of files) {
    const why = [
      f.kind === "deleted" ? "Deleted" : null,
      ...RISKY.filter(([re]) => re.test(f.path)).map(([, label]) => label),
      f.conflict ? "Changed in the project since the copy was made" : null,
    ].filter((x): x is string => !!x);
    if (why.length) out.push({ path: f.path, why: [...new Set(why)].join(", ") });
  }
  return out;
}

export function riskyCheck(files: FileLike[] | null): ReadinessCheck {
  if (files === null) return check("risky", "not_run", "There are no changes yet.");
  const risky = riskyFiles(files);
  if (risky.length === 0)
    return check("risky", "pass", "No migrations, auth, lockfiles, CI, environment files or deletions.");
  const kinds = [...new Set(risky.flatMap((r) => r.why.split(", ")))].map((k) => k.toLowerCase());
  return check(
    "risky",
    "warn",
    `${plural(risky.length, "file")} ${risky.length === 1 ? "needs" : "need"} a careful look: ${kinds.slice(0, 4).join(", ")}.`,
    {
      items: risky.map((r) => ({ text: `${r.path} (${r.why})`, ok: null })),
      reason: `${plural(risky.length, "risky file")} (${kinds.slice(0, 3).join(", ")})`,
    },
  );
}

/** A change set this big is hard to review in one sitting. */
export const LARGE_FILES = 40;
export const LARGE_LINES = 1500;

export function sizeCheck(files: FileLike[] | null): ReadinessCheck {
  if (files === null) return check("size", "not_run", "There are no changes yet.");
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const kinds = (k: FileLike["kind"]) => files.filter((f) => f.kind === k).length;
  const bin = files.filter((f) => f.binary).length;
  const evidence = [
    `${kinds("added")} new, ${kinds("modified")} changed, ${kinds("deleted")} deleted`,
    bin ? `${plural(bin, "binary file")}` : null,
  ];
  const line = `${plural(files.length, "file")}, +${add} −${del}.`;
  if (files.length > LARGE_FILES || add + del > LARGE_LINES)
    return check("size", "warn", `A very large change: ${line} Review it in parts.`, {
      evidence,
      reason: `a very large change (${plural(files.length, "file")}, ${add + del} lines)`,
    });
  return check("size", "pass", line, { evidence });
}

// ---- The verdict -------------------------------------------------------------------------------

/** Checks whose evidence comes from tools that ran on the change (not from model claims). */
const TOOL_CHECKS: ReadinessCheckId[] = ["tests", "code", "security", "page"];

export function isWarning(c: ReadinessCheck): boolean {
  return c.state === "warn" || c.state === "stale" || (c.state === "not_run" && c.expected);
}

export interface Verdict {
  verdict: ReadinessVerdict;
  headline: string;
  reasons: string[];
  text: string;
  failures: number;
  warnings: number;
}

/**
 * Not ready when any check fails; ready with warnings when any warns, is stale, or should have run
 * but did not; ready otherwise. When no tool checked the change at all, that is a warning too:
 * tools decide correctness, not the agents' own words.
 */
export function decideVerdict(checks: ReadinessCheck[]): Verdict {
  const fails = checks.filter((c) => c.state === "fail");
  const warns = checks.filter(isWarning);
  const toolRan = checks.some((c) => TOOL_CHECKS.includes(c.id) && c.state !== "not_run");
  const extra =
    !toolRan && !warns.some((c) => c.id === "tests") ? ["no tests or checks ran on this change"] : [];
  const warnings = warns.length + extra.length;
  const reasonOf = (c: ReadinessCheck) =>
    c.reason ?? `${c.label.toLowerCase()}: ${c.summary.replace(/\.$/, "")}`;
  let verdict: ReadinessVerdict;
  let headline: string;
  let reasons: string[];
  if (fails.length > 0) {
    verdict = "not_ready";
    headline = "Not ready";
    reasons = [...fails.map(reasonOf), ...warns.map(reasonOf), ...extra];
  } else if (warnings > 0) {
    verdict = "ready_with_warnings";
    headline = `Ready with ${plural(warnings, "warning")}`;
    reasons = [...warns.map(reasonOf), ...extra];
  } else {
    verdict = "ready";
    headline = "Ready";
    reasons = checks.filter((c) => c.state === "pass" && c.reason).map((c) => c.reason as string);
  }
  reasons = [...new Set(reasons)].slice(0, 3);
  const text = reasons.length ? `${headline}: ${reasons.join("; ")}.` : `${headline}.`;
  return { verdict, headline, reasons, text: clip(text, 800), failures: fails.length, warnings };
}

/** The short text of a pill or badge: "Ready", "2 warnings", "Not ready". */
export function shortVerdict(v: Pick<Verdict, "verdict" | "warnings">): string {
  if (v.verdict === "not_ready") return "Not ready";
  if (v.verdict === "ready_with_warnings") return plural(v.warnings, "warning");
  return "Ready";
}

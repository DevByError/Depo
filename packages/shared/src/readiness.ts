import { z } from "zod";

/**
 * The readiness report: one honest answer to "is this ready to apply?" for a task's latest change
 * set. It is built from what Depo already stored (test runs, page checks, scores, reviews, comments,
 * the plan's criteria and the diff itself), with no model call. A few checks can be run on request
 * in the task's private copy.
 */

/**
 * pass: the evidence says it is fine; warn: worth a look; fail: do not apply as is;
 * not_run: no evidence (or nothing to check); stale: the evidence is older than the last change.
 */
export const ReadinessStateSchema = z.enum(["pass", "warn", "fail", "not_run", "stale"]);
export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

export const READINESS_CHECK_IDS = [
  "tests",
  "code",
  "security",
  "ux",
  "page",
  "plan",
  "reviews",
  "comments",
  "risky",
  "size",
] as const;
export const ReadinessCheckIdSchema = z.enum(READINESS_CHECK_IDS);
export type ReadinessCheckId = z.infer<typeof ReadinessCheckIdSchema>;

/** What can be run now from the report: the tests, a page check, a security scan. */
export const ReadinessRunKindSchema = z.enum(["tests", "page", "security"]);
export type ReadinessRunKind = z.infer<typeof ReadinessRunKindSchema>;

export const ReadinessActionSchema = z.object({
  run: ReadinessRunKindSchema,
  /** The button text: "Run tests", "Check the page", "Scan". */
  label: z.string().max(40),
  /** What runs, in plain words ("npm test in the private copy"). */
  detail: z.string().max(300),
  /** This run is going on now (started from any window). */
  running: z.boolean(),
});
export type ReadinessAction = z.infer<typeof ReadinessActionSchema>;

/** One line under a check (a plan criterion, a risky file, an open comment). `ok` null = neutral. */
export const ReadinessItemSchema = z.object({
  text: z.string().max(400),
  ok: z.boolean().nullable(),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

export const ReadinessCheckSchema = z.object({
  id: ReadinessCheckIdSchema,
  label: z.string().max(40),
  state: ReadinessStateSchema,
  /** One plain sentence. */
  summary: z.string().max(400),
  /** Short facts: counts, the command, when. */
  evidence: z.array(z.string().max(300)).max(8),
  /** Lines to show when the row is opened (criteria, files, comments). */
  items: z.array(ReadinessItemSchema).max(40),
  /** A not_run check that should have run (tests with a known command) counts as a warning. */
  expected: z.boolean(),
  /** The short phrase used in the verdict line when this check is not fine ("1 open comment"). */
  reason: z.string().max(200).nullable(),
  action: ReadinessActionSchema.nullable(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const ReadinessVerdictSchema = z.enum(["ready", "ready_with_warnings", "not_ready"]);
export type ReadinessVerdict = z.infer<typeof ReadinessVerdictSchema>;

export const ReadinessReportSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  /** The change set the report is about (null while there is none). */
  changeSetId: z.string().nullable(),
  at: z.string(),
  verdict: ReadinessVerdictSchema,
  /** "Ready", "Ready with 2 warnings", "Not ready". */
  headline: z.string().max(80),
  /** Up to three plain reasons, the most serious first. */
  reasons: z.array(z.string().max(200)).max(3),
  /** The one line: "Ready with 2 warnings: tests were not run after the last change; 1 open comment." */
  text: z.string().max(800),
  failures: z.number().int().min(0),
  warnings: z.number().int().min(0),
  checks: z.array(ReadinessCheckSchema).max(12),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

export const ReadinessMethods = {
  /** The report for the task's latest change set. Reads stored data only. */
  "readiness.get": {
    params: z.object({ taskId: z.string().min(1).max(64) }).strict(),
    result: z.object({ report: ReadinessReportSchema }),
  },
  /**
   * Run one check now in the task's private copy: the tests (the project's known test command,
   * through the command policy), a page check of the running copy (started first when Depo knows
   * how), or a security scan. Returns the updated report.
   */
  "readiness.run": {
    params: z.object({ taskId: z.string().min(1).max(64), check: ReadinessRunKindSchema }).strict(),
    result: z.object({
      report: ReadinessReportSchema,
      /** What happened, in one plain sentence ("Tests passed: 12 passed."). */
      message: z.string().max(600),
      ok: z.boolean(),
    }),
  },
} as const;

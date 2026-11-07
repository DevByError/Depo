import { z } from "zod";

/**
 * Diagnostics: Depo runs the compilers and linters a project already has installed on this PC
 * (never installing anything) and lists what they found, plus runtime problems: crashes in a
 * preview's log and console errors from page checks.
 */

export const ProblemSeveritySchema = z.enum(["error", "warning", "info"]);
export type ProblemSeverity = z.infer<typeof ProblemSeveritySchema>;

export const ProblemSchema = z.object({
  /** Relative to the project root with forward slashes; null for a problem with no file. */
  file: z.string().max(1000).nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  severity: ProblemSeveritySchema,
  /** The rule or error code, e.g. `TS2322`, `F401`, `no-unused-vars`. */
  code: z.string().max(200).nullable(),
  message: z.string().max(2000),
  /** tsc, biome, eslint, ruff, compileall, mypy, pyright, go vet, cargo check. */
  tool: z.string().max(100),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const ProblemCountsSchema = z.object({
  error: z.number().int().min(0),
  warning: z.number().int().min(0),
  info: z.number().int().min(0),
});
export type ProblemCounts = z.infer<typeof ProblemCountsSchema>;

export const DiagnosticsToolRunSchema = z.object({
  /** As listed in `tools`, e.g. `tsc` or `eslint (frontend)`. */
  tool: z.string(),
  command: z.string(),
  /** Folder it ran in, relative to the root ("" = root). */
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  timedOut: z.boolean(),
  problems: z.number().int().min(0),
  /** Why the tool's output could not be used (it crashed, or printed nothing readable). */
  error: z.string().max(2000).nullable(),
});
export type DiagnosticsToolRun = z.infer<typeof DiagnosticsToolRunSchema>;

export const DiagnosticsResultSchema = z.object({
  projectId: z.string(),
  /** The task whose private copy was checked, or null for the project folder. */
  taskId: z.string().nullable(),
  /** Where it ran, in plain words. */
  target: z.string(),
  at: z.string(),
  durationMs: z.number().int().min(0),
  /** The tools that ran. */
  tools: z.array(z.string()),
  /** Tools the project uses that are not installed (or not allowed), by name. */
  skipped: z.array(z.string()),
  /** Why each one was skipped, in plain words. */
  notes: z.array(z.object({ tool: z.string(), reason: z.string() })),
  counts: ProblemCountsSchema,
  /** Worst first, then by file and line. */
  problems: z.array(ProblemSchema).max(1000),
  truncated: z.boolean(),
  runs: z.array(DiagnosticsToolRunSchema),
  /** `user` or the agent tag that ran it. */
  by: z.string(),
});
export type DiagnosticsResult = z.infer<typeof DiagnosticsResultSchema>;

export const RuntimeProblemSchema = ProblemSchema.extend({
  /** `preview` = a crash in a running app's log, `page check` = a console error in a page check. */
  source: z.enum(["preview", "page check"]),
  at: z.string(),
  /** The traceback, stack or log lines around it (at most 40 lines). */
  excerpt: z.string().max(6000),
  /** The preview or page check it came from. */
  ref: z.string(),
  /** How many times the same problem appeared. */
  count: z.number().int().min(1),
});
export type RuntimeProblem = z.infer<typeof RuntimeProblemSchema>;

const Target = { projectId: z.string(), taskId: z.string().optional() };

export const DiagnosticsMethods = {
  /** Run the installed compilers and linters now (one run per target at a time). */
  "diagnostics.run": {
    params: z.object(Target).strict(),
    result: z.object({ result: DiagnosticsResultSchema }),
  },
  /** The newest result for the project folder or a task's copy, or null when none ran yet. */
  "diagnostics.latest": {
    params: z.object(Target).strict(),
    result: z.object({ result: DiagnosticsResultSchema.nullable() }),
  },
  /** Crashes in running previews' logs and console errors from the newest page check. */
  "diagnostics.runtime": {
    params: z.object(Target).strict(),
    result: z.object({ problems: z.array(RuntimeProblemSchema) }),
  },
} as const;

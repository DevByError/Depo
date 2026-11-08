import { z } from "zod";

/**
 * The step plan of a single-agent run (ADR-0086): the steps Depo will take for a request, shown
 * in the chat before the model starts and updated as each step moves. Steps found later (a fix
 * for a problem the final check found) are added with `added: true`.
 */

export const PlanStepStatusSchema = z.enum(["pending", "running", "done", "blocked", "skipped"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepKindSchema = z.enum([
  /** One table of the request's database list. */
  "table",
  /** One API route ("GET /api/skills/search"). */
  "route",
  /** One page of a web app ("/skills/[id]"). */
  "page",
  /** Tests the request asks for. */
  "tests",
  /** Anything else the request names (seed data, the Store methods, a shared header). */
  "build",
  /** A problem the final check found. */
  "fix",
  /** Depo runs the tests and the app and checks the pages. */
  "check",
]);
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: PlanStepKindSchema,
  status: PlanStepStatusSchema,
  /** What the last try found (running, blocked) or how the step ended (done). */
  note: z.string().nullable().default(null),
  /** Tries so far (a clean restart counts as a new try). */
  tries: z.number().int().nonnegative().default(0),
  /** The model doing or that did the step. */
  model: z.string().nullable().default(null),
  /** Added after the plan was shown (a fix the final check called for). */
  added: z.boolean().default(false),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const StepPlanSchema = z.object({
  /** The user message this plan answers (the turn it belongs to). */
  messageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(PlanStepSchema),
});
export type StepPlan = z.infer<typeof StepPlanSchema>;

/** Steps done, and steps in all (skipped ones count as done). */
export function planProgress(plan: Pick<StepPlan, "steps">): { done: number; total: number } {
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total: plan.steps.length };
}

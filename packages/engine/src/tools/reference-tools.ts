import { z } from "zod";
import type { AgentTool, ToolContext } from "./index";
import { resolveInside, ToolError } from "./paths";

/**
 * compare_to_reference: when the owner sent a picture or a link and asked for the same look, an
 * agent compares a screenshot of what it built with that reference: measured colour differences
 * and, with a vision model, a list of what looks different and how to fix it. This file must not
 * import values from ./index (it is loaded by it); the service is reached through `ctx.references`.
 */

/** What the reference service offers agents (see references/service.ts). */
export interface ReferenceHooks {
  /** True when the task has a studied reference with a picture. */
  has(taskId: string): boolean;
  compare(o: {
    taskId: string;
    projectId: string;
    screenshot: string;
    reference?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

function need(ctx: ToolContext): { hooks: ReferenceHooks; taskId: string; projectId: string } {
  if (!ctx.references || !ctx.projectId || !ctx.taskId)
    throw new ToolError("Design references are only available while working on a project task.");
  if (!ctx.references.has(ctx.taskId))
    throw new ToolError(
      "The owner did not send a design reference with this task, so there is nothing to compare with.",
    );
  return { hooks: ctx.references, taskId: ctx.taskId, projectId: ctx.projectId };
}

/** Same as `tool` in ./index, which this file may not import. */
const def = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool<z.ZodType>;

const compareToReference = def({
  name: "compare_to_reference",
  description:
    "Compare a screenshot of your page with the design reference the owner sent (a picture or a site): the measured colour differences and, when a vision model is set up, what looks different (typography, spacing, shapes, layout) with concrete fixes. Take the screenshot first with check_page (use its desktop screenshot path) or render_screenshot.",
  schema: z.object({
    screenshot: z
      .string()
      .min(1)
      .max(300)
      .describe("Path of your screenshot in the workspace, e.g. .depo/qa/qa_123/desktop.png"),
    reference: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe("Which reference, when there are several (1 = first)"),
  }),
  async run(a, ctx) {
    const { hooks, taskId, projectId } = need(ctx);
    const { abs, rel } = resolveInside(ctx.root, a.screenshot);
    ctx.bus.emit({
      agent: ctx.agent,
      projectId,
      taskId,
      type: "reviewing",
      text: `Comparing ${rel} with the design reference`,
      details: { path: rel, designReference: true },
      status: "started",
    });
    return hooks.compare({
      taskId,
      projectId,
      screenshot: abs,
      ...(a.reference ? { reference: a.reference } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  },
});

export const REFERENCE_TOOLS: AgentTool<z.ZodType>[] = [compareToReference];

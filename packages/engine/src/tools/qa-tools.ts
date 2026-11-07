import { type PageCheck, QaStepSchema, QaWidthSchema } from "@depo/shared";
import { z } from "zod";
import { formatForAgent } from "../design/page-check";
import { type AgentTool, registerTools, type ToolContext, tool } from "./index";
import { ToolError } from "./paths";

/**
 * check_page: an agent looks at the running app like a human tester would, in the PC's own
 * browser (headless): phone, tablet and desktop widths, simple interactions, console errors,
 * failed requests, axe-core accessibility checks and screenshots. The QA service is reached through
 * `ctx.qa` (see qa/service.ts).
 */

export interface CheckPageArgs {
  url?: string | undefined;
  file?: string | undefined;
  widths: z.infer<typeof QaWidthSchema>[];
  steps: z.infer<typeof QaStepSchema>[];
  expect_text?: string | undefined;
  review: boolean;
}

/** What the QA service offers agents. */
export interface QaHooks {
  checkForAgent(ctx: ToolContext, a: CheckPageArgs): Promise<PageCheck>;
  /** The newest checks of the agent's task (for the UX audit). */
  latestForAgent(ctx: ToolContext, limit: number): PageCheck[];
}

function needQa(ctx: ToolContext): QaHooks {
  if (!ctx.qa || !ctx.projectId || !ctx.taskId)
    throw new ToolError("Page checks are only available while working on a project task.");
  return ctx.qa;
}

const checkPage = tool({
  name: "check_page",
  description:
    "Open a page of the running app in a real browser (headless) at phone, tablet and desktop widths, like a human tester: optional steps (click, type, press, wait_for), then console errors, failed requests, accessibility issues (axe-core), whether expect_text is on the page, and a screenshot per width. Start the app with start_preview first and pass a path such as / or /login, or pass `file` for a plain HTML file in your workspace. Fix console errors and critical or serious accessibility issues before you hand off.",
  schema: z.object({
    url: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "Path on the app started with start_preview (e.g. / or /login) or http://127.0.0.1:PORT/... Empty = home page.",
      ),
    file: z
      .string()
      .max(300)
      .optional()
      .describe("Instead of url: an HTML file in your workspace, e.g. docs/design/preview.html"),
    widths: z.array(QaWidthSchema).min(1).max(3).default(["phone", "tablet", "desktop"]),
    steps: z
      .array(QaStepSchema)
      .max(10)
      .default([])
      .describe(
        'Done in order after the page loads, e.g. [{"action":"type","selector":"#email","text":"a@b.co"},{"action":"click","selector":"button[type=submit]"},{"action":"wait_for","text":"Welcome"}]. press uses key (Enter, Tab, Escape).',
      ),
    expect_text: z.string().max(300).optional().describe("Text that must be on the page after the steps"),
    review: z
      .boolean()
      .default(true)
      .describe("Also ask the vision model (when one is set up) to look at the desktop screenshot"),
  }),
  async run(a, ctx) {
    const check = await needQa(ctx).checkForAgent(ctx, a);
    return formatForAgent(check);
  },
});

const tools: AgentTool<z.ZodType>[] = [checkPage];
registerTools(...tools);
export const QA_TOOL_NAMES = tools.map((t) => t.name);

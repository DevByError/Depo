import { z } from "zod";
import type { AgentTool, ToolContext } from "./index";
import { ToolError } from "./paths";

/**
 * diagnostics: the agent runs the project's own compilers and linters (the ones installed on this
 * PC) in its private copy and gets a short list of problems, worst first. This file must not
 * import values from ./index (it is loaded by it); the service is reached through `ctx.diagnostics`.
 */

/** What the diagnostics service offers agents (see diagnostics/service.ts). */
export interface DiagnosticsHooks {
  /** Run the checks in the agent's workspace; a compact list of about 1500 characters. */
  runForAgent(ctx: ToolContext): Promise<string>;
}

const def = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool<z.ZodType>;

export const DIAGNOSTICS_TOOLS: AgentTool<z.ZodType>[] = [
  def({
    name: "diagnostics",
    description:
      "Check your workspace with the project's own compilers and linters that are installed on this PC (TypeScript, Biome, ESLint, Ruff or Python syntax, mypy, Pyright, go vet, cargo check). Returns the problems worst first as file:line: message. Run it before you say you are done and fix the errors you introduced.",
    schema: z.object({}),
    async run(_a, ctx) {
      if (!ctx.diagnostics || !ctx.projectId || !ctx.taskId)
        throw new ToolError(
          "Diagnostics are only available while working on a project task. Use run_command with the project's lint or type check.",
        );
      return ctx.diagnostics.runForAgent(ctx);
    },
  }),
];

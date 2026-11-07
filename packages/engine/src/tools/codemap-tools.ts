import { z } from "zod";
import type { AgentTool } from "./index";
import { ToolError } from "./paths";

/**
 * The code map for agents: how the project fits together, in a few hundred tokens. This file must
 * not import values from ./index (it is loaded by it); the map is reached through `ctx.knowledge`.
 */

const def = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool<z.ZodType>;

/** About 450 tokens: enough to orient, small enough for an 8k context. */
export const CODE_MAP_BUDGET = 1800;

export const CODE_MAP_TOOLS: AgentTool<z.ZodType>[] = [
  def({
    name: "code_map",
    description:
      "See how the project fits together before reading files: its modules (folders) and which import which, entry points, import cycles, the libraries it uses and hot spots (most imported, largest, most complex, changed most in git). Give path to see what one file imports and what imports it, or folder to zoom into one part.",
    schema: z.object({
      path: z.string().max(500).optional().describe("A file, e.g. src/api/users.ts or app/models.py"),
      folder: z.string().max(500).optional().describe("A folder to zoom into, e.g. src/api"),
    }),
    async run(a, ctx) {
      const map = ctx.knowledge?.codeMap;
      if (!map) throw new ToolError("The code map is not available here. Use repo_map, list_dir and search.");
      const text = await map({
        ...(a.path ? { path: a.path } : {}),
        ...(a.folder ? { folder: a.folder } : {}),
      });
      ctx.bus.emit({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        type: "searching",
        text: a.path
          ? `Code map around ${a.path}`
          : a.folder
            ? `Code map of ${a.folder}`
            : "Code map of the project",
        details: { path: a.path ?? null, folder: a.folder ?? null },
        status: "succeeded",
      });
      return text;
    },
  }),
];

import fs from "node:fs";
import { z } from "zod";
import { findBlock, searchBlocks } from "../blocks";
import { writeFileTool } from "./fs-tools";
import { registerTools, tool } from "./index";
import { resolveInside, ToolError } from "./paths";

/** Building blocks (Phase 8): tested pieces such as login, roles, audit log and rate limiting. */

const tools = [
  tool({
    name: "list_blocks",
    description:
      "List the ready-made, tested building blocks you can add to the project (login and sessions, roles and permissions, audit log, rate limiter, configuration, pagination, an accessible login form, PostgreSQL via Docker). Use a block instead of writing security-sensitive code yourself.",
    schema: z.object({
      stack: z.enum(["ts", "py", "react", "docker"]).optional(),
      search: z.string().max(60).optional().describe("e.g. login, roles, audit"),
    }),
    async run(a) {
      const found = searchBlocks({ stack: a.stack, text: a.search });
      if (!found.length) return "No block matches. Write the code yourself and test it.";
      return found
        .map((b) => `- ${b.id} [${b.stack}]: ${b.name}. ${b.description} Adds ${b.files.length} file(s).`)
        .join("\n");
    },
  }),
  tool({
    name: "use_block",
    description:
      "Add a building block to the project: writes its source files and its tests, never overwriting a different file. Then follow the notes it returns, run its tests, and connect it to the project's own code.",
    schema: z.object({
      id: z.string().min(1).max(40),
      dir: z
        .string()
        .max(100)
        .default("")
        .describe("Folder to put it in, e.g. 'backend'. Empty = project root."),
    }),
    async run(a, ctx) {
      const block = findBlock(a.id);
      if (!block) throw new ToolError(`Unknown block "${a.id}". Use list_blocks to see the ones that exist.`);
      const prefix = a.dir
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      const plan = block.files.map((f) => {
        const rel = prefix ? `${prefix}/${f.path}` : f.path;
        const { abs } = resolveInside(ctx.root, rel);
        const exists = fs.existsSync(abs);
        const same = exists && fs.readFileSync(abs, "utf8") === f.content;
        return { rel, content: f.content, exists, same };
      });
      const conflicts = plan.filter((p) => p.exists && !p.same).map((p) => p.rel);
      if (conflicts.length)
        throw new ToolError(
          `Nothing was written: these files already exist and differ: ${conflicts.join(", ")}. Use another folder (dir) or edit the existing code by hand.`,
        );
      const written: string[] = [];
      for (const p of plan) {
        if (p.same) continue;
        const r = writeFileTool(ctx.root, p.rel, p.content);
        ctx.readPaths?.add(r.path);
        ctx.onFileChanged?.(r.path);
        written.push(r.path);
      }
      ctx.bus.emit({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        type: "writing_file",
        text: `Added building block ${block.id} (${written.length} files)`,
        details: { block: block.id, files: written.length },
        status: "succeeded",
      });
      const test = block.test ? (prefix ? `cd ${prefix} && ${block.test}` : block.test) : "";
      return [
        `Added ${block.name}: ${written.join(", ") || "all files were already there"}.`,
        test ? `Run its tests with: ${test}` : "It has no tests of its own.",
        "Next steps:",
        ...block.notes.map((n) => `- ${n}`),
      ].join("\n");
    },
  }),
];

registerTools(...tools);
export const BLOCK_TOOL_NAMES = tools.map((t) => t.name);

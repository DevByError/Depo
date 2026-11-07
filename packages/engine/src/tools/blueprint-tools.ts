import { z } from "zod";
import {
  BLUEPRINTS,
  type Blueprint,
  compactTree,
  findBlueprint,
  planBlueprint,
  projectEntries,
} from "../blueprints";
import { writeFileTool } from "./fs-tools";
import { registerTools, tool } from "./index";
import { ToolError } from "./paths";

/**
 * Blueprints for agents: list them, and start an empty project from one. Writing goes into the
 * task's private copy like any other change, so the owner still reviews every file.
 */

const IDS = BLUEPRINTS.map((b) => b.id).join(", ");

function details(b: Blueprint): string {
  return [
    `${b.id}: ${b.title}. ${b.summary}`,
    `Stack: ${b.stack.join(", ")}.`,
    `What you get: ${b.features.join("; ")}.`,
    `Run: ${b.runCommand}`,
    `Test: ${b.testCommand}`,
    "How to extend it:",
    b.extendGuide,
  ].join("\n");
}

const tools = [
  tool({
    name: "list_blueprints",
    description: `List Depo's blueprints: tested, production-grade starting points for a new system (${IDS}). With an id it shows one blueprint's commands and its extend guide. Use one when the project is empty instead of starting from a blank page.`,
    schema: z.object({
      id: z.string().max(40).optional().describe("A blueprint id, to see its details and extend guide"),
    }),
    async run(a) {
      if (a.id?.trim()) {
        const b = findBlueprint(a.id);
        if (!b) throw new ToolError(`Unknown blueprint "${a.id}". The blueprints are: ${IDS}.`);
        return details(b);
      }
      return [
        ...BLUEPRINTS.map((b) => `- ${b.id}: ${b.title}. ${b.summary} Stack: ${b.stack.join(", ")}.`),
        "Start one with use_blueprint, only in an empty project; then extend it to the request.",
      ].join("\n");
    },
  }),
  tool({
    name: "use_blueprint",
    description:
      "Start a new system from a blueprint: writes a whole tested project (code, tests, README, run scripts) into the empty project, then you build the request on top of it. Refused when the project already has code. Returns the files, the run and test commands, and how to extend it.",
    schema: z.object({
      id: z.string().min(1).max(40).describe(IDS),
      name: z.string().max(80).optional().describe("The project's name, for the README and the app's title"),
    }),
    async run(a, ctx) {
      const b = findBlueprint(a.id);
      if (!b) throw new ToolError(`Unknown blueprint "${a.id}". The blueprints are: ${IDS}.`);
      const vars = { name: a.name ?? "" };
      const plan = planBlueprint(ctx.root, b, vars);
      const others = projectEntries(ctx.root);
      if (others.length) {
        const code = plan.files.filter((f) => f.path !== "README.md" && !f.path.startsWith(".git"));
        if (code.every((f) => f.action === "same"))
          return `The ${b.title} blueprint is already in place. Run: ${b.runCommand}. Test: ${b.testCommand}.\nHow to extend it:\n${b.extendGuide}`;
        throw new ToolError(
          `Nothing was written: this project already has code (${others.slice(0, 6).join(", ")}). Blueprints are only for empty projects; extend the existing code instead (list_blocks has tested pieces you can add).`,
        );
      }
      const written: string[] = [];
      for (const f of plan.files) {
        if (f.action === "same") continue;
        const r = writeFileTool(ctx.root, f.path, f.content);
        // Not marked as read on purpose: the first edit of a file shows it, so the copy is exact.
        ctx.onFileChanged?.(r.path);
        written.push(r.path);
      }
      ctx.bus.emit({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        type: "writing_file",
        text: `Started from the ${b.title} blueprint (${written.length} files)`,
        details: { blueprint: b.id, files: written.length },
        status: "succeeded",
      });
      return [
        `Started from the ${b.title} blueprint: ${written.length} files written${plan.kept.length ? `; kept your ${plan.kept.join(", ")}` : ""}.`,
        "Files:",
        compactTree(plan.files.map((f) => f.path)),
        `Run: ${b.runCommand}`,
        `Test: ${b.testCommand}`,
        "How to extend it:",
        b.extendGuide,
        "Next: install its packages and run its tests (they pass as written), then build the request on top of it and keep every test passing.",
      ].join("\n");
    },
  }),
];

registerTools(...tools);
export const BLUEPRINT_TOOL_NAMES = tools.map((t) => t.name);

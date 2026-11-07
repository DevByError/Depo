import { z } from "zod";
import type { AgentTool, ToolContext } from "./index";
import { ToolError } from "./paths";

/**
 * dev_database: a test MySQL database (MariaDB) that Depo runs on 127.0.0.1 for the project, so
 * agents can create tables and demo data and the owner can try the app with it. This file must
 * not import values from ./index (it is loaded by it); the service is reached through `ctx.devdb`.
 */

export type DevDbAction = "start" | "status" | "sql" | "reset" | "stop";

export interface DevDbHooks {
  forAgent(ctx: ToolContext, a: { action: DevDbAction; query?: string | undefined }): Promise<string>;
}

const def = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool<z.ZodType>;

export const DEVDB_TOOLS: AgentTool<z.ZodType>[] = [
  def({
    name: "dev_database",
    description:
      "The project's test MySQL database, run by Depo on 127.0.0.1 (MariaDB). start: create it if needed, start it and write DATABASE_URL into the app's .env (then run the app's migrate and seed scripts for tables and demo data). sql: run SQL in it (CREATE TABLE, INSERT demo rows, SELECT to check). status, reset (drop every table), stop. Use it whenever the app needs MySQL; never ask the owner to install or set up a database.",
    schema: z.object({
      action: z.enum(["start", "status", "sql", "reset", "stop"]),
      query: z
        .string()
        .max(100_000)
        .optional()
        .describe("For sql: one or more SQL statements separated by ;"),
    }),
    async run(a, ctx) {
      if (!ctx.devdb || !ctx.projectId)
        throw new ToolError("The test database is only available while working on a project task.");
      if (a.action === "sql" && !a.query?.trim()) throw new ToolError("Give the SQL to run in `query`.");
      return ctx.devdb.forAgent(ctx, a);
    },
  }),
];

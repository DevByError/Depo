import fs from "node:fs";
import path from "node:path";
import type { DevDbHooks } from "../tools/devdb-tools";
import type { ToolContext } from "../tools/index";
import { ToolError } from "../tools/paths";
import { type DevDatabaseService, DevDbError, type DevDbInfo, envFolders } from "./service";

/** The app's own scripts that create its tables and demo data, folder by folder. */
export function dataSteps(root: string): { cwd: string; commands: string[] }[] {
  const out: { cwd: string; commands: string[] }[] = [];
  for (const dir of envFolders(root)) {
    let pkg: { scripts?: Record<string, string>; packageManager?: string };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const scripts = Object.keys(pkg.scripts ?? {});
    const bun =
      pkg.packageManager?.startsWith("bun") ||
      fs.existsSync(path.join(dir, "bun.lock")) ||
      fs.existsSync(path.join(dir, "bun.lockb"));
    const run = (s: string) => (bun ? `bun run ${s}` : `npm run ${s}`);
    const pick = (names: string[]) => names.find((n) => scripts.includes(n));
    const commands = [
      pick(["db:migrate", "migrate", "db:push", "db:setup"]),
      pick(["db:seed", "seed"]),
    ].filter((s): s is string => !!s);
    if (commands.length)
      out.push({
        cwd: path.relative(root, dir).split(path.sep).join("/") || ".",
        commands: commands.map(run),
      });
  }
  return out;
}

export function describeDb(info: DevDbInfo): string {
  const engine = info.engine === "mysql" ? "MySQL" : "MariaDB";
  return `${engine}${info.version ? ` ${info.version}` : ""}: database ${info.database} on 127.0.0.1:${info.port}, user ${info.user}, password ${info.password}\nDATABASE_URL=${info.url}`;
}

/** dev_database for agents: the service, the project's name and the agent's private copy. */
export function devDbHooks(o: {
  service: DevDatabaseService;
  projectName: (projectId: string) => string | null;
}): DevDbHooks {
  const svc = o.service;
  return {
    async forAgent(ctx: ToolContext, a) {
      const projectId = ctx.projectId as string;
      const name = o.projectName(projectId) ?? "app";
      const who = {
        name,
        taskId: ctx.taskId,
        agent: ctx.agent,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      };
      try {
        switch (a.action) {
          case "start": {
            const info = await svc.ensure(projectId, who);
            const files = svc.writeEnv(ctx.root, info);
            for (const f of files) ctx.onFileChanged?.(f);
            const steps = dataSteps(ctx.root);
            return [
              `Test database running. ${describeDb(info)}`,
              files.length
                ? `Wrote the connection settings to ${files.join(", ")}.`
                : "The app's .env already points at it.",
              steps.length
                ? `Next: create the tables and demo data with the app's scripts (run_command, after installing packages): ${steps.map((s) => `${s.commands.join(" then ")} (cwd ${s.cwd})`).join("; ")}.`
                : "Next: create the tables and demo data (the app's migrate and seed code, or dev_database action sql), then check them with a SELECT.",
            ].join("\n");
          }
          case "status": {
            const info = await svc.status(projectId);
            if (info.state === "running") return `Running. ${describeDb(info)}`;
            return `The test database is ${info.state}.${info.message ? ` ${info.message}` : ""} Start it with dev_database action start.`;
          }
          case "sql":
            if ((await svc.status(projectId)).state !== "running") await svc.ensure(projectId, who);
            return await svc.sql(projectId, a.query ?? "");
          case "reset": {
            const info = await svc.reset(projectId, who);
            return `Emptied: ${info.database} has no tables now. Run the migrate and seed scripts again for tables and demo data.`;
          }
          case "stop":
            return (await svc.stop(projectId))
              ? "Stopped the test database."
              : "The test database was not running.";
        }
      } catch (err) {
        if (err instanceof DevDbError) throw new ToolError(err.message);
        throw err;
      }
    },
  };
}

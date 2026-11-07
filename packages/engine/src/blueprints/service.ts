import type { BlueprintGit, Project } from "@depo/shared";
import { gitAvailable, readIdentity } from "../git/repo";
import { getLogger, type Logger } from "../logger";
import type { MemoryStore } from "../memory/store";
import type { ProjectRegistry } from "../projects/registry";
import { classifyCommand } from "../tools/shell/policy";
import { runShell } from "../tools/shell/run";
import { findBlueprint, writeBlueprint } from "./index";
import type { Blueprint } from "./types";

export interface CreateFromBlueprintParams {
  id: string;
  parentDir: string;
  name: string;
  description?: string | undefined;
  initGit?: boolean | undefined;
}

export interface BlueprintServiceDeps {
  registry: Pick<ProjectRegistry, "create">;
  memory: Pick<MemoryStore, "add">;
  logger?: Logger;
}

/**
 * A new project folder from a blueprint: the files, then (when git is installed and allowed) a
 * repository with a first commit, then the project registered with origin "created".
 */
export async function createFromBlueprint(
  p: CreateFromBlueprintParams,
  deps: BlueprintServiceDeps,
): Promise<{ project: Project; files: number; git: BlueprintGit }> {
  const blueprint = findBlueprint(p.id);
  if (!blueprint) throw new Error(`There is no blueprint called "${p.id}".`);
  const log = deps.logger ?? getLogger({ component: "blueprints" });
  let files = 0;
  let git: BlueprintGit = "skipped";
  const project = await deps.registry.create({
    name: p.name,
    parentDir: p.parentDir,
    ...(p.description?.trim() ? { description: p.description.trim() } : {}),
    stack: blueprint.stack.join(", "),
    populate: async (dest) => {
      files = writeBlueprint(dest, blueprint, { name: p.name, description: p.description }).length;
      if (p.initGit !== false) git = await startRepository(dest, blueprint, log);
    },
  });
  deps.memory.add(
    project.id,
    "decision",
    `Started from Depo's ${blueprint.title} blueprint (${blueprint.id}). Run: ${blueprint.runCommand}. Test: ${blueprint.testCommand}. Its extend guide: list_blueprints with id ${blueprint.id}.`,
    "system",
  );
  log.info("project created from a blueprint", {
    projectId: project.id,
    blueprint: blueprint.id,
    files,
    git,
  });
  return { project, files, git };
}

/**
 * `git init`, then a first commit when git knows who the owner is. Every command goes through the
 * command policy; anything refused or failing is skipped quietly (the project still works).
 */
async function startRepository(dest: string, blueprint: Blueprint, log: Logger): Promise<BlueprintGit> {
  if (!(await gitAvailable())) return "skipped";
  const run = async (command: string): Promise<boolean> => {
    const verdict = classifyCommand(command, dest);
    if (verdict.decision === "deny") {
      log.info("git step skipped by the command policy", { command, reason: verdict.reason });
      return false;
    }
    // "ask" is answered: the owner asked for a new project with a git repository.
    const res = await runShell({
      command,
      cwd: dest,
      timeoutMs: 60_000,
      env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
      maxOutputBytes: 20_000,
    });
    if (res.exitCode !== 0) log.info("git step failed", { command, exitCode: res.exitCode });
    return res.exitCode === 0;
  };
  if (!(await run("git init -q"))) return "skipped";
  if (!(await readIdentity(dest))) return "initialized";
  if (!(await run("git add -A"))) return "initialized";
  // The message is fixed text (no owner input), so it is safe in any shell.
  return (await run(`git commit -q -m "Start from the ${blueprint.title} blueprint"`))
    ? "committed"
    : "initialized";
}

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
  registry: Pick<ProjectRegistry, "create" | "setSettings">;
  memory: Pick<MemoryStore, "add">;
  logger?: Logger;
}

/**
 * A new project with a blueprint as its starting point. The folder gets only a README (and a git
 * repository when allowed): the first task writes the blueprint into its private copy and builds
 * the request on it, so the starting project and the work arrive in the folder together, in one
 * review, and nothing is left behind when that work is stopped or discarded (ADR-0091).
 * `writeFiles` keeps the old behaviour (the blueprint written into the folder and committed).
 */
export async function createFromBlueprint(
  p: CreateFromBlueprintParams & { writeFiles?: boolean },
  deps: BlueprintServiceDeps,
): Promise<{ project: Project; files: number; git: BlueprintGit }> {
  const blueprint = findBlueprint(p.id);
  if (!blueprint) throw new Error(`There is no blueprint called "${p.id}".`);
  const log = deps.logger ?? getLogger({ component: "blueprints" });
  let files = blueprint.files({ name: p.name, description: p.description }).length;
  let git: BlueprintGit = p.initGit === false ? "skipped" : "initialized";
  const project = await deps.registry.create({
    name: p.name,
    parentDir: p.parentDir,
    ...(p.description?.trim() ? { description: p.description.trim() } : {}),
    stack: blueprint.stack.join(", "),
    ...(p.initGit === false ? { initGit: false } : {}),
    ...(p.writeFiles
      ? {
          populate: async (dest: string) => {
            files = writeBlueprint(dest, blueprint, { name: p.name, description: p.description }).length;
            git = p.initGit !== false ? await startRepository(dest, blueprint, log) : "skipped";
          },
        }
      : {}),
  });
  if (!p.writeFiles) deps.registry.setSettings(project.id, { starter: blueprint.id });
  deps.memory.add(
    project.id,
    "decision",
    p.writeFiles
      ? `Started from Depo's ${blueprint.title} blueprint (${blueprint.id}). Run: ${blueprint.runCommand}. Test: ${blueprint.testCommand}. Its extend guide: list_blueprints with id ${blueprint.id}.`
      : `The owner chose Depo's ${blueprint.title} blueprint (${blueprint.id}) as the starting point: the first task writes it into its private copy and builds the request on it. Run: ${blueprint.runCommand}. Test: ${blueprint.testCommand}.`,
    "system",
  );
  log.info("project created from a blueprint", {
    projectId: project.id,
    blueprint: blueprint.id,
    files,
    git,
    written: !!p.writeFiles,
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

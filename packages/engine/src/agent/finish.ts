import fs from "node:fs";
import path from "node:path";
import {
  type PageCheck,
  type PreviewDetection,
  type PreviewInfo,
  type PreviewLogLine,
  RUN_REPORT_HEADING,
  type RunRecipe,
} from "@depo/shared";
import { dataSteps } from "../devdb/hooks";
import type { DevDbInfo } from "../devdb/service";
import { executeTool, type ToolContext } from "../tools/index";
import { packageManagerFor } from "./stack";

/**
 * The finish line: when an agent says it is done, Depo itself installs the app's packages, starts
 * the test database (with tables and demo data) when the app uses MySQL, starts the app from the
 * private copy and opens its home page in the headless browser. Problems go back to the agent to
 * fix; when all is well the owner gets the links. Commands go through run_command, so the command
 * policy, the approvals (or the project's full access) and the activity feed apply as usual.
 */

export interface FinishDeps {
  previews: {
    detect(projectId: string, taskId?: string | null): Promise<PreviewDetection>;
    list(projectId?: string): PreviewInfo[];
    stop(id: string, reason?: string): Promise<boolean>;
    settled(id: string): Promise<PreviewInfo | null>;
    logs(id: string, since?: number): { lines: PreviewLogLine[] };
  };
  /** Starts the task's copy the way Depo does at review (so it stops again when the changes are applied or discarded). */
  autoStart(
    projectId: string,
    taskId: string,
  ): Promise<
    { started: true; previews: PreviewInfo[] } | { started: false; reason: string; detail?: string }
  >;
  devdb?: {
    ensure(
      projectId: string,
      o: { name: string; taskId?: string | null; agent?: string; signal?: AbortSignal },
    ): Promise<DevDbInfo>;
    writeEnv(root: string, info: DevDbInfo): string[];
  };
  qa?: {
    check(req: {
      projectId: string;
      taskId: string | null;
      by: string;
      signal?: AbortSignal;
    }): Promise<PageCheck>;
  };
  projectName: string;
  /** How long to wait for the app to answer. */
  startTimeoutMs?: number;
}

export interface FinishResult {
  /** Plain problems for the agent to fix (empty when everything ran). */
  problems: string[];
  /** The running app, frontend first. */
  running: { label: string; url: string; role: string }[];
  /** Short lines for the owner: what Depo did. */
  notes: string[];
}

const START_TIMEOUT_MS = 120_000;

/** Does the app talk to MySQL / MariaDB? (its .env example, its packages or its schema) */
export function usesMysql(root: string): boolean {
  const look = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (
          depth < 2 &&
          !/^(node_modules|\.git|\.next|dist|build|\.depo|\.venv|venv)$/.test(e.name) &&
          look(abs, depth + 1)
        )
          return true;
        continue;
      }
      if (!/^(\.env\.example|\.env\.sample|package\.json|requirements\.txt|pyproject\.toml)$/.test(e.name))
        continue;
      let text = "";
      try {
        text = fs.readFileSync(abs, "utf8").slice(0, 200_000);
      } catch {
        continue;
      }
      if (e.name === "package.json" ? /"(mysql2?|mariadb)"\s*:/.test(text) : /mysql|mariadb/i.test(text))
        return true;
    }
    return false;
  };
  return look(root, 0);
}

/** `bun test` / `npm test` for each JS part with a real test script (folders relative to the copy). */
export function testCommands(root: string, recipes: { cwd: string }[]): { cwd: string; command: string }[] {
  const out: { cwd: string; command: string }[] = [];
  const seen = new Set<string>();
  for (const r of recipes) {
    if (seen.has(r.cwd)) continue;
    seen.add(r.cwd);
    const dir = path.join(root, r.cwd);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const test = (pkg.scripts as Record<string, string> | undefined)?.test;
    if (!test || /no test specified/.test(test)) continue;
    // `bun test` is Bun's own test runner and skips the script; `bun run test` runs the script.
    const pm = packageManagerFor(dir, root, pkg);
    out.push({ cwd: r.cwd, command: pm === "bun" ? "bun run test" : `${pm} test` });
  }
  return out;
}

function exitOk(content: string): boolean {
  return /^Exit code 0\./.test(content);
}

function tail(text: string, lines: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");
}

/** Demo sign-ins a seed script printed ("demo@example.com / demo12345"). */
export function demoLogins(output: string): string[] {
  return [
    ...new Set(
      [...output.matchAll(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*\/\s*(\S+)/g)].map((m) => `${m[1]} / ${m[2]}`),
    ),
  ].slice(0, 5);
}

export async function runFinishLine(
  ctx: ToolContext,
  deps: FinishDeps,
  signal: AbortSignal,
): Promise<FinishResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  const projectId = ctx.projectId;
  const taskId = ctx.taskId;
  if (!projectId || !taskId) return { problems, running: [], notes };
  const run = async (command: string, cwd: string, timeout = 900) => {
    const r = await executeTool(
      "run_command",
      { command, ...(cwd && cwd !== "." ? { cwd } : {}), timeout_seconds: timeout },
      ctx,
    );
    return { ok: !r.isError && exitOk(r.content), content: r.content };
  };

  // 1. Packages: every part of the app that still needs its packages installed.
  let detection = await deps.previews.detect(projectId, taskId);
  let recipe: RunRecipe | undefined = detection.recipes[detection.suggested];
  if (!recipe) return { problems, running: [], notes };
  const parts = (r: RunRecipe) => (r.kind === "both" ? (r.parts ?? []) : [r]);
  const installs = new Map<string, string>();
  for (const p of parts(recipe)) if (p.missing) installs.set(p.missing.cwd, p.missing.install);
  for (const [cwd, command] of installs) {
    if (signal.aborted) return { problems, running: [], notes };
    const r = await run(command, cwd);
    if (r.ok) notes.push(`Installed the packages${cwd ? ` in ${cwd}` : ""}.`);
    else
      problems.push(
        `Installing the packages with \`${command}\`${cwd ? ` in ${cwd}` : ""} failed:\n${tail(r.content, 15)}`,
      );
  }
  if (problems.length) return { problems, running: [], notes };
  if (installs.size) {
    detection = await deps.previews.detect(projectId, taskId);
    recipe = detection.recipes[detection.suggested];
    if (!recipe) return { problems, running: [], notes };
  }

  // 2. The test database, its tables and demo data.
  if (deps.devdb && usesMysql(ctx.root)) {
    try {
      const info = await deps.devdb.ensure(projectId, {
        name: deps.projectName,
        taskId,
        agent: ctx.agent,
        signal,
      });
      for (const f of deps.devdb.writeEnv(ctx.root, info)) ctx.onFileChanged?.(f);
      notes.push(
        `Test database: ${info.database} on 127.0.0.1:${info.port} (user ${info.user}, password ${info.password}).`,
      );
      for (const step of dataSteps(ctx.root)) {
        for (const command of step.commands) {
          if (signal.aborted) return { problems, running: [], notes };
          const r = await run(command, step.cwd, 300);
          if (!r.ok) {
            problems.push(
              `\`${command}\` in ${step.cwd} failed against the test database:\n${tail(r.content, 15)}`,
            );
            break;
          }
          const logins = demoLogins(r.content);
          if (logins.length) notes.push(`Demo sign-ins: ${logins.join(", ")}.`);
        }
      }
    } catch (err) {
      problems.push(`The test database could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (problems.length) return { problems, running: [], notes };
  }

  // 3. The tests of every part that has them, the way the owner would run them.
  for (const t of testCommands(ctx.root, parts(recipe))) {
    if (signal.aborted) return { problems, running: [], notes };
    const r = await run(t.command, t.cwd, 600);
    const where = t.cwd ? ` in ${t.cwd}` : "";
    if (r.ok) notes.push(`Tests pass${where} (\`${t.command}\`).`);
    else problems.push(`The tests${where} fail (\`${t.command}\`):\n${tail(r.content, 20)}`);
  }
  if (problems.length) return { problems, running: [], notes };

  // 4. Start the app fresh (an agent's own preview may predate the installs and the .env).
  for (const p of deps.previews.list(projectId))
    if (p.taskId === taskId && (p.state === "running" || p.state === "starting"))
      await deps.previews.stop(p.id, "Restarted by Depo to check the finished work");
  const started = await deps.autoStart(projectId, taskId);
  if (!started.started) {
    if (started.reason === "failed")
      problems.push(`The app did not start: ${started.detail ?? "unknown error"}`);
    else if (started.reason === "needs_install") problems.push("The app's packages are still not installed.");
    return { problems, running: [], notes };
  }
  const limit = deps.startTimeoutMs ?? START_TIMEOUT_MS;
  const settled = await Promise.all(
    started.previews.map((p) =>
      Promise.race([deps.previews.settled(p.id), Bun.sleep(limit).then(() => null)]).then((s) => s ?? p),
    ),
  );
  for (const p of settled) {
    if (p.state === "running") continue;
    let log = "";
    try {
      log = deps.previews
        .logs(p.id)
        .lines.filter((l) => l.stream !== "depo")
        .slice(-15)
        .map((l) => l.text)
        .join("\n");
    } catch {
      log = "";
    }
    problems.push(
      `${p.label} did not start${p.state === "starting" ? ` within ${Math.round(limit / 1000)}s` : ""}${p.error ? `: ${p.error}` : ""}.${log ? `\nLast lines of its output:\n${log}` : ""}`,
    );
  }
  const rank = { frontend: 0, app: 1, backend: 2 } as Record<string, number>;
  const running = settled
    .filter((p) => p.state === "running")
    .sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3))
    .map((p) => ({ label: p.label, url: p.url, role: p.role }));
  if (problems.length) return { problems, running, notes };

  // 5. Look at the home page like a person would: console errors and failed requests.
  if (deps.qa && running.some((p) => p.role !== "backend")) {
    try {
      const c = await deps.qa.check({ projectId, taskId, by: ctx.agent, signal });
      const desktop = c.views.at(-1);
      const issues = [
        ...(c.views.some((v) => !v.loaded)
          ? [`the page did not load (${desktop?.error ?? `status ${desktop?.status}`})`]
          : []),
        ...(desktop?.consoleErrors ?? []).slice(0, 5).map((e) => `console error: ${e.text}`),
        ...(desktop?.failedRequests ?? [])
          .slice(0, 5)
          .map((r) => `failed request: ${r.method} ${r.url} (${r.status ?? r.error ?? "failed"})`),
      ];
      if (issues.length)
        problems.push(`Depo opened ${c.url} in a browser and found:\n- ${issues.join("\n- ")}`);
      else notes.push(`Checked ${c.url} in a browser: it loads with no console errors.`);
    } catch (err) {
      notes.push(`The page check could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { problems, running, notes };
}

/** What the agent reads when the finish line found problems. */
export function problemsPrompt(r: FinishResult): string {
  return [
    "Depo tried to run your work the way the owner will, and it does not work yet:",
    ...r.problems.map((p) => `- ${p}`),
    "Fix the cause (read the files involved, change them, run the commands again), then finish with a short summary. Do not tell the owner to fix it.",
  ].join("\n");
}

/** The report added after the final answer (shown as its own card in the chat), or "" when there is nothing to say. */
export function finishSummary(r: FinishResult): string {
  const lines: string[] = [];
  if (r.running.length) lines.push(`Running now: ${r.running.map((p) => `${p.label} ${p.url}`).join(" · ")}`);
  lines.push(...r.notes);
  if (r.problems.length) lines.push("Still not working:", ...r.problems.map((p) => `- ${p.split("\n")[0]}`));
  return lines.length ? [RUN_REPORT_HEADING, ...lines].join("\n") : "";
}

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  type DiagnosticsResult,
  DiagnosticsResultSchema,
  type DiagnosticsToolRun,
  type PageCheck,
  type PreviewInfo,
  type PreviewLogLine,
  type Problem,
  type RuntimeProblem,
} from "@depo/shared";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import { QUIET_ENV } from "../terminal/env";
import type { DiagnosticsHooks } from "../tools/diagnostics-tools";
import { matchesRule, type ToolContext } from "../tools/index";
import { classifyCommand } from "../tools/shell/policy";
import { runShell } from "../tools/shell/run";
import { sortProblems } from "./parsers";
import { type PlannedTool, type PlanOptions, planDiagnostics } from "./plan";
import { mergeRuntime, pageCheckProblems, previewProblems } from "./runtime";

/**
 * Problems from real tools: runs the compilers and linters a project already has on this PC
 * (one tool after another, each through the command policy, contained, with a time limit), keeps
 * the newest result per project folder or task copy, and adds runtime problems from previews and
 * page checks. Agents reach it through the `diagnostics` tool; the readiness report reads
 * `latest(projectId, taskId)`.
 */

export interface DiagnosticsServiceOptions {
  bus: EventBus;
  logger: Logger;
  sqlite: Database;
  /** Depo's folder for tool caches (compiled Python files, cargo builds, mypy). */
  cacheDir: string;
  projectRoot(projectId: string): string | null;
  workspaceRoot(taskId: string): string | null;
  taskProject(taskId: string): string | null;
  taskTitle(taskId: string): string | null;
  commandRules(projectId: string): { allow: string[]; deny: string[] } | null;
  previews?: {
    list(projectId?: string): PreviewInfo[];
    logs(id: string, since?: number): { lines: PreviewLogLine[] };
  };
  qa?: { list(projectId: string, taskId: string | null, limit?: number): PageCheck[] };
  /** Test hooks. */
  find?: PlanOptions["find"];
  /** Caps every tool's time limit (tests). */
  toolTimeoutMs?: number;
}

const MAX_PROBLEMS = 1000;
const AGENT_BUDGET = 1500;

export interface RunRequest {
  projectId: string;
  taskId?: string | null;
  /** `user` or the agent tag. */
  by?: string;
  /** Overrides for an agent run: its workspace, command rules, environment and cancel signal. */
  root?: string;
  rules?: { allow: string[]; deny: string[] } | null;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class DiagnosticsService implements DiagnosticsHooks {
  private readonly running = new Map<string, Promise<DiagnosticsResult>>();
  private readonly log: Logger;

  constructor(private readonly o: DiagnosticsServiceOptions) {
    this.log = o.logger.child({ component: "diagnostics" });
  }

  private key(projectId: string, taskId: string | null): string {
    return `${projectId}|${taskId ?? "project"}`;
  }

  private target(projectId: string, taskId: string | null): { root: string; label: string } {
    const realRoot = this.o.projectRoot(projectId);
    if (!realRoot || !fs.existsSync(realRoot)) throw new Error("This project's folder could not be found.");
    if (!taskId) return { root: realRoot, label: "Your project" };
    if (this.o.taskProject(taskId) !== projectId) throw new Error("That task belongs to another project.");
    const ws = this.o.workspaceRoot(taskId);
    if (!ws) throw new Error("This task's private copy no longer exists, so there is nothing new to check.");
    return { root: ws, label: this.o.taskTitle(taskId) ?? "Task copy" };
  }

  /** Run every installed tool for the target. A second request while one runs gets the same result. */
  run(req: RunRequest): Promise<DiagnosticsResult> {
    const taskId = req.taskId ?? null;
    const k = this.key(req.projectId, taskId);
    const busy = this.running.get(k);
    if (busy) return busy;
    const p = this.execute(req).finally(() => this.running.delete(k));
    this.running.set(k, p);
    return p;
  }

  private async execute(req: RunRequest): Promise<DiagnosticsResult> {
    const taskId = req.taskId ?? null;
    const by = req.by ?? "user";
    const t = req.root
      ? { root: req.root, label: taskId ? (this.o.taskTitle(taskId) ?? "Task copy") : "Your project" }
      : this.target(req.projectId, taskId);
    const started = performance.now();
    const plan = planDiagnostics(t.root, {
      cacheDir: this.o.cacheDir,
      cacheKey: `${req.projectId}-${taskId ?? "project"}`,
      ...(this.o.find ? { find: this.o.find } : {}),
    });
    const rules = req.rules !== undefined ? req.rules : this.o.commandRules(req.projectId);
    const problems: Problem[] = [];
    const runs: DiagnosticsToolRun[] = [];
    const ran: string[] = [];
    const notes = plan.skipped.map((s) => ({ tool: s.tool, reason: s.reason }));
    const skipped = plan.skipped.filter((s) => s.configured).map((s) => s.tool);
    for (const tool of plan.tools) {
      if (req.signal?.aborted) break;
      const refusal = this.refusal(tool, t.root, rules);
      if (refusal) {
        skipped.push(tool.label);
        notes.push({ tool: tool.label, reason: refusal });
        continue;
      }
      const r = await this.runTool(tool, t.root, req);
      runs.push(r.run);
      ran.push(tool.label);
      problems.push(...r.problems);
    }
    const sorted = sortProblems(problems);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const p of sorted) counts[p.severity]++;
    const result: DiagnosticsResult = {
      projectId: req.projectId,
      taskId,
      target: t.label,
      at: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      tools: ran,
      skipped,
      notes,
      counts,
      problems: sorted.slice(0, MAX_PROBLEMS),
      truncated: sorted.length > MAX_PROBLEMS,
      runs,
      by,
    };
    if (!req.signal?.aborted) this.save(result);
    this.o.bus.emit({
      projectId: req.projectId,
      // An agent's check is a step of its task; the owner's check stays out of the task's chat.
      taskId: by === "user" ? null : taskId,
      agent: by,
      type: "linting",
      text: summaryLine(result),
      details: {
        source: "diagnostics",
        targetTaskId: taskId,
        tools: ran,
        skipped,
        errors: counts.error,
        warnings: counts.warning,
        infos: counts.info,
      },
      durationMs: result.durationMs,
      status: counts.error > 0 || runs.some((x) => x.error) ? "failed" : "succeeded",
    });
    this.log.info("diagnostics finished", {
      projectId: req.projectId,
      taskId,
      by,
      tools: ran,
      skipped,
      ...counts,
      durationMs: result.durationMs,
    });
    return result;
  }

  /** Why a planned tool may not run (a project deny rule, or a verdict that would need approval). */
  private refusal(
    tool: PlannedTool,
    root: string,
    rules: { allow: string[]; deny: string[] } | null,
  ): string | null {
    if (rules?.deny.some((r) => matchesRule(tool.command, r)))
      return "Blocked by this project's command rules.";
    const v = classifyCommand(tool.command, root);
    if (v.decision === "deny") return `Not allowed: ${v.reason}.`;
    if (v.decision === "ask" && !rules?.allow.some((r) => matchesRule(tool.command, r)))
      return `Needs approval (${v.reason}). Run it from the Terminal instead.`;
    return null;
  }

  private async runTool(
    tool: PlannedTool,
    root: string,
    req: RunRequest,
  ): Promise<{ run: DiagnosticsToolRun; problems: Problem[] }> {
    for (const dir of Object.values(tool.env).filter((v) => v.startsWith(this.o.cacheDir)))
      fs.mkdirSync(dir, { recursive: true });
    const timeoutMs = Math.min(tool.timeoutMs, this.o.toolTimeoutMs ?? tool.timeoutMs);
    const res = await runShell({
      command: tool.command,
      cwd: tool.cwd,
      timeoutMs,
      maxOutputBytes: 3_000_000,
      memoryLimitBytes: 4 * 1024 ** 3,
      env: { ...QUIET_ENV, ...(req.env ?? {}), ...tool.env },
      ...(req.signal ? { signal: req.signal } : {}),
    });
    let problems: Problem[] = [];
    let error: string | null = null;
    if (res.timedOut) error = `Stopped after ${Math.round(timeoutMs / 1000)} seconds.`;
    else if (res.cancelled) error = "Cancelled.";
    else {
      const parsed = tool.parse(res.output, { root, cwd: tool.cwd });
      if (parsed === null) error = `Could not read the output of ${tool.id}. ${lastLines(res.output)}`.trim();
      else problems = parsed;
      if (!error && res.exitCode !== 0 && problems.length === 0)
        error = lastLines(res.output) || `${tool.id} exited with ${res.exitCode}.`;
    }
    return {
      run: {
        tool: tool.label,
        command: tool.command,
        cwd: tool.folder,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
        problems: problems.length,
        error: error ? error.slice(0, 2000) : null,
      },
      problems,
    };
  }

  // ---- results -----------------------------------------------------------------------------

  private save(r: DiagnosticsResult): void {
    try {
      this.o.sqlite
        .query(
          "INSERT INTO diagnostics_latest (project_id, target, at, result) VALUES (?,?,?,?) ON CONFLICT(project_id, target) DO UPDATE SET at = excluded.at, result = excluded.result",
        )
        .run(r.projectId, r.taskId ?? "project", r.at, JSON.stringify(r));
    } catch (err) {
      // A project removed while the check ran: nothing to keep.
      this.log.warn("could not keep the diagnostics result", { projectId: r.projectId, err });
    }
  }

  /**
   * The newest result for the project folder (taskId null) or a task's copy, or null. The
   * readiness report reads `at`, `tools`, `skipped` and `counts` from it.
   */
  latest(projectId: string, taskId: string | null): DiagnosticsResult | null {
    const row = this.o.sqlite
      .query("SELECT result FROM diagnostics_latest WHERE project_id = ? AND target = ?")
      .get(projectId, taskId ?? "project") as { result: string } | null;
    if (!row) return null;
    try {
      const parsed = DiagnosticsResultSchema.safeParse(JSON.parse(row.result));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Crashes in the target's running previews and console errors from its newest page check. */
  runtime(projectId: string, taskId: string | null): RuntimeProblem[] {
    let root: string;
    try {
      root = this.target(projectId, taskId).root;
    } catch {
      return [];
    }
    const out: RuntimeProblem[] = [];
    const previews = this.o.previews;
    if (previews) {
      const list = previews
        .list(projectId)
        .filter((p) => p.taskId === taskId)
        .map((info) => {
          try {
            return { info, lines: previews.logs(info.id, 0).lines };
          } catch {
            return { info, lines: [] };
          }
        });
      out.push(...previewProblems(list, root));
    }
    const newest = this.o.qa?.list(projectId, taskId, 1)[0];
    if (newest) {
      const exists = (rel: string) => {
        try {
          return fs.statSync(path.join(root, rel)).isFile();
        } catch {
          return false;
        }
      };
      out.push(...pageCheckProblems(newest, exists));
    }
    return mergeRuntime(out);
  }

  // ---- agents ------------------------------------------------------------------------------

  async runForAgent(ctx: ToolContext): Promise<string> {
    if (!ctx.projectId || !ctx.taskId)
      return "Diagnostics are only available while working on a project task.";
    const r = await this.run({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      by: ctx.agent,
      root: ctx.root,
      rules: ctx.commandRules ?? null,
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return formatForAgent(r, this.runtime(ctx.projectId, ctx.taskId));
  }
}

function lastLines(output: string, n = 6): string {
  return output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n")
    .slice(-600);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function summaryLine(r: DiagnosticsResult): string {
  if (r.tools.length === 0) return `Diagnostics: no checks could run for ${r.target}`;
  const found =
    r.counts.error + r.counts.warning === 0
      ? "no problems"
      : [
          r.counts.error ? plural(r.counts.error, "error") : "",
          r.counts.warning ? plural(r.counts.warning, "warning") : "",
        ]
          .filter(Boolean)
          .join(", ");
  return `Diagnostics (${r.tools.join(", ")}): ${found}`;
}

/** The result as a short list for a small model: worst first, about 1500 characters. */
export function formatForAgent(r: DiagnosticsResult, runtime: RuntimeProblem[] = []): string {
  const lines: string[] = [];
  if (r.tools.length === 0) {
    lines.push("No checks could run in your workspace.");
    for (const n of r.notes) lines.push(`- ${n.tool}: ${n.reason}`);
    lines.push("Use run_command with the project's own lint, type check or tests instead.");
    return lines.join("\n").slice(0, AGENT_BUDGET);
  }
  const head = `${summaryLine(r).replace(/^Diagnostics/, "Checked")}.`;
  lines.push(head);
  for (const run of r.runs)
    if (run.error) lines.push(`${run.tool} failed to run: ${run.error.split("\n")[0]}`);
  let used = lines.join("\n").length;
  let shown = 0;
  const items = [
    ...runtime.slice(0, 3).map((p) => `runtime ${loc(p)}${p.message}`),
    ...r.problems
      .filter((p) => p.severity !== "info")
      .map((p) => `${p.severity} ${loc(p)}${p.code ? `${p.code} ` : ""}${p.message}`),
  ];
  for (const item of items) {
    const line = item.replace(/\s+/g, " ").slice(0, 220);
    if (used + line.length + 1 > AGENT_BUDGET - 60) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const rest = items.length - shown;
  if (rest > 0) lines.push(`[${rest} more not shown; fix these first and run diagnostics again]`);
  if (r.skipped.length) lines.push(`Not checked: ${r.skipped.join(", ")}.`);
  if (r.counts.error > 0) lines.push("Fix the errors you introduced, then run diagnostics again.");
  return lines.join("\n");
}

function loc(p: { file: string | null; line: number | null; column: number | null }): string {
  if (!p.file) return "";
  return `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}: `;
}

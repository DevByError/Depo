import type { DiagnosticsService } from "../diagnostics/service";
import type { TerminalService } from "../terminal/service";
import type { HandlerContext, Handlers } from "./handlers";

/** The Terminal, Test results and Problems tabs (round 3). */

function needTerminal(ctx: HandlerContext): TerminalService {
  if (!ctx.terminal) throw new Error("The Terminal is not available in this engine.");
  return ctx.terminal;
}

function needDiagnostics(ctx: HandlerContext): DiagnosticsService {
  if (!ctx.diagnostics) throw new Error("Diagnostics are not available in this engine.");
  return ctx.diagnostics;
}

export const terminalHandlers: Pick<
  Handlers,
  | "terminal.run"
  | "terminal.read"
  | "terminal.kill"
  | "terminal.list"
  | "terminal.history"
  | "tests.runs"
  | "diagnostics.run"
  | "diagnostics.latest"
  | "diagnostics.runtime"
> = {
  "terminal.run": async (p, ctx) => ({
    run: await needTerminal(ctx).run({
      projectId: p.projectId,
      taskId: p.taskId ?? null,
      command: p.command,
      ...(p.timeoutSeconds ? { timeoutMs: p.timeoutSeconds * 1000 } : {}),
    }),
  }),
  "terminal.read": (p, ctx) => needTerminal(ctx).read(p.runId, p.after ?? 0),
  "terminal.kill": async (p, ctx) => ({ killed: await needTerminal(ctx).kill(p.runId) }),
  "terminal.list": (p, ctx) => ({ runs: needTerminal(ctx).list(p.projectId, p.limit ?? 30) }),
  "terminal.history": (p, ctx) => ({ commands: needTerminal(ctx).history(p.projectId) }),
  "tests.runs": (p, ctx) => ({ runs: needTerminal(ctx).tests(p.projectId, p.taskId ?? null, p.limit ?? 30) }),
  "diagnostics.run": async (p, ctx) => ({
    result: await needDiagnostics(ctx).run({ projectId: p.projectId, taskId: p.taskId ?? null, by: "user" }),
  }),
  "diagnostics.latest": (p, ctx) => ({ result: needDiagnostics(ctx).latest(p.projectId, p.taskId ?? null) }),
  "diagnostics.runtime": (p, ctx) => ({
    problems: needDiagnostics(ctx).runtime(p.projectId, p.taskId ?? null),
  }),
};

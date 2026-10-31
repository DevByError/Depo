import type { ToolDefinition } from "@depo/model-gateway";
import { type JsonValue, newId } from "@depo/shared";
import { z } from "zod";
import type { ApprovalCenter } from "../approvals";
import type { EventBus } from "../events/bus";
import { deleteFileTool, editFileTool, listDirTool, readFileTool, writeFileTool } from "./fs-tools";
import { gitDiff, gitStatus, isGitRepo } from "./git";
import { ToolError } from "./paths";
import { findFilesTool, searchTool } from "./search";
import { classifyCommand } from "./shell/policy";
import { runShell } from "./shell/run";

export { ToolError } from "./paths";

/** Everything a tool call needs: where it may act and whom to tell. */
export interface ToolContext {
  /** The folder the agent works in (the shadow workspace). */
  root: string;
  bus: EventBus;
  approvals: ApprovalCenter;
  projectId: string | null;
  taskId: string | null;
  agent: string;
  signal?: AbortSignal;
  /** Called after a file is created, changed or deleted. */
  onFileChanged?: (path: string) => void;
  /** Extra environment for commands (e.g. the project's virtual environment). */
  env?: Record<string, string>;
}

export interface ToolResult {
  /** What the model sees. */
  content: string;
  isError: boolean;
}

interface AgentTool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

function tool<S extends z.ZodType>(t: AgentTool<S>): AgentTool<z.ZodType> {
  return t as unknown as AgentTool<z.ZodType>;
}

const MAX_TOOL_OUTPUT = 24_000;

function emit(ctx: ToolContext, e: Omit<Parameters<EventBus["emit"]>[0], "agent">) {
  return ctx.bus.emit({ projectId: ctx.projectId, taskId: ctx.taskId, ...e, agent: ctx.agent });
}

/** Parse common test runner summaries (pytest, jest/vitest, bun, cargo, go). */
export function summarizeTests(output: string): { passed: number; failed: number; text: string } | null {
  // pytest, with or without -q: "1 failed, 1 passed in 0.01s" (optionally framed by =====)
  const pyLine = output
    .split("\n")
    .reverse()
    .find((l) => /\d+ (passed|failed|errors?)\b.* in [\d.]+s/.test(l));
  if (pyLine) {
    const passed = Number(pyLine.match(/(\d+) passed/)?.[1] ?? 0);
    const failed =
      Number(pyLine.match(/(\d+) failed/)?.[1] ?? 0) + Number(pyLine.match(/(\d+) errors?/)?.[1] ?? 0);
    return { passed, failed, text: pyLine.replace(/=+/g, "").trim() };
  }
  const js = output.match(/Tests?:?\s+(?:(\d+) failed[, |]+)?(\d+) passed/);
  if (js) return { passed: Number(js[2]), failed: Number(js[1] ?? 0), text: js[0].trim() };
  const bun = output.match(/(\d+) pass\s+(\d+) fail/);
  if (bun) return { passed: Number(bun[1]), failed: Number(bun[2]), text: `${bun[1]} pass, ${bun[2]} fail` };
  const cargo = output.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (cargo) return { passed: Number(cargo[1]), failed: Number(cargo[2]), text: cargo[0] };
  return null;
}

export const TOOLS: AgentTool<z.ZodType>[] = [
  tool({
    name: "read_file",
    description:
      "Read a text file with line numbers. For large files, read only the lines you need with start_line/end_line.",
    schema: z.object({
      path: z.string().describe("Path relative to the project root"),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    }),
    async run(a, ctx) {
      const r = readFileTool(ctx.root, a.path, a.start_line, a.end_line);
      emit(ctx, {
        type: "reading_file",
        text: `Reading ${r.path}${r.startLine > 1 || r.endLine < r.totalLines ? ` (lines ${r.startLine}–${r.endLine})` : ""}`,
        details: { path: r.path, startLine: r.startLine, endLine: r.endLine, totalLines: r.totalLines },
        status: "succeeded",
      });
      const more =
        r.truncated || r.endLine < r.totalLines
          ? `\n[showing lines ${r.startLine}-${r.endLine} of ${r.totalLines}]`
          : "";
      return `${r.path} (${r.totalLines} lines)\n${r.text}${more}`;
    },
  }),
  tool({
    name: "list_dir",
    description: "List files and folders. Common build and dependency folders are skipped.",
    schema: z.object({ path: z.string().default("."), depth: z.number().int().min(1).max(4).default(2) }),
    async run(a, ctx) {
      const r = listDirTool(ctx.root, a.path, a.depth);
      emit(ctx, {
        type: "reading_file",
        text: `Listing ${a.path === "." ? "project" : a.path}`,
        details: { path: a.path, entries: r.entries.length },
        status: "succeeded",
      });
      return r.entries.map((e) => e.path).join("\n") + (r.truncated ? "\n[list truncated]" : "") || "(empty)";
    },
  }),
  tool({
    name: "find_files",
    description: "Find files by glob pattern, e.g. `**/*.py` or `tests/test_*.py`.",
    schema: z.object({ glob: z.string().min(1) }),
    async run(a, ctx) {
      const r = await findFilesTool(ctx.root, a.glob);
      emit(ctx, {
        type: "searching",
        text: `Finding files ${a.glob}`,
        details: { glob: a.glob, found: r.files.length },
        status: "succeeded",
      });
      return r.files.length
        ? r.files.join("\n") + (r.truncated ? "\n[more results omitted]" : "")
        : "No files match.";
    },
  }),
  tool({
    name: "search",
    description: "Search file contents with a regular expression (or literal text). Returns path:line: text.",
    schema: z.object({
      pattern: z.string().min(1),
      literal: z.boolean().default(false),
      path: z.string().optional(),
      glob: z.string().optional().describe("Only files matching this glob, e.g. `*.py`"),
      case_sensitive: z.boolean().default(true),
    }),
    async run(a, ctx) {
      const t0 = performance.now();
      const r = await searchTool(ctx.root, {
        pattern: a.pattern,
        literal: a.literal,
        ...(a.path ? { path: a.path } : {}),
        ...(a.glob ? { glob: a.glob } : {}),
        caseSensitive: a.case_sensitive,
      });
      emit(ctx, {
        type: "searching",
        text: `Searching for ${JSON.stringify(a.pattern)}: ${r.matches.length}${r.truncated ? "+" : ""} matches`,
        details: { pattern: a.pattern, matches: r.matches.length, engine: r.engine },
        durationMs: Math.round(performance.now() - t0),
        status: "succeeded",
      });
      if (!r.matches.length) return "No matches.";
      return (
        r.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") +
        (r.truncated ? "\n[more matches omitted]" : "")
      );
    },
  }),
  tool({
    name: "write_file",
    description:
      "Create a file or replace its whole content. Prefer edit_file for changes to existing files.",
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    async run(a, ctx) {
      const r = writeFileTool(ctx.root, a.path, a.content);
      ctx.onFileChanged?.(r.path);
      emit(ctx, {
        type: "writing_file",
        text: `${r.created ? "Created" : "Rewrote"} ${r.path}`,
        details: { path: r.path, created: r.created, bytes: r.bytes },
        status: "succeeded",
      });
      return `${r.created ? "Created" : "Wrote"} ${r.path} (${r.bytes} bytes).`;
    },
  }),
  tool({
    name: "edit_file",
    description:
      "Edit a file with search/replace blocks. Each `search` must match the current file text exactly once (copy it from read_file without the line numbers). Use several small edits rather than one large one.",
    schema: z.object({
      path: z.string().min(1),
      edits: z
        .array(
          z.object({ search: z.string().min(1), replace: z.string(), replace_all: z.boolean().optional() }),
        )
        .min(1)
        .max(20),
    }),
    async run(a, ctx) {
      const r = editFileTool(
        ctx.root,
        a.path,
        a.edits.map((e) => ({
          search: e.search,
          replace: e.replace,
          ...(e.replace_all ? { replaceAll: true } : {}),
        })),
      );
      ctx.onFileChanged?.(r.path);
      emit(ctx, {
        type: "editing_file",
        text: `Edited ${r.path} (${r.applied} change${r.applied === 1 ? "" : "s"})`,
        details: { path: r.path, edits: r.applied },
        status: "succeeded",
      });
      return `Applied ${r.applied} edit(s) to ${r.path}.`;
    },
  }),
  tool({
    name: "delete_file",
    description: "Delete one file.",
    schema: z.object({ path: z.string().min(1) }),
    async run(a, ctx) {
      const r = deleteFileTool(ctx.root, a.path);
      ctx.onFileChanged?.(r.path);
      emit(ctx, {
        type: "writing_file",
        text: `Deleted ${r.path}`,
        details: { path: r.path, deleted: true },
        status: "succeeded",
      });
      return `Deleted ${r.path}.`;
    },
  }),
  tool({
    name: "run_command",
    description:
      "Run a shell command in the project folder (cmd.exe on Windows, sh elsewhere) and return its output. Use it to run tests, linters and builds. Installs, network access and unknown programs need the user's approval; destructive commands are refused. No interactive input is possible.",
    schema: z.object({
      command: z.string().min(1).max(4000),
      timeout_seconds: z.number().int().min(1).max(1800).default(300),
    }),
    async run(a, ctx) {
      const verdict = classifyCommand(a.command, ctx.root);
      if (verdict.decision === "deny") {
        emit(ctx, {
          type: "error",
          text: `Refused to run: ${a.command} (${verdict.reason})`,
          details: { command: a.command, reason: verdict.reason },
          status: "failed",
        });
        throw new ToolError(`This command is not allowed: ${verdict.reason}. Find another way.`);
      }
      if (verdict.decision === "ask") {
        const ok = await ctx.approvals.request(
          {
            projectId: ctx.projectId,
            taskId: ctx.taskId,
            agent: ctx.agent,
            kind: "command",
            title: `Run "${a.command}"?`,
            reason: verdict.reason,
            details: { command: a.command, category: verdict.category },
          },
          ctx.signal,
        );
        if (!ok)
          throw new ToolError(
            `The user declined to run "${a.command}". Continue without it or try another approach.`,
          );
      }
      const runId = newId("job");
      const isTest = verdict.category === "test";
      emit(ctx, {
        type: isTest
          ? "testing"
          : verdict.category === "install"
            ? "installing_dependency"
            : "running_command",
        text: isTest ? `Running tests: ${a.command}` : `Running ${a.command}`,
        details: { command: a.command, category: verdict.category, jobId: runId },
        status: "started",
      });
      let pending = "";
      let last = 0;
      const flush = () => {
        if (!pending) return;
        emit(ctx, {
          type: "command_output",
          text: pending.trimEnd().split("\n").slice(-1)[0]?.slice(0, 200) ?? "",
          details: { jobId: runId, chunk: pending.slice(-4000) },
          ephemeral: true,
          status: "running",
        });
        pending = "";
        last = Date.now();
      };
      const res = await runShell({
        command: a.command,
        cwd: ctx.root,
        timeoutMs: a.timeout_seconds * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        memoryLimitBytes: 8 * 1024 ** 3,
        ...(ctx.env ? { env: ctx.env } : {}),
        onOutput: (s) => {
          pending += s;
          if (Date.now() - last > 300) flush();
        },
      });
      pending = "";
      const summary = isTest ? summarizeTests(res.output) : null;
      const ok = res.exitCode === 0;
      const tail = res.output.slice(-MAX_TOOL_OUTPUT);
      const details: Record<string, JsonValue> = {
        command: a.command,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        containment: res.containment,
        jobId: runId,
        outputTail: res.output.slice(-4000),
      };
      if (isTest) {
        emit(ctx, {
          type: "test_result",
          text: summary ? `Tests: ${summary.text}` : ok ? "Tests passed" : "Tests failed",
          details: { ...details, ...(summary ? { passed: summary.passed, failed: summary.failed } : {}) },
          durationMs: res.durationMs,
          status: ok ? "succeeded" : "failed",
        });
      } else {
        emit(ctx, {
          type: "running_command",
          text: `${a.command} ${res.timedOut ? "timed out" : res.cancelled ? "was cancelled" : `exited with ${res.exitCode}`}`,
          details,
          durationMs: res.durationMs,
          status: ok ? "succeeded" : res.cancelled ? "cancelled" : "failed",
        });
      }
      const head = res.timedOut
        ? `Timed out after ${a.timeout_seconds}s.`
        : res.cancelled
          ? "Cancelled."
          : `Exit code ${res.exitCode}.`;
      return `${head}\n${res.output.length > MAX_TOOL_OUTPUT ? "[earlier output omitted]\n" : ""}${tail}`.trimEnd();
    },
  }),
  tool({
    name: "git_status",
    description: "Show which files changed in the working folder compared with git.",
    schema: z.object({}),
    async run(_a, ctx) {
      if (!(await isGitRepo(ctx.root))) return "This folder is not a git repository.";
      const s = await gitStatus(ctx.root);
      return `Branch: ${s.branch ?? "(none)"}\n${s.entries.map((e) => `${e.code} ${e.path}`).join("\n") || "No changes."}`;
    },
  }),
  tool({
    name: "git_diff",
    description: "Show the git diff of the working folder, optionally for some paths.",
    schema: z.object({ paths: z.array(z.string()).default([]) }),
    async run(a, ctx) {
      if (!(await isGitRepo(ctx.root))) return "This folder is not a git repository.";
      const d = await gitDiff(ctx.root, a.paths);
      return d ? d.slice(0, MAX_TOOL_OUTPUT) : "No differences.";
    },
  }),
];

/** Tool definitions in the provider-neutral format the model gateway sends to the model. */
export function toolDefinitions(names?: string[]): ToolDefinition[] {
  return TOOLS.filter((t) => !names || names.includes(t.name)).map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    return { name: t.name, description: t.description, parameters };
  });
}

/**
 * Run one tool call from the model. Never throws: bad arguments, refused commands and tool
 * failures come back as an error result the model can read and react to.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t)
    return {
      content: `Unknown tool "${name}". Available: ${TOOLS.map((x) => x.name).join(", ")}`,
      isError: true,
    };
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
      .join("; ");
    return { content: `Invalid arguments for ${name}: ${issues}`, isError: true };
  }
  try {
    return { content: await t.run(parsed.data, ctx), isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: err.message, isError: true };
    const msg = err instanceof Error ? err.message : String(err);
    emit(ctx, { type: "error", text: `${name} failed: ${msg}`, details: { tool: name }, status: "failed" });
    return { content: `${name} failed: ${msg}`, isError: true };
  }
}

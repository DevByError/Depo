import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@depo/model-gateway";
import { type JsonValue, newId, type SearchHit } from "@depo/shared";
import { z } from "zod";
import type { ApprovalCenter } from "../approvals";
import type { EventBus } from "../events/bus";
import { firstLine, getLogger } from "../logger";
import { readPlaybook } from "../playbooks";
import { deleteFileTool, editFileTool, listDirTool, readFileTool, writeFileTool } from "./fs-tools";
import { gitDiff, gitStatus, isGitRepo } from "./git";
import { ToolError } from "./paths";
import { PREVIEW_TOOLS, type PreviewHooks } from "./preview-tools";
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
  /** Project command rules on top of the built-in policy (prefix match). */
  commandRules?: { allow: string[]; deny: string[] };
  /** Code index and memory of the project, when available. */
  knowledge?: ProjectKnowledge;
  /**
   * Files read (or written) in this task. When set, editing or overwriting an existing file that
   * was not read first is refused: small models otherwise guess the contents and break the file.
   */
  readPaths?: Set<string>;
  /** Tools added for this run only (MCP servers, skills). */
  extraTools?: AgentTool<z.ZodType>[];
  /** Team hooks: the blackboard and agent messages (set when an agent works in a team). */
  team?: TeamHooks;
  /** Ask the vision model about images (base64). Returns null when no vision model is set up. */
  vision?: (prompt: string, images: string[]) => Promise<string | null>;
  /** Called after each test run; may return text to add to what the model sees (lessons learned). */
  onTestResult?: (r: { command: string; passed: boolean; output: string }) => string | undefined;
  /** Start, check and stop the app from the workspace (start_preview, http_check, stop_preview). */
  previews?: PreviewHooks;
}

export interface TeamHooks {
  read(section: string): { content: string; version: number; owner: string } | null;
  list(): { section: string; owner: string; version: number; size: number }[];
  write(section: string, content: string, mode: "replace" | "append"): string;
  send(msg: {
    to: string;
    type: "handoff" | "request" | "review" | "question" | "result" | "blocker";
    summary: string;
    artifacts?: string[];
    criteria?: string[];
    confidence?: number;
  }): string;
}

export interface ProjectKnowledge {
  repoMap(prefix: string): string;
  findSymbols(name: string): SearchHit[];
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]>;
  remember(kind: "fact" | "decision" | "preference", text: string): void;
}

/** Does a project rule (a command prefix) match this command? */
export function matchesRule(command: string, rule: string): boolean {
  const c = command.trim().replace(/\s+/g, " ").toLowerCase();
  const r = rule.trim().replace(/\s+/g, " ").toLowerCase();
  return r.length > 0 && (c === r || c.startsWith(`${r} `));
}

export interface ToolResult {
  /** What the model sees. */
  content: string;
  isError: boolean;
}

export interface AgentTool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** A ready-made JSON Schema for the model (MCP tools bring their own). */
  jsonSchema?: Record<string, unknown>;
  run(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function tool<S extends z.ZodType>(t: AgentTool<S>): AgentTool<z.ZodType> {
  return t as unknown as AgentTool<z.ZodType>;
}

const MAX_TOOL_OUTPUT = 24_000;
const log = getLogger({ component: "tools" });

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
      ctx.readPaths?.add(r.path);
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
      mustHaveRead(ctx, a.path, "replacing");
      const r = writeFileTool(ctx.root, a.path, a.content);
      ctx.readPaths?.add(r.path);
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
      mustHaveRead(ctx, a.path, "editing");
      const r = editFileTool(
        ctx.root,
        a.path,
        a.edits.map((e) => ({
          search: stripLineNumbers(e.search),
          replace: stripLineNumbers(e.replace, e.search),
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
      ctx.readPaths?.add(r.path);
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
      let verdict = classifyCommand(a.command, ctx.root);
      const rules = ctx.commandRules;
      if (rules?.deny.some((r) => matchesRule(a.command, r)))
        verdict = { ...verdict, decision: "deny", reason: "blocked by this project's command rules" };
      else if (verdict.decision === "ask" && rules?.allow.some((r) => matchesRule(a.command, r)))
        verdict = { ...verdict, decision: "allow", reason: "allowed by this project's command rules" };
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
      log[ok || res.cancelled ? "info" : "warn"]("command finished", {
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        command: a.command,
        category: verdict.category,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        durationMs: res.durationMs,
        lastLine: firstLine(res.output.trimEnd().split("\n").at(-1) ?? ""),
      });
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
      const extra =
        isTest && !res.cancelled
          ? ctx.onTestResult?.({ command: a.command, passed: ok, output: res.output })
          : undefined;
      // Lessons go right after the exit code, where they are seen even when the output is long.
      return `${head}\n${extra ? `${extra}\n\n` : ""}${res.output.length > MAX_TOOL_OUTPUT ? "[earlier output omitted]\n" : ""}${tail}`.trimEnd();
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
  tool({
    name: "repo_map",
    description:
      "Show the project's files with their classes, functions and methods (name and line). Use it first to find where things are instead of reading whole files. Optionally limit to a folder.",
    schema: z.object({ folder: z.string().max(300).default("") }),
    async run(a, ctx) {
      const k = needKnowledge(ctx);
      const prefix = a.folder
        .replace(/\\/g, "/")
        .replace(/^\.\/?/, "")
        .replace(/\/?$/, a.folder ? "/" : "");
      const map = k.repoMap(prefix === "/" ? "" : prefix);
      emit(ctx, {
        type: "searching",
        text: `Repo map${a.folder ? ` of ${a.folder}` : ""}`,
        status: "succeeded",
      });
      return (
        map || "The code index is empty (still indexing, or no source files). Use list_dir and find_files."
      );
    },
  }),
  tool({
    name: "find_symbol",
    description: "Find where a class, function, method or type is declared, by name (partial names work).",
    schema: z.object({ name: z.string().min(1).max(200) }),
    async run(a, ctx) {
      const hits = needKnowledge(ctx).findSymbols(a.name);
      emit(ctx, {
        type: "searching",
        text: `Finding symbol ${a.name}`,
        details: { hits: hits.length },
        status: "succeeded",
      });
      if (hits.length === 0) return `No declaration named like "${a.name}". Try search for usages.`;
      return hits
        .map((h) => `${h.path}:${h.startLine}-${h.endLine}  ${h.title}\n    ${h.preview}`)
        .join("\n");
    },
  }),
  tool({
    name: "semantic_search",
    description:
      "Search the code by meaning, e.g. 'where are users authenticated' or 'database connection setup'. Returns the most relevant file ranges. Use search for exact text.",
    schema: z.object({
      query: z.string().min(3).max(300),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    async run(a, ctx) {
      const hits = await needKnowledge(ctx).search(a.query, a.limit, ctx.signal);
      emit(ctx, {
        type: "searching",
        text: `Searching for "${a.query}"`,
        details: { hits: hits.length },
        status: "succeeded",
      });
      if (hits.length === 0)
        return "Nothing found. The index may still be building, or no embedding model is installed; use search instead.";
      return hits
        .map(
          (h) =>
            `${h.path}:${h.startLine}-${h.endLine}  (${h.kind}, ${h.score.toFixed(2)})\n${indent(h.preview)}`,
        )
        .join("\n");
    },
  }),
  tool({
    name: "remember",
    description:
      "Save a lasting fact about this project to its memory (a convention, a decision and why, or a user preference), so future tasks know it. Keep it to one sentence. Do not save things that are obvious from the code.",
    schema: z.object({ kind: z.enum(["fact", "decision", "preference"]), text: z.string().min(5).max(500) }),
    async run(a, ctx) {
      needKnowledge(ctx).remember(a.kind, a.text);
      return "Saved to project memory.";
    },
  }),
  tool({
    name: "read_playbook",
    description:
      "Read Depo's engineering playbooks: concrete, current practice for stacks and tasks (FastAPI, Django, Express, NestJS, Next.js, React, PostgreSQL, MongoDB, Redis, auth, roles, testing, OWASP, performance, accessibility, Docker, docs, local AI). Give a topic to read it, a query to find the best match, or nothing to list the topics.",
    schema: z.object({
      topic: z.string().max(80).optional().describe("Topic id, e.g. fastapi, auth, postgres, or an agent id"),
      query: z.string().max(200).optional().describe("What you need, e.g. 'refresh token rotation'"),
    }),
    async run(a, ctx) {
      const r = readPlaybook(a);
      emit(ctx, {
        type: "searching",
        text: r.found ? `Playbook: ${r.title}` : `Playbook: nothing for "${a.topic ?? a.query ?? ""}"`,
        details: { topic: a.topic ?? null, query: a.query ?? null, found: r.found },
        status: "succeeded",
      });
      return r.text;
    },
  }),
  tool({
    name: "bb_read",
    description:
      "Read a section of the project blackboard (shared notes between agents), e.g. brief.md, options.md, design-system.json, openapi.yaml, decisions.md. Call with no section to list what exists.",
    schema: z.object({ section: z.string().max(200).optional() }),
    async run(a, ctx) {
      const team = needTeam(ctx);
      if (!a.section) {
        const l = team.list();
        return l.length
          ? l.map((e) => `${e.section}  (v${e.version}, by ${e.owner}, ${e.size} chars)`).join("\n")
          : "The blackboard is empty.";
      }
      const e = team.read(a.section);
      if (!e) return `No section named ${a.section}. Call bb_read with no section to list what exists.`;
      return `${a.section} (v${e.version}, by ${e.owner})
${e.content.slice(0, 20_000)}`;
    },
  }),
  tool({
    name: "bb_write",
    description:
      "Write a section of the project blackboard that you own (your output files, e.g. brief.md). Use mode append for decisions.md, which every agent may add to.",
    schema: z.object({
      section: z.string().min(1).max(200),
      content: z.string().min(1).max(60_000),
      mode: z.enum(["replace", "append"]).default("replace"),
    }),
    async run(a, ctx) {
      return needTeam(ctx).write(a.section, a.content, a.mode);
    },
  }),
  tool({
    name: "send_message",
    description:
      "Send a typed message to another agent through the Manager: a handoff (work ready for you), request, question, result, or blocker. Name the recipient by id (e.g. backend, testing) or 'manager'.",
    schema: z.object({
      to: z.string().min(1).max(60),
      type: z.enum(["handoff", "request", "review", "question", "result", "blocker"]),
      summary: z.string().min(1).max(2000),
      artifacts: z.array(z.string().max(300)).max(30).default([]),
      criteria: z.array(z.string().max(300)).max(20).default([]),
      confidence: z.number().min(0).max(1).default(0.7),
    }),
    async run(a, ctx) {
      return needTeam(ctx).send(a);
    },
  }),
];

function needTeam(ctx: ToolContext): TeamHooks {
  if (!ctx.team) throw new ToolError("The blackboard is only available when you work as part of the team.");
  return ctx.team;
}

/** Add tools to the built-in set (later phases register theirs here). A tool with the same name is replaced. */
export function registerTools(...tools: AgentTool<z.ZodType>[]): void {
  for (const t of tools) {
    const i = TOOLS.findIndex((x) => x.name === t.name);
    if (i >= 0) TOOLS[i] = t;
    else TOOLS.push(t);
  }
}

const LINE_NO = /^\s*\d+\s*[│|:]\s?/;

/**
 * Models sometimes copy read_file's line numbers ("  7│ ", "12: ") into search text. When every
 * line of `of` carries one, remove them (from `s`, which is `of` itself or its replacement).
 */
export function stripLineNumbers(s: string, of = s): string {
  const lines = of.split("\n").filter((l) => l.trim());
  if (lines.length === 0 || !lines.every((l) => LINE_NO.test(l))) return s;
  return s
    .split("\n")
    .map((l) => l.replace(LINE_NO, ""))
    .join("\n");
}

function mustHaveRead(ctx: ToolContext, rel: string, what: string): void {
  if (!ctx.readPaths) return;
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (ctx.readPaths.has(norm)) return;
  if (!fs.existsSync(path.join(ctx.root, norm))) return; // a new file needs no reading
  // Small models often ignore "read it first". Show the file right here, so the next try can
  // copy the exact text, and count it as read.
  let shown = "";
  try {
    const r = readFileTool(ctx.root, norm);
    ctx.readPaths.add(r.path);
    shown = `\nHere is the current ${r.path} (${r.totalLines} lines). Copy the exact text you want to change into \`search\`, without the line numbers:\n${r.text}${r.endLine < r.totalLines ? `\n[showing lines 1-${r.endLine}; read_file for the rest]` : ""}`;
  } catch {
    // fall back to the plain refusal
  }
  throw new ToolError(
    `Nothing was changed: you had not read ${norm} before ${what} it in this task.${shown}`,
  );
}

function needKnowledge(ctx: ToolContext): ProjectKnowledge {
  if (!ctx.knowledge)
    throw new ToolError("The code index is not available here. Use list_dir, find_files and search.");
  return ctx.knowledge;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** Tool definitions in the provider-neutral format the model gateway sends to the model. */
export function toolDefinitions(names?: string[], extra: AgentTool<z.ZodType>[] = []): ToolDefinition[] {
  return [...TOOLS, ...extra]
    .filter((t) => !names || names.includes(t.name))
    .map((t) => {
      const { $schema: _s, ...parameters } =
        t.jsonSchema ?? (z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>);
      return { name: t.name, description: t.description, parameters };
    });
}

/**
 * Run one tool call from the model. Never throws: bad arguments, refused commands and tool
 * failures come back as an error result the model can read and react to.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const started = performance.now();
  const res = await runTool(name, rawArgs, ctx);
  const fields = {
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    agent: ctx.agent,
    tool: name,
    ok: !res.isError,
    durationMs: Math.round(performance.now() - started),
    result: firstLine(res.content),
  };
  if (res.isError) log.warn("tool call failed", fields);
  else log.info("tool call", fields);
  return res;
}

async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const all = [...TOOLS, ...(ctx.extraTools ?? [])];
  const t = all.find((x) => x.name === name);
  if (!t)
    return {
      content: `Unknown tool "${name}". Available: ${all.map((x) => x.name).join(", ")}`,
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
    log.error("tool crashed", {
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      agent: ctx.agent,
      tool: name,
      err,
    });
    emit(ctx, { type: "error", text: `${name} failed: ${msg}`, details: { tool: name }, status: "failed" });
    return { content: `${name} failed: ${msg}`, isError: true };
  }
}

// Previews: start the app, smoke-test it over HTTP on 127.0.0.1, stop it.
registerTools(...PREVIEW_TOOLS);

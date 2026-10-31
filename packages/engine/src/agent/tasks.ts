import fs from "node:fs";
import path from "node:path";
import {
  type ChatMessage,
  type ChatResult,
  collectChat,
  ModelGatewayError,
  type ModelProvider,
  PARSE_ERROR,
  type ToolCall,
} from "@depo/model-gateway";
import { type ChatItem, newId, type Task, TaskSchema, type TaskStatus } from "@depo/shared";
import { asc, desc, eq } from "drizzle-orm";
import type { ApprovalCenter } from "../approvals";
import type { AppDb } from "../db";
import { messages, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelManager } from "../models/manager";
import { executeTool, TOOLS, type ToolContext, toolDefinitions } from "../tools/index";
import type { ProjectService, Workspace } from "../workspace/service";
import { codingSystemPrompt, venvEnv } from "./prompt";
import { parseTextToolCalls, stripToolMarkup } from "./textcalls";

export const CODER_AGENT = "coder@1.0.0";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_CONTEXT = 16_384;
/** A model call may be retried this many times after a transient failure. */
const MODEL_RETRIES = 4;
/** Waits between retries grow, so a runtime that is busy (re)loading a model gets about a minute. */
const RETRY_BACKOFF = [1, 3, 8, 15];

export interface TaskManagerOptions {
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  models: Pick<ModelManager, "resolve">;
  projects: ProjectService;
  approvals: ApprovalCenter;
  maxSteps?: number;
  retryDelayMs?: number;
}

/**
 * Runs coding tasks: one agent, one shadow workspace per task, a tool loop until the model
 * stops calling tools, then a change set for review. Follow-up messages continue the same task.
 */
export class TaskManager {
  private readonly running = new Map<string, AbortController>();
  private readonly done = new Map<string, Promise<void>>();
  private readonly log: Logger;

  constructor(private readonly o: TaskManagerOptions) {
    this.log = o.logger.child({ component: "tasks" });
  }

  list(projectId: string): Task[] {
    return this.o.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.createdAt))
      .limit(100)
      .all()
      .map((r) => toTask(r));
  }

  get(id: string): { task: Task; messages: ChatItem[] } {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new Error(`Unknown task: ${id}`);
    const msgs = this.o.db
      .select()
      .from(messages)
      .where(eq(messages.taskId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all();
    const items: ChatItem[] = [];
    for (const m of msgs) {
      const c = JSON.parse(m.content) as ChatMessage & { isError?: boolean };
      if (c.role === "system") continue;
      if (c.role === "tool") {
        items.push({
          id: m.id,
          role: "tool",
          text: c.content.slice(0, 2000),
          toolName: c.name,
          isError: c.isError === true,
          createdAt: m.createdAt,
        });
      } else if (c.role === "assistant") {
        if (c.content.trim())
          items.push({
            id: m.id,
            role: "assistant",
            text: c.content,
            toolName: null,
            isError: c.isError === true,
            createdAt: m.createdAt,
          });
      } else {
        items.push({
          id: m.id,
          role: "user",
          text: c.content,
          toolName: null,
          isError: false,
          createdAt: m.createdAt,
        });
      }
    }
    return { task: toTask(row), messages: items };
  }

  /** Start a new task, or continue an existing one with a follow-up message. */
  send(projectId: string, text: string, taskId?: string): Task {
    const project = this.o.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!fs.existsSync(project.rootPath))
      throw new Error(`The project folder is missing: ${project.rootPath}`);
    const now = new Date().toISOString();
    let id = taskId;
    if (id) {
      const row = this.o.db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!row || row.projectId !== projectId) throw new Error(`Unknown task: ${id}`);
      if (this.running.has(id)) throw new Error("This task is still working. Wait for it or stop it first.");
    } else {
      id = newId("tsk");
      const title = text.trim().split("\n")[0]?.slice(0, 80) ?? "Task";
      this.o.db
        .insert(tasks)
        .values({ id, projectId, title, prompt: text, status: "queued", createdAt: now, updatedAt: now })
        .run();
    }
    this.addMessage(id, { role: "user", content: text });
    this.setStatus(id, "queued");
    const ctl = new AbortController();
    this.running.set(id, ctl);
    const taskId_ = id;
    const run = this.run(taskId_, ctl.signal)
      .catch((err: unknown) => {
        this.log.error("task crashed", { taskId: taskId_, err });
        this.fail(taskId_, projectId, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.running.delete(taskId_);
        this.done.delete(taskId_);
      });
    this.done.set(id, run);
    return this.get(id).task;
  }

  cancel(id: string): boolean {
    const ctl = this.running.get(id);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  /** Resolves when the task's current run has finished (tests). */
  async settled(id: string): Promise<void> {
    await this.done.get(id);
  }

  async cancelAll(): Promise<void> {
    for (const ctl of this.running.values()) ctl.abort();
    await Promise.allSettled([...this.done.values()]);
  }

  // ---- the loop --------------------------------------------------------------------------

  private async run(taskId: string, signal: AbortSignal): Promise<void> {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) return;
    const project = this.o.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
    if (!project) return;
    const emit = (e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) =>
      this.o.bus.emit({ ...e, agent: CODER_AGENT, projectId: project.id, taskId });

    const resolved = this.o.models.resolve("coder");
    if (!resolved) {
      throw new Error(
        "No coding model is set up yet. Open the Models tab, check your hardware and download the suggested coder.",
      );
    }
    const { provider, model } = resolved;
    const contextLength = resolved.contextLength ?? DEFAULT_CONTEXT;
    this.o.db
      .update(tasks)
      .set({ model, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();

    // One shadow workspace per task, reused by follow-up messages.
    let ws: Workspace;
    if (row.workspacePath && fs.existsSync(path.join(row.workspacePath, "manifest.json"))) {
      ws = this.o.projects.loadWorkspace(row.workspacePath);
    } else {
      emit({ type: "planning", text: `Preparing a private copy of ${project.name}`, status: "started" });
      ws = this.o.projects.createWorkspace(project.rootPath, taskId);
      this.o.db.update(tasks).set({ workspacePath: ws.dir }).where(eq(tasks.id, taskId)).run();
    }

    this.setStatus(taskId, "running");
    emit({
      type: "planning",
      text: `Working on: ${row.title}`,
      details: { model, contextLength },
      status: "started",
    });

    const history = this.loadHistory(taskId);
    if (history[0]?.role !== "system") {
      const sys: ChatMessage = {
        role: "system",
        content: codingSystemPrompt({ projectName: project.name, root: ws.root }),
      };
      history.unshift(sys);
      this.addMessage(taskId, sys, "0");
    }

    const ctx: ToolContext = {
      root: ws.root,
      bus: this.o.bus,
      approvals: this.o.approvals,
      projectId: project.id,
      taskId,
      agent: CODER_AGENT,
      signal,
      env: venvEnv(ws.root),
    };
    const tools = toolDefinitions();
    const toolNames = TOOLS.map((t) => t.name);
    const maxSteps = this.o.maxSteps ?? DEFAULT_MAX_STEPS;
    const failures = new Map<string, number>();
    let finalText = "";
    let steps = 0;
    let badOutputs = 0;

    while (steps < maxSteps) {
      if (signal.aborted) break;
      steps++;
      compressHistory(history, contextLength);
      const messageId = newId("msg");
      // Runtimes send nothing while they read the prompt; say so, since it can take minutes.
      emit({
        type: "planning",
        text: `Waiting for ${model} to answer (step ${steps})`,
        details: { jobId: `wait-${taskId}`, step: steps },
        ephemeral: true,
        status: "running",
      });
      let streamed = "";
      let lastEmit = 0;
      const res = await this.chatWithRetry(
        provider,
        { model, messages: history, tools, contextLength, signal },
        (delta) => {
          streamed += delta;
          const now = Date.now();
          if (now - lastEmit > 150) {
            lastEmit = now;
            emit({
              type: "thinking",
              text: lastLine(streamed),
              details: { jobId: messageId, text: streamed.slice(-4000) },
              ephemeral: true,
              status: "running",
            });
          }
        },
        emit,
      );
      emit({
        type: "planning",
        text: "Model answered",
        details: { jobId: `wait-${taskId}`, clear: true },
        ephemeral: true,
        status: "succeeded",
      });
      if (res === null) break; // cancelled
      if ("badOutput" in res) {
        // The runtime could not read the model's reply (usually a broken tool call). Tell the model
        // and let it try again, unless it keeps happening.
        badOutputs++;
        if (badOutputs >= 3) throw new Error(`${res.badOutput} This happened 3 times in a row.`);
        emit({
          type: "retrying",
          text: `${res.badOutput} Asking the model to try again.`,
          status: "running",
        });
        history.push({
          role: "user",
          content:
            "Your last reply could not be read: the tool call was malformed or cut off. Reply again and make exactly one complete, valid tool call.",
        });
        continue;
      }
      badOutputs = 0;
      let calls: ToolCall[] = res.toolCalls;
      if (calls.length === 0) calls = parseTextToolCalls(res.text, toolNames);
      if (calls.length === 0) res.text = stripToolMarkup(res.text);
      const assistant: ChatMessage = {
        role: "assistant",
        content: res.text,
        ...(calls.length ? { toolCalls: calls } : {}),
      };
      history.push(assistant);
      this.addMessage(taskId, assistant);
      if (res.text.trim()) {
        emit({
          type: "thinking",
          text: lastLine(res.text),
          details: { jobId: messageId, text: res.text.slice(-4000) },
          status: "info",
        });
      }
      if (calls.length === 0) {
        finalText = res.text.trim();
        break;
      }
      for (const call of calls) {
        if (signal.aborted) break;
        const result = await executeTool(call.name, call.arguments, ctx);
        let content = result.content;
        if (result.isError) {
          const key = `${call.name}:${call.rawArguments}`;
          const n = (failures.get(key) ?? 0) + 1;
          failures.set(key, n);
          if (n >= 3) content += "\nThis exact call has failed 3 times. Try a different approach.";
        }
        const toolMsg: ChatMessage & { isError?: boolean } = {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        };
        history.push(toolMsg);
        this.addMessage(taskId, { ...toolMsg, ...(result.isError ? { isError: true } : {}) } as ChatMessage);
      }
    }

    if (signal.aborted) {
      this.setStatus(taskId, "cancelled");
      emit({ type: "info", text: "Stopped by the user", status: "cancelled" });
      this.finishChanges(project.id, taskId, ws, row.title, emit, () => "cancelled");
      return;
    }
    if (!finalText) {
      finalText = `I stopped after ${maxSteps} steps without finishing. The changes so far are ready for review; send a follow-up message to continue.`;
      this.addMessage(taskId, { role: "assistant", content: finalText });
    }
    this.o.db
      .update(tasks)
      .set({ summary: finalText.slice(0, 4000), updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    this.finishChanges(project.id, taskId, ws, row.title, emit, (cs) => (cs ? "review" : "done"));
  }

  private finishChanges(
    projectId: string,
    taskId: string,
    ws: Workspace,
    title: string,
    emit: (e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) => unknown,
    statusFor: (cs: unknown) => TaskStatus,
  ) {
    const cs = this.o.projects.collectChanges(projectId, taskId, ws, title);
    // Set the final status before the handoff event, so a UI refreshing on that event sees it.
    this.setStatus(taskId, statusFor(cs));
    if (cs) {
      const add = cs.files.reduce((n, f) => n + f.additions, 0);
      const del = cs.files.reduce((n, f) => n + f.deletions, 0);
      emit({
        type: "handoff",
        text: `Changes ready for review: ${cs.files.length} file${cs.files.length === 1 ? "" : "s"} (+${add} −${del})`,
        details: { changeSetId: cs.id, files: cs.files.map((f) => f.path) },
        status: "succeeded",
      });
    } else {
      emit({ type: "handoff", text: "Finished with no file changes", status: "succeeded" });
    }
    return cs;
  }

  private async chatWithRetry(
    provider: ModelProvider,
    req: Parameters<ModelProvider["chat"]>[0],
    onText: (d: string) => void,
    emit: (e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) => unknown,
  ): Promise<ChatResult | { badOutput: string } | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await collectChat(provider.chat(req), onText);
      } catch (err) {
        if (err instanceof ModelGatewayError && err.kind === "cancelled") return null;
        if (isBadModelOutput(err)) {
          // Sampling is random, so a plain retry often succeeds; after that, the loop nudges the model.
          if (attempt < 1) continue;
          return { badOutput: (err as Error).message };
        }
        const transient =
          err instanceof ModelGatewayError &&
          (err.kind === "timeout" ||
            err.kind === "unreachable" ||
            (err.kind === "http" && (err.status ?? 0) >= 500));
        if (!transient || attempt >= MODEL_RETRIES) throw err;
        emit({
          type: "retrying",
          text: `${(err as Error).message} Retrying…`,
          details: { attempt: attempt + 1 },
          status: "running",
        });
        await Bun.sleep(this.o.retryDelayMs ?? (RETRY_BACKOFF[attempt] ?? 15) * 1000);
        if (req.signal?.aborted) return null;
      }
    }
  }

  // ---- persistence -----------------------------------------------------------------------

  private loadHistory(taskId: string): ChatMessage[] {
    return this.o.db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all()
      .map((m) => {
        const { isError: _e, ...c } = JSON.parse(m.content) as ChatMessage & { isError?: boolean };
        return c as ChatMessage;
      });
  }

  private addMessage(taskId: string, msg: ChatMessage, at?: string) {
    const now = new Date().toISOString();
    this.o.db
      .insert(messages)
      .values({
        id: newId("msg"),
        taskId,
        role: msg.role,
        content: JSON.stringify(msg),
        createdAt: at ?? now,
        updatedAt: now,
      })
      .run();
  }

  private setStatus(taskId: string, status: TaskStatus) {
    this.o.db
      .update(tasks)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
  }

  private fail(taskId: string, projectId: string, message: string) {
    this.o.db
      .update(tasks)
      .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    this.addMessage(taskId, { role: "assistant", content: message, isError: true } as ChatMessage);
    this.o.bus.emit({
      agent: CODER_AGENT,
      projectId,
      taskId,
      type: "error",
      text: message,
      status: "failed",
    });
  }
}

function toTask(r: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    prompt: r.prompt,
    status: r.status,
    model: r.model,
    summary: r.summary,
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

function lastLine(s: string): string {
  const lines = s
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  return (lines.at(-1) ?? "").slice(0, 200);
}

/**
 * Keep the conversation inside the model's context window: old tool outputs are trimmed first
 * (the model can re-read files), then the oldest exchanges after the first request are dropped.
 */
export function compressHistory(history: ChatMessage[], contextLength: number): void {
  const budget = contextLength * 0.7 * 3.5; // ~3.5 characters per token
  const size = () =>
    history.reduce(
      (n, m) =>
        n + m.content.length + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0),
      0,
    );
  if (size() <= budget) return;
  const keepTail = 6;
  for (let i = 0; i < history.length - keepTail && size() > budget; i++) {
    const m = history[i];
    if (m?.role === "tool" && m.content.length > 400) {
      history[i] = {
        ...m,
        content: `${m.content.slice(0, 300)}\n[older output trimmed to save context; read the file again if needed]`,
      };
    }
  }
  // Still too large: drop whole assistant+tool exchanges after the system prompt and first user message.
  while (size() > budget && history.length > keepTail + 2) {
    const idx = history.findIndex((m, i) => i >= 2 && m.role === "assistant");
    if (idx < 0 || idx >= history.length - keepTail) break;
    let end = idx + 1;
    while (end < history.length && history[end]?.role === "tool") end++;
    history.splice(idx, end - idx);
  }
}

/** The runtime rejected the model's own output (e.g. a malformed tool call), as opposed to failing. */
export function isBadModelOutput(err: unknown): boolean {
  if (!(err instanceof ModelGatewayError)) return false;
  if (err.kind === "invalid_output") return true;
  return err.kind === "http" && PARSE_ERROR.test(`${err.message} ${err.detail ?? ""}`);
}

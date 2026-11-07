import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@depo/model-gateway";
import {
  type ChatItem,
  newId,
  PlanSchema,
  type ProjectSettings,
  type Task,
  TaskSchema,
  type TaskStatus,
  type WorkMode,
  WorkModeSchema,
} from "@depo/shared";
import { asc, desc, eq, inArray } from "drizzle-orm";
import "../tools/block-tools";
import "../tools/design-tools";
import { Blackboard } from "../agents/blackboard";
import { agentTag } from "../agents/manifests";
import { agentStatuses, TeamRunner } from "../agents/team";
import type { ApprovalCenter } from "../approvals";
import type { CodeIndexer } from "../codeindex/indexer";
import type { AppDb } from "../db";
import { messages, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import { type Logger, withLogContext } from "../logger";
import type { MemoryStore } from "../memory/store";
import type { ModelManager } from "../models/manager";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { SettingsRepo } from "../settings";
import { TOOLS, type ToolContext } from "../tools/index";
import type { ProjectService, Workspace } from "../workspace/service";
import { runAgentLoop } from "./loop";
import { codingSystemPrompt, venvEnv } from "./prompt";

export const CODER_AGENT = "coder@1.0.0";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_CONTEXT = 16_384;

export interface TaskManagerOptions {
  settings?: SettingsRepo;
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  models: Pick<ModelManager, "resolve">;
  projects: ProjectService;
  approvals: ApprovalCenter;
  memory?: MemoryStore;
  scheduler?: ModelScheduler;
  indexer?: CodeIndexer;
  projectSettings?: (projectId: string) => ProjectSettings;
  maxSteps?: number;
  retryDelayMs?: number;
  /** Skills and MCP tools for team agents (Phase 5). */
  extras?: NonNullable<ConstructorParameters<typeof TeamRunner>[0]["extras"]>;
  /** Active agent manifests from the Agent Lab (Phase 7). */
  manifest?: ConstructorParameters<typeof TeamRunner>[0]["manifest"];
}

/** Budgets (characters) for what is added to the system prompt. */
const MEMORY_BUDGET = 5000;
const REPO_MAP_BUDGET = 3500;

/**
 * Runs coding tasks: one agent, one shadow workspace per task, a tool loop until the model
 * stops calling tools, then a change set for review. Follow-up messages continue the same task.
 */
export class TaskManager {
  private readonly running = new Map<string, AbortController>();
  private readonly done = new Map<string, Promise<void>>();
  private readonly log: Logger;
  readonly blackboard: Blackboard;
  private readonly team: TeamRunner;

  constructor(private readonly o: TaskManagerOptions) {
    this.log = o.logger.child({ component: "tasks" });
    this.blackboard = new Blackboard(o.db);
    this.team = new TeamRunner({
      db: o.db,
      bus: o.bus,
      logger: this.log,
      models: o.models,
      approvals: o.approvals,
      scheduler: o.scheduler,
      blackboard: this.blackboard,
      retryDelayMs: o.retryDelayMs,
      maxSteps: o.maxSteps,
      options: () => this.teamOptions(),
      projectSettings: (id) => o.projectSettings?.(id),
      addMessage: (taskId, msg, agent) => this.addMessage(taskId, msg as ChatMessage, undefined, agent),
      knowledge: (id) => this.knowledge(id),
      lessons: (id) => this.lessonTracker(id),
      memoryContext: (id) => o.memory?.contextFor(id, MEMORY_BUDGET).trim() ?? "",
      repoMap: (id) => o.indexer?.repoMap(id, REPO_MAP_BUDGET).trim() ?? "",
      ...(o.extras ? { extras: o.extras } : {}),
      manifest: o.manifest,
    });
  }

  /** Skills, MCP tools and knowledge for the single coding agent. */
  private coderExtras(projectId: string, taskId: string, signal: AbortSignal) {
    return this.o.extras?.("coder", projectId, { taskId, signal });
  }

  private teamOptions() {
    const st = this.o.settings;
    const num = (k: string, d: number) => {
      const v = st?.get(k);
      return typeof v === "number" && v >= 1 ? Math.floor(v) : d;
    };
    const reviews = st?.get("team.reviews");
    return {
      approvePlan: st?.get("team.approve_plan") !== false,
      reviews: (reviews === "key" || reviews === "off" ? reviews : "all") as "all" | "key" | "off",
      fixLoops: num("team.fix_loops", 5),
      parallel: num("team.parallel", 2),
      exportDocs: st?.get("team.export_docs") !== false,
    };
  }

  /** The private workspace folder of a task, when it still exists. */
  workspaceRoot(taskId: string): string | null {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row?.workspacePath || !fs.existsSync(path.join(row.workspacePath, "manifest.json"))) return null;
    return this.o.projects.loadWorkspace(row.workspacePath).root;
  }

  /** The agent team's view of a task: plan, board states and typed messages. */
  teamState(taskId: string) {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    const plan = row.plan ? PlanSchema.safeParse(JSON.parse(row.plan)) : null;
    const waiting = new Set(
      this.o.approvals
        .list()
        .filter((a) => a.taskId === taskId)
        .map((a) => a.agent.split("@")[0] ?? ""),
    );
    return {
      mode: WorkModeSchema.catch("single").parse(row.mode),
      plan: plan?.success ? plan.data : null,
      agents: agentStatuses(plan?.success ? plan.data : null, waiting),
      messages: this.blackboard.messages(taskId),
    };
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

  /**
   * Tasks left "working" by an engine that stopped (crash, closed window, taskkill) can never
   * finish: mark them stopped so they leave the Running list. A follow-up message resumes them.
   */
  recoverInterrupted(): number {
    const stale = this.o.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running", "waiting"]))
      .all()
      .filter((t) => !this.running.has(t.id));
    for (const t of stale) {
      this.setStatus(t.id, "cancelled");
      this.addMessage(t.id, {
        role: "assistant",
        content:
          "Depo was closed while this task was working, so it stopped here. Send a follow-up message to continue.",
        isError: true,
      } as ChatMessage);
      this.o.bus.emit({
        agent: CODER_AGENT,
        projectId: t.projectId,
        taskId: t.id,
        type: "info",
        text: "Stopped: Depo was closed while this task was working",
        status: "cancelled",
      });
    }
    return stale.length;
  }

  /** Tasks that are queued, running or waiting for approval, across every project. */
  active(): Task[] {
    return this.o.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running", "waiting"]))
      .orderBy(desc(tasks.updatedAt))
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
      const c = JSON.parse(m.content) as ChatMessage & { isError?: boolean; agent?: string };
      if (c.role === "system") continue;
      if (c.role === "tool") {
        items.push({
          id: m.id,
          role: "tool",
          text: c.content.slice(0, 2000),
          toolName: c.name,
          isError: c.isError === true,
          agent: c.agent ?? null,
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
            agent: c.agent ?? null,
            createdAt: m.createdAt,
          });
      } else {
        items.push({
          id: m.id,
          role: "user",
          text: c.content,
          toolName: null,
          isError: false,
          agent: null,
          createdAt: m.createdAt,
        });
      }
    }
    return { task: toTask(row), messages: items };
  }

  /** Start a new task, or continue an existing one with a follow-up message. */
  send(projectId: string, text: string, taskId?: string, mode?: WorkMode): Task {
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
      if (mode && mode !== row.mode) {
        this.o.db.update(tasks).set({ mode }).where(eq(tasks.id, id)).run();
      }
    } else {
      id = newId("tsk");
      const title = text.trim().split("\n")[0]?.slice(0, 80) ?? "Task";
      this.o.db
        .insert(tasks)
        .values({
          id,
          projectId,
          title,
          prompt: text,
          status: "queued",
          mode: mode ?? "single",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    this.addMessage(id, { role: "user", content: text });
    this.setStatus(id, "queued");
    const ctl = new AbortController();
    this.running.set(id, ctl);
    const taskId_ = id;
    const started = performance.now();
    this.log.info(taskId ? "task continued" : "task started", { taskId: id, projectId, mode: mode ?? null });
    // Everything logged while the task runs carries its id and project.
    const run = withLogContext({ taskId: taskId_, projectId }, () => this.run(taskId_, ctl.signal))
      .catch((err: unknown) => {
        this.log.error("task crashed", { taskId: taskId_, err });
        this.fail(taskId_, projectId, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.running.delete(taskId_);
        this.done.delete(taskId_);
        const status = this.o.db.select().from(tasks).where(eq(tasks.id, taskId_)).get()?.status ?? null;
        this.log[status === "failed" ? "warn" : "info"]("task finished", {
          taskId: taskId_,
          projectId,
          status,
          durationMs: Math.round(performance.now() - started),
        });
      });
    this.done.set(id, run);
    return this.get(id).task;
  }

  cancel(id: string): boolean {
    const ctl = this.running.get(id);
    if (ctl) {
      ctl.abort();
      return true;
    }
    // Not running in this engine but still marked as working (left over from a stopped engine).
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row || !["queued", "running", "waiting"].includes(row.status)) return false;
    this.setStatus(id, "cancelled");
    this.o.bus.emit({
      agent: CODER_AGENT,
      projectId: row.projectId,
      taskId: id,
      type: "info",
      text: "Stopped by the user",
      status: "cancelled",
    });
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
    if (row.mode !== "single") {
      await this.runTeam(row, project, ws, signal);
      return;
    }
    emit({
      type: "planning",
      text: `Working on: ${row.title}`,
      details: { model, contextLength },
      status: "started",
    });

    const settings = this.o.projectSettings?.(project.id);
    this.o.indexer?.ensure(project.id);
    const history = this.loadHistory(taskId);
    // The system prompt is rebuilt on every run so it carries the latest memory and repo map.
    const sys: ChatMessage = {
      role: "system",
      content: this.systemPrompt(project.id, project.name, ws.root),
    };
    if (history[0]?.role !== "system") {
      history.unshift(sys);
      this.addMessage(taskId, { role: "system", content: "(system prompt, rebuilt for each run)" }, "0");
    } else {
      history[0] = sys;
    }

    const lessons = this.lessonTracker(project.id);
    const extras = this.coderExtras(project.id, taskId, signal);
    if (extras?.prompt && history[0]?.role === "system") history[0].content += `\n\n${extras.prompt}`;
    const ctx: ToolContext = {
      root: ws.root,
      bus: this.o.bus,
      approvals: this.o.approvals,
      projectId: project.id,
      taskId,
      agent: CODER_AGENT,
      signal,
      env: venvEnv(ws.root),
      ...(settings ? { commandRules: { allow: settings.commandAllow, deny: settings.commandDeny } } : {}),
      ...(this.knowledge(project.id) ? { knowledge: this.knowledge(project.id) } : {}),
      readPaths: new Set<string>(),
      ...(extras?.tools.length ? { extraTools: extras.tools } : {}),
    };
    const maxSteps = this.o.maxSteps ?? settings?.maxSteps ?? DEFAULT_MAX_STEPS;
    const result = await runAgentLoop({
      provider,
      model,
      contextLength,
      history,
      toolNames: [...TOOLS.map((t) => t.name), ...(extras?.allow ?? [])],
      ctx,
      maxSteps,
      signal,
      scheduler: this.o.scheduler,
      job: { projectId: project.id, taskId, label: row.title },
      retryDelayMs: this.o.retryDelayMs,
      emit,
      persist: (m) => this.addMessage(taskId, m as ChatMessage),
      lessons,
    });
    let finalText = result.finalText;

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

  /** Team modes: the Manager plans, the agents work through the task graph, reviewers sign off. */
  private async runTeam(
    row: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    ws: Workspace,
    signal: AbortSignal,
  ): Promise<void> {
    const taskId = row.id;
    const mode = WorkModeSchema.parse(row.mode) as Exclude<WorkMode, "single">;
    const emit = (e: Omit<Parameters<EventBus["emit"]>[0], "agent" | "projectId" | "taskId">) =>
      this.o.bus.emit({ ...e, agent: agentTag("manager"), projectId: project.id, taskId });
    // The newest user message is the request; earlier ones stay in the blackboard and transcript.
    const lastUser = [...this.get(taskId).messages].reverse().find((m) => m.role === "user");
    this.o.indexer?.ensure(project.id);
    emit({ type: "planning", text: `Team mode "${mode}": ${row.title}`, status: "started" });
    const res = await this.team.run({
      taskId,
      projectId: project.id,
      projectName: project.name,
      text: lastUser?.text ?? row.prompt,
      mode,
      ws,
      signal,
    });
    if (signal.aborted) {
      this.setStatus(taskId, "cancelled");
      emit({ type: "info", text: "Stopped by the user", status: "cancelled" });
      this.finishChanges(project.id, taskId, ws, row.title, emit, () => "cancelled");
      return;
    }
    this.addMessage(taskId, { role: "assistant", content: res.finalText }, undefined, agentTag("manager"));
    this.o.db
      .update(tasks)
      .set({ summary: res.finalText.slice(0, 4000), updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    if (res.declined) {
      this.setStatus(taskId, "done");
      emit({ type: "handoff", text: "Plan declined: nothing was built", status: "cancelled" });
      return;
    }
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

  // ---- memory, index and lessons ---------------------------------------------------------

  private systemPrompt(projectId: string, projectName: string, root: string): string {
    const parts = [codingSystemPrompt({ projectName, root })];
    const memory = this.o.memory?.contextFor(projectId, MEMORY_BUDGET).trim();
    if (memory) parts.push(`# What you know about this project\n${memory}`);
    const map = this.o.indexer?.repoMap(projectId, REPO_MAP_BUDGET).trim();
    if (map) {
      parts.push(
        `# Repo map (files and their main symbols; use repo_map, find_symbol and semantic_search for more)\n${map}`,
      );
    }
    if (this.o.memory) {
      parts.push(
        "When you learn something lasting about this project (a convention, a decision, a user preference), save it with the remember tool.",
      );
    }
    return parts.join("\n\n");
  }

  private knowledge(projectId: string): ToolContext["knowledge"] | undefined {
    const { indexer, memory } = this.o;
    if (!indexer && !memory) return undefined;
    return {
      repoMap: (prefix) => indexer?.repoMap(projectId, 6000, prefix) ?? "",
      findSymbols: (name) => indexer?.findSymbols(projectId, name) ?? [],
      search: (query, limit, signal) =>
        indexer?.search(projectId, query, limit, signal) ?? Promise.resolve([]),
      remember: (kind, text) => {
        if (!memory) throw new Error("Memory is not available here.");
        memory.add(projectId, kind, text, "agent");
      },
    };
  }

  /**
   * Lessons learned: when tests fail, show fixes that worked before for the same error; when
   * they pass again, store what changed in between as a new lesson.
   */
  private lessonTracker(projectId: string) {
    const memory = this.o.memory;
    let failure: string | null = null;
    const touched = new Set<string>();
    return {
      onCall: (name: string, args: Record<string, unknown>) => {
        if (failure && (name === "edit_file" || name === "write_file") && typeof args.path === "string")
          touched.add(args.path);
      },
      onTest: (r: { passed: boolean; output: string }): string | undefined => {
        if (!memory) return undefined;
        if (!r.passed) {
          if (!failure) touched.clear();
          failure = r.output;
          const found = memory.findLessons(projectId, r.output);
          if (!found.length) return undefined;
          return `Lessons from earlier fixes of a similar error:\n${found.map((f) => `- ${f.text}`).join("\n")}`;
        }
        if (failure && touched.size > 0) {
          memory.recordLesson(
            projectId,
            failure,
            `fixed by changing ${[...touched].slice(0, 6).join(", ")}.`,
          );
        }
        failure = null;
        touched.clear();
        return undefined;
      },
    };
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

  /** Strictly increasing timestamps, so messages written in the same millisecond keep their order. */
  private lastStamp = 0;
  private stamp(): string {
    let t = Date.now();
    if (t <= this.lastStamp) t = this.lastStamp + 1;
    this.lastStamp = t;
    return new Date(t).toISOString();
  }

  private addMessage(taskId: string, msg: ChatMessage, at?: string, agent?: string) {
    const now = this.stamp();
    this.o.db
      .insert(messages)
      .values({
        id: newId("msg"),
        taskId,
        role: msg.role,
        content: JSON.stringify(agent ? { ...msg, agent } : msg),
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
    mode: r.mode,
    model: r.model,
    summary: r.summary,
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export { compressHistory, isBadModelOutput } from "./loop";

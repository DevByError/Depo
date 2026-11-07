import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@depo/model-gateway";
import {
  type ChatItem,
  type JsonValue,
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
import type { EtaService } from "../agents/eta";
import { agentTag, manifestOf } from "../agents/manifests";
import { agentStatuses, TeamRunner } from "../agents/team";
import { buildTimeline, loadTeamEvents, loadTimelineEvents } from "../agents/timeline";
import type { ApprovalCenter } from "../approvals";
import type { CodeIndexer } from "../codeindex/indexer";
import type { AppDb } from "../db";
import { messages, projects, tasks } from "../db/schema";
import type { EventBus } from "../events/bus";
import { type Logger, withLogContext } from "../logger";
import { AutoMemory } from "../memory/auto";
import type { MemoryStore } from "../memory/store";
import type { ModelManager } from "../models/manager";
import { ReviewStore } from "../review/comments";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { SettingsRepo } from "../settings";
import { TOOLS, type ToolContext } from "../tools/index";
import type { PreviewHooks } from "../tools/preview-tools";
import type { ProjectService, Workspace } from "../workspace/service";
import { runAgentLoop } from "./loop";
import { codingSystemPrompt, venvEnv } from "./prompt";
import { SteerInbox, type StoredNote, steerPrompt } from "./steer";

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
  /** Previews of the app agents build (start_preview, http_check, stop_preview). */
  previews?: PreviewHooks;
  /** Time estimates learned on this PC (team.eta, the plan approval message). */
  eta?: EtaService;
}

/** Budgets (characters) for what is added to the system prompt. */
const MEMORY_BUDGET = 5000;
const REPO_MAP_BUDGET = 3500;

/** Small contexts (8k) get smaller memory and repo map blocks, so the conversation still fits. */
export function promptBudgets(contextLength: number): { memory: number; repoMap: number } {
  return contextLength <= 8192
    ? { memory: 2000, repoMap: 1500 }
    : { memory: MEMORY_BUDGET, repoMap: REPO_MAP_BUDGET };
}

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
  /** Remembers what finished tasks taught (memory.auto); null without a memory store. */
  readonly autoMemory: AutoMemory | null;
  /** Notes the owner sends while a task works, one inbox per running task (steering). */
  private readonly inboxes = new Map<string, SteerInbox>();
  /** Line comments on change sets and "Request changes" (Diff Review). */
  readonly reviews: ReviewStore;

  constructor(private readonly o: TaskManagerOptions) {
    this.log = o.logger.child({ component: "tasks" });
    this.blackboard = new Blackboard(o.db);
    this.reviews = new ReviewStore({
      db: o.db,
      bus: o.bus,
      changeSet: (id) => o.projects.getChangeSet(id),
      deliver: (taskId, text) => this.steer(taskId, text).delivery,
    });
    this.autoMemory = o.memory
      ? new AutoMemory({
          db: o.db,
          logger: this.log,
          memory: o.memory,
          models: o.models,
          scheduler: o.scheduler,
          enabled: () => o.settings?.get("memory.auto") !== false,
        })
      : null;
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
      memoryContext: (id) => o.memory?.contextFor(id, this.teamBudgets().memory).trim() ?? "",
      repoMap: (id) => o.indexer?.repoMap(id, this.teamBudgets().repoMap).trim() ?? "",
      ...(o.extras ? { extras: o.extras } : {}),
      manifest: o.manifest,
      ...(o.previews ? { previews: o.previews } : {}),
      ...(o.eta ? { eta: o.eta } : {}),
    });
  }

  /** Prompt budgets for team agents, from the coder model's context (the smallest usually). */
  private teamBudgets() {
    return promptBudgets(this.o.models.resolve("coder")?.contextLength ?? DEFAULT_CONTEXT);
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

  /** The Team screen: the plan, each agent's stats and every decision, from the plan and the audit log. */
  teamTimeline(taskId: string) {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    const state = this.teamState(taskId);
    const waiting = new Set(state.agents.filter((a) => a.state === "waiting").map((a) => a.id as string));
    const status = TaskSchema.shape.status.catch("done").parse(row.status);
    const timeline = buildTimeline({
      taskId,
      mode: state.mode,
      status,
      plan: state.plan,
      waiting,
      ...loadTimelineEvents(this.o.db, row.projectId, taskId),
      manifest: (id) => this.o.manifest?.(id) ?? manifestOf(id),
      now: Date.now(),
    });
    return { ...timeline, status };
  }

  /** A page of a task's stored events for the Team screen's replay. */
  teamEvents(taskId: string, after: number | undefined, limit: number) {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    return loadTeamEvents(this.o.db, row.projectId, taskId, { after, limit });
  }

  /** How long the task's work takes on this PC (team.eta). */
  teamEta(taskId: string) {
    if (!this.o.eta) throw new Error("Time estimates are not available in this engine.");
    const state = this.teamState(taskId);
    return this.o.eta.forTask({ taskId, mode: state.mode, plan: state.plan });
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
    // Tool results carry only the call id; the arguments live on the assistant message that made the call.
    const callArgs = new Map<string, Record<string, JsonValue>>();
    for (const m of msgs) {
      const c = JSON.parse(m.content) as ChatMessage & { isError?: boolean; agent?: string };
      if (c.role === "system") continue;
      if (c.role === "tool") {
        const args = callArgs.get(c.toolCallId);
        items.push({
          id: m.id,
          role: "tool",
          text: c.content.slice(0, 2000),
          toolName: c.name,
          isError: c.isError === true,
          agent: c.agent ?? null,
          createdAt: m.createdAt,
          ...(args ? { args } : {}),
        });
      } else if (c.role === "assistant") {
        for (const call of c.toolCalls ?? []) {
          const args = clipArgs(call.arguments);
          if (args) callArgs.set(call.id, args);
        }
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
        const steer = (c as Partial<StoredNote>).steer;
        items.push({
          id: m.id,
          role: "user",
          text: c.content,
          toolName: null,
          isError: false,
          agent: null,
          createdAt: m.createdAt,
          // A note still queued by an engine that has since stopped will never be read.
          ...(steer
            ? {
                steer:
                  steer.state === "queued" && !this.inboxes.has(id) ? { ...steer, state: "dropped" } : steer,
              }
            : {}),
        });
      }
    }
    return { task: toTask(row), messages: items };
  }

  /**
   * Steering: while the task works, the note is queued and read by the agents at their next step;
   * otherwise it is a normal follow-up message that continues the task.
   */
  steer(
    taskId: string,
    text: string,
  ): { delivery: "queued" | "followup"; taskId: string; noteId: string | null } {
    const row = this.o.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    const inbox = this.inboxes.get(taskId);
    if (inbox && this.running.has(taskId)) {
      const note = inbox.add(text.trim());
      this.log.info("steering note queued", { taskId, projectId: row.projectId, noteId: note.id });
      return { delivery: "queued", taskId, noteId: note.id };
    }
    this.send(row.projectId, text, taskId);
    return { delivery: "followup", taskId, noteId: null };
  }

  /**
   * The owner declined an approval and said why: the agent that asked reads the reason at its
   * next step. A declined plan ends the run, so the reason becomes the next turn and the Manager
   * plans again with it.
   */
  noteDecline(req: { taskId: string | null; title: string }, reason: string): void {
    const why = reason.trim();
    if (!req.taskId || !why || !this.running.has(req.taskId)) return;
    this.steer(req.taskId, `Declined: ${req.title.trim().replace(/\?$/, "")}. Reason: ${why}`);
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
    this.launch(id, projectId, taskId ? "task continued" : "task started", mode);
    return this.get(id).task;
  }

  /** Start a run of the task (its newest user message is the request). */
  private launch(id: string, projectId: string, what: string, mode?: WorkMode): void {
    this.setStatus(id, "queued");
    const ctl = new AbortController();
    this.running.set(id, ctl);
    const inbox = new SteerInbox({
      db: this.o.db,
      bus: this.o.bus,
      taskId: id,
      projectId,
      stamp: () => this.stamp(),
    });
    this.inboxes.set(id, inbox);
    const started = performance.now();
    this.log.info(what, { taskId: id, projectId, mode: mode ?? null });
    // Everything logged while the task runs carries its id and project.
    const run = withLogContext({ taskId: id, projectId }, () => this.run(id, ctl.signal))
      .catch((err: unknown) => {
        this.log.error("task crashed", { taskId: id, err });
        this.fail(id, projectId, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.running.delete(id);
        this.done.delete(id);
        this.inboxes.delete(id);
        const status = this.o.db.select().from(tasks).where(eq(tasks.id, id)).get()?.status ?? null;
        this.log[status === "failed" ? "warn" : "info"]("task finished", {
          taskId: id,
          projectId,
          status,
          durationMs: Math.round(performance.now() - started),
        });
        // Notes nobody read: a finished run continues with them; a stopped one marks them unread.
        const followup = (status === "review" || status === "done") && !ctl.signal.aborted && !this.stopping;
        const left = inbox.settle(followup);
        if (followup && left.length > 0) {
          this.log.info("unread notes continue the task", { taskId: id, projectId, notes: left.length });
          this.launch(id, projectId, "task continued with notes");
        }
      });
    this.done.set(id, run);
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

  /** Resolves when the task has finished, including a run that unread notes started (tests). */
  async settled(id: string): Promise<void> {
    for (let run = this.done.get(id); run; run = this.done.get(id)) await run;
  }

  /** Set while the engine stops: no run starts any more. */
  private stopping = false;

  async cancelAll(): Promise<void> {
    this.stopping = true;
    for (const ctl of this.running.values()) ctl.abort();
    await Promise.allSettled([...this.done.values()]);
    await this.autoMemory?.stop();
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
    const request = requestText(row.prompt, history);
    // The system prompt is rebuilt on every run so it carries the latest memory and repo map.
    const sys: ChatMessage = {
      role: "system",
      content: this.systemPrompt(project.id, project.name, ws.root, contextLength, request),
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
      ...(this.o.previews ? { previews: this.o.previews } : {}),
    };
    const maxSteps = this.o.maxSteps ?? settings?.maxSteps ?? DEFAULT_MAX_STEPS;
    const inbox = this.inboxes.get(taskId)?.reader(CODER_AGENT);
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
      inbox,
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
    const cs = this.finishChanges(project.id, taskId, ws, row.title, emit, (c) => (c ? "review" : "done"));
    this.autoMemory?.afterTask({
      projectId: project.id,
      taskId,
      request,
      finalText,
      root: ws.root,
      files: cs?.files ?? [],
    });
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
    // Notes that became the next turn (nobody read them in time) are part of it.
    const lastUser = latestRequest(this.get(taskId).messages);
    this.o.indexer?.ensure(project.id);
    emit({ type: "planning", text: `Team mode "${mode}": ${row.title}`, status: "started" });
    const res = await this.team.run({
      taskId,
      projectId: project.id,
      projectName: project.name,
      // A turn made only of late notes (or a declined plan's reason) keeps the original request.
      text: lastUser
        ? lastUser.fromNotes
          ? `${row.prompt}\n\n${lastUser.text}`
          : lastUser.text
        : row.prompt,
      mode,
      ws,
      signal,
      notes: this.inboxes.get(taskId),
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
    const cs = this.finishChanges(project.id, taskId, ws, row.title, emit, (c) => (c ? "review" : "done"));
    this.autoMemory?.afterTask({
      projectId: project.id,
      taskId,
      request: lastUser?.text ?? row.prompt,
      finalText: res.finalText,
      notes: this.blackboard.read(project.id, "decisions.md")?.content ?? "",
      root: ws.root,
      files: cs?.files ?? [],
    });
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
    // Review comments on the previous version: addressed, outdated, or moved to this one.
    this.reviews.onChangeSet(taskId, cs, this.latestReplies(taskId));
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

  /** What the agents wrote since the newest request (they may say "Addressed: 1, 3"). */
  private latestReplies(taskId: string): string[] {
    const items = this.get(taskId).messages;
    let i = items.length - 1;
    const isRequest = (m: ChatItem | undefined) =>
      m?.role === "user" && (!m.steer || m.steer.state === "followup");
    while (i >= 0 && !isRequest(items[i])) i--;
    return items
      .slice(i + 1)
      .filter((m) => m.role === "assistant" && !m.isError)
      .map((m) => m.text);
  }

  // ---- memory, index and lessons ---------------------------------------------------------

  private systemPrompt(
    projectId: string,
    projectName: string,
    root: string,
    contextLength: number = DEFAULT_CONTEXT,
    request = "",
  ): string {
    const budgets = promptBudgets(contextLength);
    const parts = [codingSystemPrompt({ projectName, root, contextLength, request })];
    const memory = this.o.memory?.contextFor(projectId, budgets.memory).trim();
    if (memory) parts.push(`# What you know about this project\n${memory}`);
    const map = this.o.indexer?.repoMap(projectId, budgets.repoMap).trim();
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
    const out: ChatMessage[] = [];
    for (const m of this.o.db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .all()) {
      const {
        isError: _e,
        steer,
        ...c
      } = JSON.parse(m.content) as ChatMessage & {
        isError?: boolean;
        steer?: StoredNote["steer"];
      };
      // Steering notes: read ones as the agent saw them, ones that became a turn as plain
      // requests; queued and unread notes are not part of the conversation.
      if (steer?.state === "delivered") out.push({ role: "user", content: steerPrompt([c.content]) });
      else if (!steer || steer.state === "followup") out.push(c as ChatMessage);
    }
    return out;
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

/**
 * The newest request in a transcript: the last user message, joined with notes that were sent
 * right before it and became part of the same turn. Notes read during a run are not requests.
 */
export function latestRequest(items: ChatItem[]): { text: string; fromNotes: boolean } | null {
  const isRequest = (m: ChatItem) => m.role === "user" && (!m.steer || m.steer.state === "followup");
  let end = items.length - 1;
  while (end >= 0 && !isRequest(items[end] as ChatItem)) end--;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && isRequest(items[start - 1] as ChatItem)) start--;
  const turn = items.slice(start, end + 1);
  return { text: turn.map((m) => m.text).join("\n\n"), fromNotes: turn.every((m) => !!m.steer) };
}

/** The task's request: the first message, plus the newest follow-up when there is one. */
function requestText(prompt: string, history: ChatMessage[]): string {
  const last = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  return last && last !== prompt ? `${prompt}\n${last}` : prompt;
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

/**
 * A tool call's arguments as JSON the chat can show: an object, long strings clipped, nesting and
 * list lengths capped. Returns null for anything that is not an object (a call that failed to parse).
 */
export function clipArgs(value: unknown, maxString = 4000): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clip = (v: unknown, depth: number): JsonValue => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") return v.length > maxString ? `${v.slice(0, maxString)}\n…` : v;
    if (depth >= 4) return null;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => clip(x, depth + 1));
    if (typeof v === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30))
        out[k] = clip(x, depth + 1);
      return out;
    }
    return null;
  };
  return clip(value, 0) as Record<string, JsonValue>;
}

export { compressHistory, isBadModelOutput } from "./loop";

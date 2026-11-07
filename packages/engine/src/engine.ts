import path from "node:path";
import { AGENT_IDS, type AgentId, DEPO_VERSION, type HeartbeatDetails } from "@depo/shared";
import { eq } from "drizzle-orm";
import { TaskManager } from "./agent/tasks";
import { EtaService } from "./agents/eta";
import { AgentLab } from "./agents/lab";
import { handlers } from "./api/handlers";
import { type ApiServer, startApiServer } from "./api/server";
import { ApprovalCenter } from "./approvals";
import { CodeIndexer } from "./codeindex/indexer";
import { type OpenedDatabase, openDatabase } from "./db";
import { projects as projectsTable, tasks as tasksTable } from "./db/schema";
import { DesignService } from "./design/service";
import { EventBus } from "./events/bus";
import { GitService } from "./git/service";
import { OsvService } from "./knowledge/osv";
import { KnowledgeService } from "./knowledge/service";
import {
  createLogger,
  getDefaultLogger,
  isLogLevel,
  type Logger,
  type LogLevel,
  setDefaultLogger,
} from "./logger";
import { ModelCallStats } from "./logs/model-calls";
import { LogService } from "./logs/service";
import { McpManager } from "./mcp/manager";
import { MemoryStore } from "./memory/store";
import { ModelManager, type ModelManagerOptions } from "./models/manager";
import { type DataDirs, dataDirs, ensureDataDirs } from "./paths";
import { AutoPreview } from "./preview/auto";
import { PreviewManager } from "./preview/manager";
import { ProjectRegistry } from "./projects/registry";
import { QaService, type QaServiceOptions } from "./qa/service";
import { type ReadinessHooks, ReadinessService } from "./readiness/service";
import { ModelScheduler } from "./scheduler/scheduler";
import { SearchService } from "./search/service";
import { SecurityService } from "./security/service";
import { SettingsRepo } from "./settings";
import { SkillService } from "./skills/service";
import { TOOLS } from "./tools/index";
import type { GithubEndpoints } from "./util/github";
import { ProjectService } from "./workspace/service";

export interface EngineOptions {
  dataRoot: string;
  token: string;
  port?: number;
  /** Overrides the `logs.level` setting (DEPO_LOG_LEVEL). */
  logLevel?: LogLevel;
  logToStderr?: boolean;
  /** Test hook: what "Open logs folder" runs. */
  openFolder?: (dir: string) => void;
  /** Overrides the `engine.heartbeat_ms` setting (tests). */
  heartbeatMs?: number;
  /** Test hooks for the model manager (fake hardware, fake providers). */
  models?: Pick<ModelManagerOptions, "profile" | "providerFactory" | "ollamaModelsDir">;
  /** Test hooks for the agent loop. */
  tasks?: { maxSteps?: number; retryDelayMs?: number };
  /** Test hooks for downloads (GitHub archives, OSV dumps). */
  downloads?: { github?: GithubEndpoints; osvBase?: string; updateApi?: string };
  /** Test hook: replaces the git runner used for clones. */
  git?: ConstructorParameters<typeof ProjectRegistry>[0]["git"];
  /** Test hooks for page checks (a fake browser). */
  qa?: Pick<QaServiceOptions, "open" | "axeSource" | "hasBrowser" | "timeoutMs">;
}

export interface Engine {
  readonly dirs: DataDirs;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly settings: SettingsRepo;
  readonly models: ModelManager;
  readonly approvals: ApprovalCenter;
  readonly projects: ProjectService;
  readonly tasks: TaskManager;
  readonly registry: ProjectRegistry;
  readonly memory: MemoryStore;
  readonly scheduler: ModelScheduler;
  readonly indexer: CodeIndexer;
  readonly design: DesignService;
  readonly skills: SkillService;
  readonly mcp: McpManager;
  readonly knowledge: KnowledgeService;
  readonly osv: OsvService;
  readonly security: SecurityService;
  readonly lab: AgentLab;
  readonly logs: LogService;
  readonly previews: PreviewManager;
  readonly search: SearchService;
  readonly git: GitService;
  /** Page checks in a headless browser (check_page, the Preview tab's check). */
  readonly qa: QaService;
  /** Starts a task's private copy when its changes are ready for review. */
  readonly autoPreview: AutoPreview;
  /** The readiness report at review time (readiness.get / readiness.run, the readiness decision). */
  readonly readiness: ReadinessService;
  readonly database: OpenedDatabase;
  start(): Promise<{ port: number }>;
  stop(reason?: string): Promise<void>;
}

const MIN_TOKEN_LENGTH = 32;

/** Composition root: wires paths, logging, database, event bus, API server and heartbeat. */
export function createEngine(opts: EngineOptions): Engine {
  if (opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Engine token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const dirs = dataDirs(opts.dataRoot);
  ensureDataDirs(dirs);
  const logger = createLogger({
    dir: dirs.logs,
    level: opts.logLevel ?? "info",
    stderr: opts.logToStderr ?? false,
  });
  setDefaultLogger(logger);
  const database = openDatabase({
    file: path.join(dirs.db, "depo.db"),
    backupsDir: dirs.backups,
    logger: logger.child({ component: "db" }),
  });
  const bus = new EventBus(database.db, logger.child({ component: "events" }));
  const settings = new SettingsRepo(database.db);
  // Log level: DEPO_LOG_LEVEL wins, else the `logs.level` setting (changes apply at once).
  const levelSetting = settings.get("logs.level");
  if (!opts.logLevel && isLogLevel(levelSetting)) logger.setLevel(levelSetting);
  bus.subscribe((e) => {
    if (e.type !== "settings_changed" || e.details?.key !== "logs.level" || opts.logLevel) return;
    const next = e.details.value;
    if (isLogLevel(next)) {
      logger.setLevel(next);
      logger.info("log level changed", { level: next });
    }
  });
  const callStats = new ModelCallStats();
  const logs = new LogService({
    logger,
    stats: callStats,
    ...(opts.openFolder ? { openFolder: opts.openFolder } : {}),
  });
  const models = new ModelManager({ settings, bus, logger, callStats, ...opts.models });
  const approvals = new ApprovalCenter(bus);
  const projects = new ProjectService(database.db, bus, logger.child({ component: "workspace" }), dirs);
  const memory = new MemoryStore(database.db, bus, dirs.projects);
  const registry = new ProjectRegistry({
    db: database.db,
    bus,
    logger,
    projects,
    memory,
    ...(opts.git ? { git: opts.git } : {}),
  });
  const scheduler = new ModelScheduler({
    bus,
    logger,
    maxParallel: () => {
      const v = settings.get("scheduler.max_parallel");
      return typeof v === "number" && v >= 1 ? Math.floor(v) : 1;
    },
    projectCap: (id) => safeSettings(registry, id)?.maxParallel ?? 1,
    isProjectPaused: (id) => safeSettings(registry, id)?.paused ?? false,
  });
  const embeddings = embeddingSource(models);
  const indexer = new CodeIndexer({
    db: database.db,
    bus,
    logger,
    scheduler,
    embeddings,
    enabled: (id) => safeSettings(registry, id)?.indexEnabled ?? true,
    mapDir: dirs.projects,
  });
  const skills = new SkillService({
    db: database.db,
    bus,
    dir: dirs.skills,
    ...(opts.downloads?.github ? { github: opts.downloads.github } : {}),
    draft: (workflow) => draftSkill(models, workflow),
  });
  const mcp = new McpManager({ db: database.db, bus, approvals });
  const knowledge = new KnowledgeService({
    db: database.db,
    bus,
    dir: dirs.knowledge,
    ...(opts.downloads?.github ? { github: opts.downloads.github } : {}),
  });
  const osv = new OsvService({
    db: database.db,
    bus,
    dir: dirs.knowledge,
    ...(opts.downloads?.osvBase ? { base: opts.downloads.osvBase } : {}),
  });
  const security = new SecurityService({ bus, osv });
  /** Skills, MCP tools, knowledge packs and the OSV check, merged for one agent run. */
  const extras = (agentId: string, projectId: string, run: { taskId: string }) => {
    const parts = [
      skills.extrasFor(agentId, projectId),
      mcp.extrasFor(agentId, projectId, run),
      knowledge.extrasFor(),
      osv.extrasFor(),
      security.extrasFor(agentId),
    ];
    return {
      prompt: parts
        .map((p) => p.prompt)
        .filter(Boolean)
        .join("\n\n"),
      tools: parts.flatMap((p) => p.tools),
      allow: parts.flatMap((p) => p.allow),
    };
  };
  const lab = new AgentLab({
    db: database.sqlite,
    bus,
    models,
    toolNames: () => [
      ...TOOLS.map((t) => t.name),
      "security_status",
      "security_scan",
      "performance_check",
      "check_dependencies",
    ],
    schedule: (label, model, run, signal) =>
      scheduler.run({ projectId: null, taskId: null, model, priority: "task", label }, run, signal),
  });
  /** Previews: the app started from the project folder or a task's private copy. */
  const previews: PreviewManager = new PreviewManager({
    bus,
    approvals,
    logger,
    projectRoot: (id) =>
      database.db
        .select({ root: projectsTable.rootPath })
        .from(projectsTable)
        .where(eq(projectsTable.id, id))
        .get()?.root ?? null,
    workspaceRoot: (id): string | null => tasks.workspaceRoot(id),
    taskProject: (id) =>
      database.db
        .select({ projectId: tasksTable.projectId })
        .from(tasksTable)
        .where(eq(tasksTable.id, id))
        .get()?.projectId ?? null,
    tasks: (id) => tasks.list(id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    override: (id) => safeSettings(registry, id)?.previewCommand ?? "",
    commandRules: (id) => {
      const s = safeSettings(registry, id);
      return s ? { allow: s.commandAllow, deny: s.commandDeny } : null;
    },
  });
  projects.beforeWorkspaceRemoved((dir) => previews.stopRoot(dir));
  /** Time estimates learned on this PC from finished work (team.eta, plan approval message). */
  const eta = new EtaService({
    db: database.db,
    bus,
    logger: logger.child({ component: "eta" }),
    callStats,
    modelFor: (agent) => {
      const role = isAgentId(agent) ? lab.active(agent).role : "coder";
      return (models.resolve(role) ?? models.resolve("coder"))?.model ?? null;
    },
    parallel: () => {
      const v = settings.get("team.parallel");
      return typeof v === "number" && v >= 1 ? Math.floor(v) : 2;
    },
  });
  const taskRow = (id: string) =>
    database.db
      .select({ projectId: tasksTable.projectId, title: tasksTable.title })
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .get();
  const qa: QaService = new QaService({
    bus,
    logger,
    dataDir: path.join(dirs.root, "qa"),
    workspaceRoot: (id): string | null => tasks.workspaceRoot(id),
    taskProject: (id) => taskRow(id)?.projectId ?? null,
    taskTitle: (id) => taskRow(id)?.title ?? null,
    previews,
    models,
    scheduler,
    ...opts.qa,
  });
  const autoPreview = new AutoPreview({
    bus,
    logger,
    previews,
    enabled: () => settings.get("preview.auto_start") !== false,
    changeSetStatus: (id) => {
      try {
        return projects.getChangeSet(id).status;
      } catch {
        return null;
      }
    },
  });
  autoPreview.attach();
  // Late-bound: the readiness service reads the task manager's comments and copies.
  const readinessHooks: ReadinessHooks = {
    atReview: (o) => readiness.atReview(o),
    reviewBrief: (id) => readiness.reviewBrief(id),
    releaseLine: (id, plan) => readiness.releaseLine(id, plan),
  };
  const tasks: TaskManager = new TaskManager({
    readiness: readinessHooks,
    eta,
    previews,
    qa,
    extras,
    manifest: (id) => lab.active(id),
    db: database.db,
    bus,
    logger,
    models,
    projects,
    approvals,
    memory,
    scheduler,
    indexer,
    settings,
    projectSettings: (id) => registry.getSettings(id),
    ...opts.tasks,
  });
  /** One honest verdict at review: tests, checks, scores, page checks, plan, reviews, comments, diff. */
  const readiness: ReadinessService = new ReadinessService({
    db: database.db,
    bus,
    logger,
    approvals,
    workspaceRoot: (id) => tasks.workspaceRoot(id),
    changeSet: (id) => projects.getChangeSet(id),
    comments: (id) => tasks.reviews.list(id),
    memory: (id) => memory.list(id),
    security,
    qa,
    previews,
    autoPreview,
    commandRules: (id) => {
      const s = safeSettings(registry, id);
      return s ? { allow: s.commandAllow, deny: s.commandDeny } : null;
    },
  });
  const design = new DesignService(
    projects,
    (id) => tasks.workspaceRoot(id),
    bus,
    (id) => indexer.map.diagrams(id),
  );
  const projectRoot = (id: string) =>
    database.db
      .select({ root: projectsTable.rootPath })
      .from(projectsTable)
      .where(eq(projectsTable.id, id))
      .get()?.root ?? null;
  /** Ctrl+K: files, symbols, contents, tasks, decisions, memory and logs in one query. */
  const search = new SearchService({ db: database.db, indexer, memory, logs, logger, projectRoot });
  /** Commits for applied change sets (on the owner's click, through the command policy) and history. */
  const git = new GitService({
    projects,
    bus,
    logger,
    models,
    scheduler,
    task: (id) => {
      const t = database.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
      return t ? { title: t.title, prompt: t.prompt, summary: t.summary, mode: t.mode } : null;
    },
    commandRules: (id) => {
      const s = safeSettings(registry, id);
      return s ? { allow: s.commandAllow, deny: s.commandDeny } : null;
    },
  });
  const startedAt = new Date();

  let server: ApiServer | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const beat = () => {
    const mem = process.memoryUsage();
    const details: HeartbeatDetails = {
      uptimeMs: Date.now() - startedAt.getTime(),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      connectedClients: server?.clientCount() ?? 0,
      eventsPersisted: bus.persistedCount,
    };
    bus.emit({
      agent: "engine",
      type: "heartbeat",
      text: "Engine is alive",
      details: { ...details },
      ephemeral: true,
    });
  };

  return {
    dirs,
    logger,
    bus,
    settings,
    models,
    approvals,
    projects,
    tasks,
    registry,
    memory,
    scheduler,
    indexer,
    design,
    skills,
    mcp,
    knowledge,
    osv,
    security,
    lab,
    logs,
    previews,
    search,
    git,
    qa,
    autoPreview,
    readiness,
    database,
    async start() {
      server = startApiServer({
        token: opts.token,
        port: opts.port ?? 0,
        handlers,
        bus,
        logger,
        context: {
          bus,
          settings,
          models,
          approvals,
          projects,
          tasks,
          registry,
          memory,
          scheduler,
          indexer,
          design,
          skills,
          mcp,
          knowledge,
          osv,
          security,
          lab,
          logs,
          previews,
          search,
          git,
          qa,
          readiness,
          ...(opts.downloads?.updateApi ? { updateApi: opts.downloads.updateApi } : {}),
          info: {
            startedAt,
            dataDir: dirs.root,
            dbPath: database.path,
            schemaVersion: database.schemaVersion,
          },
        },
      });
      const recovered = tasks.recoverInterrupted();
      if (recovered) logger.info("stopped tasks left over from the last run", { recovered });
      const configured = settings.get("engine.heartbeat_ms");
      const interval = Math.max(
        250,
        opts.heartbeatMs ?? (typeof configured === "number" ? configured : 2000),
      );
      heartbeat = setInterval(beat, interval);
      bus.emit({
        agent: "engine",
        type: "engine_started",
        text: `Engine ${DEPO_VERSION} started on port ${server.port}`,
        details: {
          version: DEPO_VERSION,
          port: server.port,
          pid: process.pid,
          schemaVersion: database.schemaVersion,
        },
        status: "succeeded",
      });
      logger.info("engine started", { port: server.port, dataRoot: dirs.root });
      return { port: server.port };
    },
    async stop(reason = "shutdown") {
      if (stopped) return;
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      bus.emit({
        agent: "engine",
        type: "engine_stopping",
        text: `Engine stopping (${reason})`,
        details: { reason },
      });
      indexer.stopAll();
      await tasks.cancelAll();
      await readiness.close();
      await qa.close();
      await autoPreview.detach();
      await previews.stopAll();
      await mcp.stopAll();
      await server?.stop();
      database.close();
      logger.info("engine stopped", { reason });
      logger.flush();
      if (getDefaultLogger() === logger) setDefaultLogger(null);
    },
  };
}

function safeSettings(registry: ProjectRegistry, id: string) {
  try {
    return registry.getSettings(id);
  } catch {
    return null;
  }
}

/**
 * The embedding model, only when it is actually installed: an assigned but missing model
 * would make every index pass fail. The installed list is cached for a minute.
 */
function embeddingSource(models: ModelManager) {
  let cache: { at: number; names: Set<string> } | null = null;
  return {
    async embedder() {
      const resolved = models.resolve("embedding");
      if (!resolved) return null;
      if (!cache || Date.now() - cache.at > 60_000) {
        try {
          const list = await models.installed();
          cache = { at: Date.now(), names: new Set(list.map((m) => m.name.replace(/:latest$/, ""))) };
        } catch {
          cache = { at: Date.now(), names: new Set() };
        }
      }
      if (!cache.names.has(resolved.model.replace(/:latest$/, ""))) return null;
      return { provider: resolved.provider, model: resolved.model };
    },
  };
}

/** The Skill Creator: ask the local model to draft a SKILL.md from a described workflow. */
async function draftSkill(models: ModelManager, workflow: string) {
  const r = models.resolve("reasoning") ?? models.resolve("coder");
  if (!r) throw new Error("No model is set up.");
  const { generateObject } = await import("@depo/model-gateway");
  const { z } = await import("zod");
  const out = await generateObject(r.provider, {
    model: r.model,
    messages: [
      {
        role: "system",
        content:
          "You write agent skills. A skill is a SKILL.md with a short kebab-case name, a one-sentence description that says WHEN to use it, and Markdown instructions: when to use it, numbered steps, rules, and an example. Keep it under 60 lines. Reply with JSON only.",
      },
      { role: "user", content: `Write a skill for this workflow:\n${workflow}` },
    ],
    schema: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      description: z.string().min(5).max(1000),
      instructions: z.string().min(20).max(20_000),
    }),
  });
  return out.value;
}

function isAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}

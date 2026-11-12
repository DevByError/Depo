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
import { devDbHooks } from "./devdb/hooks";
import { DevDatabaseService } from "./devdb/service";
import { DiagnosticsService } from "./diagnostics/service";
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
import { setOllamaParallel } from "./models/revive";
import { ModelWarmup } from "./models/speed";
import { type DataDirs, dataDirs, ensureDataDirs } from "./paths";
import { AutoPreview } from "./preview/auto";
import { PreviewManager } from "./preview/manager";
import { ProjectRegistry } from "./projects/registry";
import { QaService, type QaServiceOptions } from "./qa/service";
import { type ReadinessHooks, ReadinessService } from "./readiness/service";
import { ReferenceService, type ReferenceServiceOptions } from "./references/service";
import { holdsOneModel, ModelScheduler } from "./scheduler/scheduler";
import { SearchService } from "./search/service";
import { SecurityService } from "./security/service";
import { SettingsRepo } from "./settings";
import { SkillService } from "./skills/service";
import { TerminalService } from "./terminal/service";
import { TOOLS } from "./tools/index";
import type { GithubEndpoints } from "./util/github";
import { type RunMarker, startRunMark } from "./util/runmark";
import { startWatchdog, type Watchdog } from "./util/watchdog";
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
  /** false = no freeze watcher thread (the stall meter still runs). */
  watchdog?: boolean;
  /** Test hooks for the model manager (fake hardware, fake providers). */
  models?: Pick<ModelManagerOptions, "profile" | "providerFactory" | "ollamaModelsDir">;
  /** Test hooks for the agent loop. */
  tasks?: { maxSteps?: number; retryDelayMs?: number; planLimits?: { thinkMs?: number; totalMs?: number } };
  /** Run the finish line after agents finish (default on; DEPO_FINISH_LINE=0 turns it off for tests). */
  finishLine?: boolean;
  /** Test hooks for downloads (GitHub archives, OSV dumps). */
  downloads?: { github?: GithubEndpoints; osvBase?: string; updateApi?: string };
  /** Test hook: replaces the git runner used for clones. */
  git?: ConstructorParameters<typeof ProjectRegistry>[0]["git"];
  /** Test hooks for page checks (a fake browser). */
  qa?: Pick<QaServiceOptions, "open" | "axeSource" | "hasBrowser" | "timeoutMs">;
  /** Test hooks for design references (a browser, which requests an outside page may make). */
  references?: Pick<ReferenceServiceOptions, "open" | "hasBrowser" | "gate">;
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
  /** The owner's Terminal and test runs. */
  readonly terminal: TerminalService;
  /** Installed compilers and linters; `latest(projectId, taskId)` feeds the readiness report. */
  readonly diagnostics: DiagnosticsService;
  readonly devdb: DevDatabaseService;
  /** Pictures and links the owner sends as design references. */
  readonly references: ReferenceService;
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
  // "Allow all in this project" on an approval turns on the project's full access.
  approvals.useProjectGrants({
    has: (id) => safeSettings(registry, id)?.fullAccess ?? false,
    grant: (id) => {
      try {
        registry.setSettings(id, { fullAccess: true });
      } catch (err) {
        logger.warn("could not save full access", { projectId: id, err });
      }
    },
  });
  try {
    const n = settings.get("scheduler.max_parallel");
    setOllamaParallel(typeof n === "number" ? n : 1);
  } catch {
    // the default (one at a time) stays
  }
  const scheduler = new ModelScheduler({
    bus,
    logger,
    maxParallel: () => {
      // A held job can wake the scheduler after the engine closed its database: one at a time then.
      let v: unknown;
      try {
        v = settings.get("scheduler.max_parallel");
      } catch {
        return 1;
      }
      return typeof v === "number" && v >= 1 ? Math.floor(v) : 1;
    },
    projectCap: (id) => safeSettings(registry, id)?.maxParallel ?? 1,
    isProjectPaused: (id) => safeSettings(registry, id)?.paused ?? false,
    oneModel: () => {
      let v: unknown;
      try {
        v = settings.get("scheduler.one_model");
      } catch {
        v = "auto";
      }
      return holdsOneModel(v, models.hardware());
    },
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
  const rootOfProject = (id: string) =>
    database.db
      .select({ root: projectsTable.rootPath })
      .from(projectsTable)
      .where(eq(projectsTable.id, id))
      .get()?.root ?? null;
  const rulesOf = (id: string) => {
    const s = safeSettings(registry, id);
    return s ? { allow: s.commandAllow, deny: s.commandDeny } : null;
  };
  /** The owner's Terminal (Terminal tab) and the test runs it and agents leave (Test results tab). */
  const terminal = new TerminalService({
    bus,
    logger,
    sqlite: database.sqlite,
    projectRoot: rootOfProject,
    workspaceRoot: (id): string | null => tasks.workspaceRoot(id),
    taskProject: (id) => taskRow(id)?.projectId ?? null,
    taskTitle: (id) => taskRow(id)?.title ?? null,
    commandRules: rulesOf,
  });
  projects.beforeWorkspaceRemoved((dir) => terminal.stopRoot(dir));
  /** Installed compilers and linters, runtime problems (Problems tab, `diagnostics` tool, readiness). */
  const diagnostics = new DiagnosticsService({
    bus,
    logger,
    sqlite: database.sqlite,
    cacheDir: path.join(dirs.root, "diagnostics"),
    projectRoot: rootOfProject,
    workspaceRoot: (id): string | null => tasks.workspaceRoot(id),
    taskProject: (id) => taskRow(id)?.projectId ?? null,
    taskTitle: (id) => taskRow(id)?.title ?? null,
    commandRules: rulesOf,
    previews,
    qa,
  });
  /** Design references: pictures and links whose look the owner wants (studied before agents start). */
  const references = new ReferenceService({
    dataDir: path.join(dirs.root, "references"),
    bus,
    logger,
    models,
    scheduler,
    ...opts.references,
  });
  /** Test databases: MariaDB (or an installed MySQL) on 127.0.0.1, one database per project. */
  const devdb = new DevDatabaseService({
    dir: path.join(dirs.root, "devdb"),
    toolsDir: path.join(dirs.root, "tools"),
    bus,
    logger,
    approvals,
  });
  const projectName = (id: string) =>
    database.db.select().from(projectsTable).where(eq(projectsTable.id, id)).get()?.name ?? null;
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
    warmup: new ModelWarmup({
      models,
      scheduler,
      logger,
      enabled: () => settings.get("models.preload") !== false,
      paused: (id) => scheduler.status().pausedAll || (id !== null && !!safeSettings(registry, id)?.paused),
    }),
    readiness: readinessHooks,
    references,
    // Stop means stop: the task's running apps stop with it (a pinned one keeps running).
    onStopped: async (taskId, projectId) => {
      await autoPreview.release(taskId, "Stopped because the task was stopped");
      for (const p of previews.list(projectId))
        if (p.taskId === taskId && !p.pinned && (p.state === "running" || p.state === "starting"))
          await previews.stop(p.id, "Stopped because the task was stopped");
    },
    devdb: devDbHooks({ service: devdb, projectName }),
    finishLine:
      (opts.finishLine ?? process.env.DEPO_FINISH_LINE !== "0")
        ? {
            previews,
            autoStart: (projectId, taskId) => autoPreview.onReview(projectId, taskId),
            devdb,
            qa,
          }
        : undefined,
    eta,
    previews,
    qa,
    diagnostics,
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
    // Code checks: the latest compiler and linter run for the task's copy (Problems tab, diagnostics tool).
    diagnostics: {
      latest: (projectId, taskId) => diagnostics.latest(projectId, taskId),
      run: (projectId, taskId) => diagnostics.run({ projectId, taskId, by: "engine" }),
    },
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
  let watchdog: Watchdog | null = null;
  let runMark: RunMarker | null = null;
  let lastMarkAt = 0;

  // What the engine is doing, for the freeze watchdog and the run mark: calls being answered,
  // tasks working and the latest event (the Manager's "reading the request" line, a file write).
  let lastEvent = "";
  bus.subscribe((e) => {
    if (e.type === "heartbeat") return;
    lastEvent = `${e.agent}: ${e.text}`.slice(0, 160);
  });
  const activity = (): string => {
    const parts: string[] = [];
    const calls = server?.inflight() ?? [];
    if (calls.length)
      parts.push(
        `answering ${calls
          .slice(0, 4)
          .map((c) => `${c.method} (${(c.ms / 1000).toFixed(1)} s)`)
          .join(", ")}`,
      );
    const working = tasks.runningIds();
    if (working.length) parts.push(`${working.length} task${working.length === 1 ? "" : "s"} working`);
    if (lastEvent) parts.push(`last event: ${lastEvent}`);
    return parts.join("; ") || "idle";
  };

  const beat = () => {
    const mem = process.memoryUsage();
    const details: HeartbeatDetails = {
      uptimeMs: Date.now() - startedAt.getTime(),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      connectedClients: server?.clientCount() ?? 0,
      eventsPersisted: bus.persistedCount,
      lagMs: watchdog?.takeLag() ?? 0,
    };
    if (runMark && Date.now() - lastMarkAt >= 5000) {
      lastMarkAt = Date.now();
      runMark.alive(activity());
    }
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
    terminal,
    diagnostics,
    references,
    devdb,
    database,
    async start() {
      runMark = startRunMark(dirs.root);
      const last = runMark.lastRun;
      if (last) {
        logger.warn("the last engine run did not stop cleanly", {
          pid: last.pid,
          startedAt: last.startedAt,
          lastAliveAt: last.aliveAt,
          uptimeMs: last.uptimeMs,
          doing: last.doing,
        });
        bus.emit({
          agent: "engine",
          type: "warning",
          text: `Depo's engine did not stop cleanly last time. Its last sign of life was at ${clock(last.aliveAt)}, after ${Math.round(last.uptimeMs / 60_000)} min, while ${last.doing || "idle"}. It was closed by force, crashed or froze; the engine log ends there.`,
          details: { lastRun: { ...last } },
          status: "info",
        });
      }
      const swept = projects.sweepTrash();
      if (swept) logger.info("deleting leftovers of the last run in the background", { folders: swept });
      watchdog = startWatchdog({
        logger,
        logFile: opts.watchdog === false ? null : path.join(dirs.logs, "engine.log"),
        activity,
      });
      server = startApiServer({
        token: opts.token,
        port: opts.port ?? 0,
        handlers,
        bus,
        logger,
        onCall: (method) => watchdog?.note(`answering ${method}; ${activity()}`),
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
          terminal,
          diagnostics,
          references,
          devdb,
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
      watchdog?.stop();
      watchdog = null;
      bus.emit({
        agent: "engine",
        type: "engine_stopping",
        text: `Engine stopping (${reason})`,
        details: { reason },
      });
      indexer.stopAll();
      await tasks.cancelAll();
      // "Keep models loaded until Depo closes": unload them now (a few seconds at most).
      await models.releaseModels().catch(() => {});
      await readiness.close();
      await qa.close();
      await terminal.stopAll();
      await autoPreview.detach();
      await previews.stopAll();
      await devdb.stopAll();
      await mcp.stopAll();
      await server?.stop();
      database.close();
      runMark?.stopped(reason);
      logger.info("engine stopped", { reason });
      logger.flush();
      if (getDefaultLogger() === logger) setDefaultLogger(null);
    },
  };
}

/** "11:46:13" in the PC's local time, for a message to the owner. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
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

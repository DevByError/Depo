import path from "node:path";
import { DEPO_VERSION, type HeartbeatDetails } from "@depo/shared";
import { TaskManager } from "./agent/tasks";
import { handlers } from "./api/handlers";
import { type ApiServer, startApiServer } from "./api/server";
import { ApprovalCenter } from "./approvals";
import { CodeIndexer } from "./codeindex/indexer";
import { type OpenedDatabase, openDatabase } from "./db";
import { DesignService } from "./design/service";
import { EventBus } from "./events/bus";
import { createLogger, type Logger, type LogLevel } from "./logger";
import { MemoryStore } from "./memory/store";
import { ModelManager, type ModelManagerOptions } from "./models/manager";
import { type DataDirs, dataDirs, ensureDataDirs } from "./paths";
import { ProjectRegistry } from "./projects/registry";
import { ModelScheduler } from "./scheduler/scheduler";
import { SettingsRepo } from "./settings";
import { ProjectService } from "./workspace/service";

export interface EngineOptions {
  dataRoot: string;
  token: string;
  port?: number;
  logLevel?: LogLevel;
  logToStderr?: boolean;
  /** Overrides the `engine.heartbeat_ms` setting (tests). */
  heartbeatMs?: number;
  /** Test hooks for the model manager (fake hardware, fake providers). */
  models?: Pick<ModelManagerOptions, "profile" | "providerFactory" | "ollamaModelsDir">;
  /** Test hooks for the agent loop. */
  tasks?: { maxSteps?: number; retryDelayMs?: number };
  /** Test hook: replaces the git runner used for clones. */
  git?: ConstructorParameters<typeof ProjectRegistry>[0]["git"];
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
  const database = openDatabase({ file: path.join(dirs.db, "depo.db"), backupsDir: dirs.backups, logger });
  const bus = new EventBus(database.db, logger);
  const settings = new SettingsRepo(database.db);
  const models = new ModelManager({ settings, bus, logger, ...opts.models });
  const approvals = new ApprovalCenter(bus);
  const projects = new ProjectService(database.db, bus, logger, dirs);
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
  });
  const tasks = new TaskManager({
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
  const design = new DesignService(projects, (id) => tasks.workspaceRoot(id), bus);
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
      await server?.stop();
      database.close();
      logger.info("engine stopped", { reason });
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

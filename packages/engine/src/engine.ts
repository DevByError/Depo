import path from "node:path";
import { DEPO_VERSION, type HeartbeatDetails } from "@depo/shared";
import { TaskManager } from "./agent/tasks";
import { handlers } from "./api/handlers";
import { type ApiServer, startApiServer } from "./api/server";
import { ApprovalCenter } from "./approvals";
import { type OpenedDatabase, openDatabase } from "./db";
import { EventBus } from "./events/bus";
import { createLogger, type Logger, type LogLevel } from "./logger";
import { ModelManager, type ModelManagerOptions } from "./models/manager";
import { type DataDirs, dataDirs, ensureDataDirs } from "./paths";
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
  const tasks = new TaskManager({ db: database.db, bus, logger, models, projects, approvals, ...opts.tasks });
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
          info: {
            startedAt,
            dataDir: dirs.root,
            dbPath: database.path,
            schemaVersion: database.schemaVersion,
          },
        },
      });
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
      await tasks.cancelAll();
      await server?.stop();
      database.close();
      logger.info("engine stopped", { reason });
    },
  };
}

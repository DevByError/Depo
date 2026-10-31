#!/usr/bin/env bun
/**
 * Engine entry point. Started by the Tauri shell as a sidecar, or by `bun run dev`.
 *
 * Environment:
 *   DEPO_ENGINE_TOKEN          per-launch auth token (>= 32 chars). Generated if missing (dev only).
 *   DEPO_ENGINE_PORT           port to bind on 127.0.0.1 (default 0 = random free port)
 *   DEPO_DATA_DIR              override for %LOCALAPPDATA%\Depo
 *   DEPO_LOG_LEVEL             debug | info | warn | error
 *   DEPO_PARENT_PID            exit when this process disappears (set by the shell)
 *   DEPO_EXIT_ON_STDIN_CLOSE   "1" = exit when stdin closes (set by the shell)
 *
 * Stdout carries exactly one line, the ready handshake. Logs go to files (and stderr in dev).
 */
import { randomBytes } from "node:crypto";
import { DEPO_VERSION, ENGINE_READY_PREFIX, type EngineReady } from "@depo/shared";
import { createEngine } from "./engine";
import type { LogLevel } from "./logger";
import { resolveDataRoot } from "./paths";

const env = process.env;
const devMode = !env.DEPO_ENGINE_TOKEN;
const token = env.DEPO_ENGINE_TOKEN ?? randomBytes(32).toString("hex");
const port = Number.parseInt(env.DEPO_ENGINE_PORT ?? "0", 10);
const logLevel = (["debug", "info", "warn", "error"] as const).find((l) => l === env.DEPO_LOG_LEVEL) as
  | LogLevel
  | undefined;

const engine = createEngine({
  dataRoot: resolveDataRoot(),
  token,
  port: Number.isFinite(port) ? port : 0,
  logLevel: logLevel ?? "info",
  logToStderr: devMode,
});

let shuttingDown = false;
async function shutdown(reason: string, code = 0): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    try {
      await engine.stop(reason);
    } catch (err) {
      engine.logger.error("error during shutdown", { err });
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Ctrl+Break / console close on Windows.
process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
process.on("uncaughtException", (err) => {
  engine.logger.error("uncaught exception", { err });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  engine.logger.error("unhandled rejection", { err });
});

if (env.DEPO_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.stdin.resume();
}

const parentPid = Number.parseInt(env.DEPO_PARENT_PID ?? "", 10);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void shutdown("parent process exited");
    }
  }, 2000).unref();
}

const { port: boundPort } = await engine.start();
const ready: EngineReady = { port: boundPort, pid: process.pid, version: DEPO_VERSION };
process.stdout.write(`${ENGINE_READY_PREFIX}${JSON.stringify(ready)}\n`);
if (devMode) {
  process.stderr.write(
    `\nDev mode: connect the UI with\n  ws://127.0.0.1:${boundPort}/rpc?token=${token}\n\n`,
  );
}

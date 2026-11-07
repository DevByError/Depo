import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger";
import { ZipWriter } from "../projects/zip";
import { redact, redactString } from "../redact";
import { logFiles } from "./query";

/** Where each part of the diagnostics bundle comes from. Every source is optional and may fail. */
export interface DiagnosticsSources {
  logger: Logger;
  systemInfo?: () => unknown;
  hardware?: () => unknown;
  settings?: () => unknown;
  events?: () => unknown;
  models?: () => Promise<unknown>;
  modelStats?: () => unknown;
  scheduler?: () => Promise<unknown> | unknown;
}

export interface DiagnosticsResult {
  path: string;
  bytes: number;
  files: string[];
}

const README = [
  "Depo diagnostics",
  "",
  "Made on this PC by Logs > Export diagnostics. Nothing was sent anywhere.",
  "Secrets (tokens, passwords, keys, .env values) were replaced with «redacted» before saving.",
  "",
  "logs/            engine log files (JSON lines, newest is engine.log)",
  "system-info.json engine version, runtime, platform, data folder",
  "hardware.json    hardware profile (CPU, RAM, GPU, disk)",
  "settings.json    app settings",
  "events.json      recent activity from the audit log",
  "models.json      installed models and recent model call timings",
  "scheduler.json   model queue at the time of export",
  "",
].join("\r\n");

/** Downloads, or the logs folder when there is no Downloads folder. */
export function defaultDiagnosticsDir(logDir: string): string {
  const downloads = path.join(os.homedir(), "Downloads");
  return fs.existsSync(downloads) ? downloads : logDir;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

async function safely(fn: (() => unknown) | undefined): Promise<unknown> {
  if (!fn) return null;
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write a diagnostics .zip: the log files, system info, hardware profile, settings, recent events,
 * installed models and model timings. Everything goes through the redactor again on the way in.
 */
export async function exportDiagnostics(
  src: DiagnosticsSources,
  destDir?: string,
): Promise<DiagnosticsResult> {
  src.logger.flush();
  const logDir = src.logger.dir;
  const dir = destDir?.trim()
    ? path.resolve(destDir.trim().replace(/^"(.*)"$/, "$1"))
    : defaultDiagnosticsDir(logDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const target = uniquePath(dir, `depo-diagnostics-${stamp()}.zip`);
  const zip = new ZipWriter(target);
  const names: string[] = [];
  const json = (name: string, value: unknown) => {
    zip.add(name, Buffer.from(`${JSON.stringify(redact(value), null, 2)}\n`, "utf8"));
    names.push(name);
  };
  try {
    zip.add("README.txt", Buffer.from(README, "utf8"));
    names.push("README.txt");
    for (const f of logFiles(logDir).reverse()) {
      let text: string;
      try {
        text = fs.readFileSync(f.file, "utf8");
      } catch {
        continue;
      }
      // Lines were redacted when written; a second pass costs little and catches older lines.
      zip.add(`logs/${f.name}`, Buffer.from(redactString(text), "utf8"));
      names.push(`logs/${f.name}`);
      await yieldToLoop();
    }
    json("system-info.json", await safely(src.systemInfo));
    json("hardware.json", await safely(src.hardware));
    json("settings.json", await safely(src.settings));
    json("events.json", await safely(src.events));
    await yieldToLoop();
    json("models.json", {
      installed: await safely(src.models),
      recentCalls: await safely(src.modelStats),
    });
    json("scheduler.json", await safely(src.scheduler));
    const { bytes } = zip.close();
    src.logger.info("diagnostics exported", {
      component: "engine",
      path: target,
      bytes,
      files: names.length,
    });
    return { path: target, bytes, files: names };
  } catch (err) {
    zip.abort();
    fs.rmSync(target, { force: true });
    throw err;
  }
}

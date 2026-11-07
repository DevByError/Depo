import { type JsonValue, JsonValueSchema } from "@depo/shared";
import { eq } from "drizzle-orm";
import type { AppDb } from "./db";
import { settings } from "./db/schema";

/** Defaults returned when a key has never been written. */
export const DEFAULT_SETTINGS: Record<string, JsonValue> = {
  "ui.theme": "dark",
  "engine.heartbeat_ms": 2000,
  "quality.mode": "max_quality",
  /** Model requests served at once across all projects (one local GPU: usually 1). */
  "scheduler.max_parallel": 1,
  /** Ask the user to approve the Manager's plan before the team starts. */
  "team.approve_plan": true,
  /** Who reviews agent output: "all" (every task), "key" (architecture and API work only) or "off". */
  "team.reviews": "all",
  /** Maximum attempts per task when a reviewer sends the work back. */
  "team.fix_loops": 5,
  /** Tasks the team may work on at once (model calls still queue). */
  "team.parallel": 2,
  /** Put the brief, options, decisions and audit notes into the project as docs/depo/*.md. */
  "team.export_docs": true,
  /** GitHub repository (owner/name) the "Check for updates" button looks at. Empty = not configured. */
  "update.repo": "",
  /** Tell the person (in the app, and with a system notification when the window is in the background). */
  "notify.enabled": true,
  /** Set once the welcome tour was shown. */
  "ui.onboarded": false,
  /** Lowest engine log level written to the log files: "debug", "info", "warn" or "error". */
  "logs.level": "info",
  /** After each finished task, remember durable facts about the project by itself (stack, commands, decisions). */
  "memory.auto": true,
  /** When a task's changes are ready for review, start its private copy so the owner gets a link (keys are lowercase, so not autoStart). */
  "preview.auto_start": true,
  /** How long local runtimes keep a model loaded after a call: "5m", "30m", "2h", "-1" (until Depo closes) or "0". */
  "models.keep_alive": "30m",
  /** Load the model a task's first step uses while the task gets ready (warm-up). */
  "models.preload": true,
};

export class SettingsRepo {
  constructor(private readonly db: AppDb) {}

  get(key: string): JsonValue | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return DEFAULT_SETTINGS[key] ?? null;
    return JsonValueSchema.parse(JSON.parse(row.value));
  }

  set(key: string, value: JsonValue): JsonValue {
    const now = new Date().toISOString();
    const encoded = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: encoded, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: encoded, updatedAt: now } })
      .run();
    return value;
  }

  all(): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = { ...DEFAULT_SETTINGS };
    for (const row of this.db.select().from(settings).all()) {
      out[row.key] = JsonValueSchema.parse(JSON.parse(row.value));
    }
    return out;
  }
}

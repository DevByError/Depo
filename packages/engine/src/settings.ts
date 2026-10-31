import { type JsonValue, JsonValueSchema } from "@depo/shared";
import { eq } from "drizzle-orm";
import type { AppDb } from "./db";
import { settings } from "./db/schema";

/** Defaults returned when a key has never been written. */
export const DEFAULT_SETTINGS: Record<string, JsonValue> = {
  "ui.theme": "dark",
  "engine.heartbeat_ms": 2000,
  "quality.mode": "max_quality",
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

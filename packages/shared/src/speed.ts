/**
 * Speed on a modest PC: how long runtimes keep models loaded and whether Depo loads the next
 * model early. Both are plain settings (settings.get / settings.set).
 */
export { DEFAULT_KEEP_ALIVE, normalizeKeepAlive } from "@depo/model-gateway/contracts";

export const SPEED_SETTINGS = {
  /** How long a runtime keeps a model loaded after a call: "5m", "30m", "2h", "-1" (until Depo closes) or "0". */
  keepAlive: "models.keep_alive",
  /** Load the model a task's first step uses while the task gets ready (boolean). */
  preload: "models.preload",
} as const;

/** The choices Settings offers for `models.keep_alive`. */
export const KEEP_ALIVE_CHOICES = [
  { value: "5m", label: "5 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "-1", label: "Until Depo closes" },
] as const;

/** A call whose model load took at least this long counts as a cold load (the model was not in memory). */
export const COLD_LOAD_MS = 500;

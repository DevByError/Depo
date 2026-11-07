/**
 * How long a runtime keeps a model in memory after a call. Loading a model takes seconds to
 * minutes on a modest PC, so Depo asks runtimes to keep it loaded between calls.
 *
 * The value is a short string: "-1" (until Depo closes), "0" (unload at once) or a whole number
 * with a unit, such as "5m", "30m", "2h" or "90s".
 */

export const DEFAULT_KEEP_ALIVE = "30m";

const PATTERN = /^(?:-1|0|[1-9]\d{0,5}[smh])$/;

/**
 * The value in its standard form, or null when it is not a valid keep-alive. Numbers are seconds
 * (negative means forever), as Ollama reads them.
 */
export function normalizeKeepAlive(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    if (value < 0) return "-1";
    if (value === 0) return "0";
    return value <= 999_999 ? `${value}s` : null;
  }
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return PATTERN.test(v) ? v : null;
}

/** Seconds, or null for "until Depo closes". */
export function keepAliveSeconds(value: string): number | null {
  const v = normalizeKeepAlive(value);
  if (v === null || v === "-1") return null;
  if (v === "0") return 0;
  const n = Number(v.slice(0, -1));
  const unit = v.at(-1);
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}

/**
 * The form Ollama accepts in `keep_alive`: a duration string, or a number of seconds. "-1" must
 * be sent as a number (Ollama cannot parse the string "-1" as a duration).
 */
export function ollamaKeepAlive(value: string): string | number | undefined {
  const v = normalizeKeepAlive(value);
  if (v === null) return undefined;
  if (v === "-1") return -1;
  if (v === "0") return 0;
  return v;
}

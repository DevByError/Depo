/**
 * Prefixed, time-sortable identifiers such as `evt_01J…`, `prj_…`, `tsk_…`.
 * Format: <prefix>_<12 hex chars of ms timestamp><16 hex chars random>.
 * Sorting ids lexicographically sorts them by creation time.
 */
export type IdPrefix =
  | "evt"
  | "prj"
  | "tsk"
  | "msg"
  | "req"
  | "cs"
  | "chk"
  | "job"
  | "mem"
  | "sch"
  | "amsg"
  | "skl"
  | "mcp"
  | "kpk";

export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  const time = now.toString(16).padStart(12, "0");
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${time}${rand}`;
}

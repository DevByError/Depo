import type { ModelInfo } from "@depo/model-gateway";

/**
 * Small models (4B parameters or fewer, such as qwen2.5-coder:3b) answer fast on a modest GPU but
 * lose track with many tools and break JSON that carries code. Depo gives them a shorter tool
 * list and prompt, teaches them file blocks (no JSON for code), and lets a larger installed model
 * of the same kind take a step they keep failing.
 */

/** Largest model, in billions of parameters, that counts as small. */
export const SMALL_MAX_B = 4;
/** Largest model Depo steps up to (a 4 GB GPU still runs 7B, partly on the CPU). */
const STEP_UP_MAX_B = 14;

/**
 * The tools a small model gets: files, commands, the app and its test database. Repo maps,
 * blackboards, diagrams and decks stay with larger models (each tool's description costs prompt).
 */
export const SMALL_MODEL_TOOLS = [
  "read_file",
  "list_dir",
  "find_files",
  "search",
  "write_file",
  "edit_file",
  "append_file",
  "delete_file",
  "run_command",
  "start_preview",
  "http_check",
  "stop_preview",
  "check_page",
  "dev_database",
  "remember",
];

/** Billions of parameters, from the tag (qwen2.5-coder:3b, llama3.2:1b-instruct) or the runtime's "3.1B". */
export function modelBillions(name: string, parameterSize?: string | null): number | null {
  const tag = /[:\-_](\d+(?:\.\d+)?)b(?![a-z])/i.exec(name.split("/").pop() ?? name);
  if (tag?.[1]) return Number(tag[1]);
  const p = /^(\d+(?:\.\d+)?)\s*([BM])$/i.exec((parameterSize ?? "").trim());
  if (p?.[1]) return p[2]?.toUpperCase() === "M" ? Number(p[1]) / 1000 : Number(p[1]);
  return null;
}

export function isSmallModel(name: string, parameterSize?: string | null): boolean {
  const b = modelBillions(name, parameterSize);
  return b !== null && b <= SMALL_MAX_B;
}

/** The model's name without its tag: "qwen2.5-coder:3b" → "qwen2.5-coder". */
function base(name: string): string {
  return name.split(":")[0]?.toLowerCase() ?? name.toLowerCase();
}

/**
 * The installed model to hand a step to when a small model is stuck: the smallest one that is
 * larger, of the same model (qwen2.5-coder:3b → qwen2.5-coder:7b), else of the same family.
 * Null when there is none, or when the model is not small.
 */
export function pickStepUp(model: string, installed: ModelInfo[]): string | null {
  const me = installed.find((m) => m.name === model);
  const size = modelBillions(model, me?.parameterSize);
  if (size === null || size > SMALL_MAX_B) return null;
  const bigger = installed
    .filter((m) => m.name !== model && !/embed/i.test(m.name))
    .map((m) => ({ m, b: modelBillions(m.name, m.parameterSize) }))
    .filter((x): x is { m: ModelInfo; b: number } => x.b !== null && x.b > size && x.b <= STEP_UP_MAX_B)
    .sort((a, b) => a.b - b.b);
  const same = bigger.find((x) => base(x.m.name) === base(model));
  if (same) return same.m.name;
  const family = me?.family;
  const kin = family
    ? bigger.find((x) => x.m.family === family && /coder|code/i.test(x.m.name) === /coder|code/i.test(model))
    : undefined;
  return kin?.m.name ?? null;
}

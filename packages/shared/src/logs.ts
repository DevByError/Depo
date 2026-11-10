import { z } from "zod";
import { JsonValueSchema } from "./events";

/** Engine log levels, lowest first. */
export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** One engine log line, as the UI shows it. Secrets were redacted before the line was written. */
export const LogLineSchema = z.object({
  /** Unique within one answer; stable for the same line (used as a list key). */
  id: z.string(),
  ts: z.string(),
  level: LogLevelSchema,
  /** api, agent, team, tools, models, scheduler, workspace, index, security, … */
  component: z.string(),
  msg: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  agent: z.string().nullable(),
  durationMs: z.number().nullable(),
  err: z
    .object({
      name: z.string().nullable(),
      message: z.string(),
      stack: z.string().nullable(),
    })
    .nullable(),
  /** Every other field of the line. */
  data: z.record(z.string(), JsonValueSchema),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const LogCountsSchema = z.object({
  debug: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});
export type LogCounts = z.infer<typeof LogCountsSchema>;

/** One model call measured by the engine (the newest few hundred are kept in memory). */
export const ModelCallSchema = z.object({
  ts: z.string(),
  providerId: z.string(),
  providerKind: z.string(),
  model: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  errorKind: z.string().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  /** Time to the first streamed chunk (the runtime reads the prompt until then). */
  ttftMs: z.number().nullable(),
  durationMs: z.number(),
  tokensPerSec: z.number().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  agent: z.string().nullable(),
  /** Time the runtime spent loading the model for this call (Ollama reports it). */
  loadMs: z.number().nullable().optional(),
  /** The model was not in memory and had to be loaded (load took 500 ms or more). Null when unknown. */
  coldLoad: z.boolean().nullable().optional(),
  /** Time the runtime spent reading the prompt. */
  promptMs: z.number().nullable().optional(),
  /** Prompt reading speed (tokens/s). */
  promptTokensPerSec: z.number().nullable().optional(),
  /** Prompt tokens the runtime reused from its cache (llama.cpp reports it). */
  cachedPromptTokens: z.number().nullable().optional(),
  /** The context length requested for this call (one per model, so the runtime does not reload it). */
  contextLength: z.number().nullable().optional(),
});
export type ModelCall = z.infer<typeof ModelCallSchema>;

export const ModelStatSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  calls: z.number().int(),
  errors: z.number().int(),
  avgTokensPerSec: z.number().nullable(),
  medianTtftMs: z.number().nullable(),
  lastAt: z.string(),
  lastError: z.string().nullable(),
  /** The context length last requested for this model. */
  contextLength: z.number().nullable().optional(),
  /** Calls and early loads that had to load the model. */
  coldLoads: z.number().int().optional(),
  /** Median time of those loads. */
  medianLoadMs: z.number().nullable().optional(),
  /** Time spent loading this model, in total. */
  loadMsTotal: z.number().optional(),
  /** Time spent on this model's calls and early loads, in total (loads included). */
  busyMsTotal: z.number().optional(),
  /** The last calls found the model already in memory. Null when the runtime does not say. */
  keptLoaded: z.boolean().nullable().optional(),
  /** Average prompt reading speed (tokens/s). */
  avgPromptTokensPerSec: z.number().nullable().optional(),
  /** Prompt tokens reused from the runtime's cache, in total (llama.cpp reports it). */
  cachedPromptTokens: z.number().nullable().optional(),
});
export type ModelStat = z.infer<typeof ModelStatSchema>;

const LogFilterFields = {
  /** Lowest level to include. */
  level: LogLevelSchema.optional(),
  /** Exactly these levels (overrides `level`). */
  levels: z.array(LogLevelSchema).max(4).optional(),
  component: z.string().max(64).optional(),
  /** Case-insensitive text anywhere in the line. */
  text: z.string().max(200).optional(),
  taskId: z.string().max(100).optional(),
  projectId: z.string().max(100).optional(),
};

export const LogMethods = {
  "logs.query": {
    params: z
      .object({
        ...LogFilterFields,
        /** ISO times: only lines at or after `since`, and before `until`. */
        since: z.string().max(40).optional(),
        until: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(2000).default(500),
        /** The `next` value of the previous page: older lines than that. */
        before: z.string().max(120).optional(),
        /** Stop after reading this many bytes (default 8 MB). */
        maxBytes: z
          .number()
          .int()
          .min(4096)
          .max(64 * 1024 * 1024)
          .optional(),
      })
      .strict(),
    result: z.object({
      /** Oldest first. */
      lines: z.array(LogLineSchema),
      /** Pass as `before` to read older lines; null when the oldest file was read to the start. */
      next: z.string().nullable(),
      /** Pass to `logs.tail` to get lines written after this answer. */
      cursor: z.number().int().nonnegative(),
      scannedBytes: z.number().int().nonnegative(),
      /** The byte limit stopped the search before `limit` lines matched. */
      truncated: z.boolean(),
      /** Lines per level among those read that match the other filters. */
      counts: LogCountsSchema,
    }),
  },
  "logs.tail": {
    params: z
      .object({
        ...LogFilterFields,
        cursor: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(2000).default(500),
      })
      .strict(),
    result: z.object({
      lines: z.array(LogLineSchema),
      cursor: z.number().int().nonnegative(),
      /** The cursor is from an older engine run or lines were missed: query again. */
      reset: z.boolean(),
    }),
  },
  "logs.components": {
    params: z.object({}).strict(),
    result: z.object({ components: z.array(z.string()) }),
  },
  "logs.info": {
    params: z.object({}).strict(),
    result: z.object({
      dir: z.string(),
      level: LogLevelSchema,
      files: z.array(z.object({ name: z.string(), bytes: z.number().int(), modifiedAt: z.string() })),
    }),
  },
  "logs.export": {
    // Writes a diagnostics .zip (logs, system info, hardware, redacted settings, recent events, models).
    params: z.object({ destDir: z.string().max(1000).optional() }).strict(),
    result: z.object({ path: z.string(), bytes: z.number().int(), files: z.array(z.string()) }),
  },
  "logs.openFolder": {
    params: z.object({}).strict(),
    result: z.object({ ok: z.boolean(), path: z.string() }),
  },
  "logs.clear": {
    // Deletes the old log files and empties the current one. Lines written afterwards are kept.
    params: z.object({}).strict(),
    result: z.object({ removed: z.number().int(), bytes: z.number().int() }),
  },
  "models.stats": {
    params: z.object({ limit: z.number().int().min(1).max(500).default(50) }).strict(),
    result: z.object({ calls: z.array(ModelCallSchema), models: z.array(ModelStatSchema) }),
  },
} as const;

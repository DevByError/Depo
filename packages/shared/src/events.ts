import { z } from "zod";

/**
 * Event types. The first block is the minimum list from the product spec (Section 9).
 * The second block is engine-level lifecycle events added in Phase 0 (see DECISIONS.md, ADR-0006).
 */
export const AGENT_EVENT_TYPES = [
  "thinking",
  "planning",
  "reading_file",
  "searching",
  "writing_file",
  "editing_file",
  "running_command",
  "command_output",
  "installing_dependency",
  "testing",
  "test_result",
  "linting",
  "security_scan",
  "rendering_screenshot",
  "reviewing",
  "handoff",
  "waiting_for_user",
  "error",
  "retrying",
  "applied_changes",
  "checkpoint_created",
  "queued",
  "memory_updated",
  "decision",
  /** The owner sent a note while a task worked (queued), or an agent read it (delivered). */
  "owner_note",
  "committed",
] as const;

export const SYSTEM_EVENT_TYPES = [
  "heartbeat",
  "engine_started",
  "engine_stopping",
  "client_connected",
  "client_disconnected",
  "settings_changed",
  "info",
  "warning",
  "hardware_profiled",
  "model_download",
  "model_benchmark",
  "indexing",
  "project_changed",
  "preview_started",
  "preview_stopped",
  /** New lines of a Terminal run (ephemeral). */
  "terminal_output",
] as const;

export const EventTypeSchema = z.enum([...AGENT_EVENT_TYPES, ...SYSTEM_EVENT_TYPES]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventStatusSchema = z.enum(["started", "running", "succeeded", "failed", "cancelled", "info"]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/** Arbitrary structured details. Values must be JSON-serialisable. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const DepoEventSchema = z.object({
  id: z.string().regex(/^evt_[0-9a-f]{28}$/),
  /** ISO-8601 timestamp in UTC. */
  ts: z.string(),
  /** Monotonic sequence number within one engine run; lets clients detect gaps. */
  seq: z.number().int().nonnegative(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  /** `name@version` of the agent, or `engine` for system events. */
  agent: z.string(),
  type: EventTypeSchema,
  /** Human-readable one-liner shown in the activity feed. */
  text: z.string(),
  details: z.record(z.string(), JsonValueSchema).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  status: EventStatusSchema,
  /** Ephemeral events (e.g. heartbeat) are broadcast but not written to the audit log. */
  ephemeral: z.boolean(),
});
export type DepoEvent = z.infer<typeof DepoEventSchema>;

export type NewEvent = Omit<
  DepoEvent,
  "id" | "ts" | "seq" | "projectId" | "taskId" | "details" | "durationMs" | "status" | "ephemeral"
> &
  Partial<Pick<DepoEvent, "projectId" | "taskId" | "details" | "durationMs" | "status" | "ephemeral">>;

export const HeartbeatDetailsSchema = z.object({
  uptimeMs: z.number(),
  rssBytes: z.number(),
  heapUsedBytes: z.number(),
  connectedClients: z.number().int(),
  eventsPersisted: z.number().int(),
  /** The engine's worst delay since the last beat, in ms (a busy or blocked engine answers late). */
  lagMs: z.number().nonnegative().optional(),
});
export type HeartbeatDetails = z.infer<typeof HeartbeatDetailsSchema>;

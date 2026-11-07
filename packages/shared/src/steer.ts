import { z } from "zod";

/**
 * Steering: while a task works, the owner can add a note instead of waiting. The running agent
 * reads it at its next step (never in the middle of a tool call); in a team run the Manager and
 * the agents at work read it. A note sent to a task that is not working becomes a follow-up.
 */

/**
 * queued: waiting for the next step; delivered: read by at least one agent; dropped: the task
 * stopped before anyone read it; followup: the run ended first, so it started the next turn.
 */
export const SteerStateSchema = z.enum(["queued", "delivered", "dropped", "followup"]);
export type SteerState = z.infer<typeof SteerStateSchema>;

/** The steering part of a chat item (user notes sent while the task worked). */
export const SteerInfoSchema = z.object({
  state: SteerStateSchema,
  /** Agents that read the note (`coder@1.0.0`, `manager@1.0.0`), in the order they read it. */
  readBy: z.array(z.string()).default([]),
  queuedAt: z.string(),
  deliveredAt: z.string().nullable().default(null),
});
export type SteerInfo = z.infer<typeof SteerInfoSchema>;

/** Notes are kept short: every agent at work carries them in its context. */
export const STEER_MAX_CHARS = 4000;

export const SteerMethods = {
  "tasks.steer": {
    params: z
      .object({
        taskId: z.string(),
        text: z.string().trim().min(1).max(STEER_MAX_CHARS),
      })
      .strict(),
    result: z.object({
      /** queued: the working task reads it at its next step; followup: the task continued with it. */
      delivery: z.enum(["queued", "followup"]),
      taskId: z.string(),
      /** The note's chat item id (queued notes only). */
      noteId: z.string().nullable(),
    }),
  },
} as const;

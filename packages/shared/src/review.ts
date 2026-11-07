import { z } from "zod";

/**
 * Pull-request style review: the owner comments on lines of a change set in Diff Review, then
 * asks the agent for changes. The comments go to the same task in one follow-up, the agent
 * revises its private copy, and the next change set replaces the old one.
 */

/** A diff row is found by its side and line: "new" for added and unchanged rows, "old" for removed rows. */
export const DiffSideSchema = z.enum(["new", "old"]);
export type DiffSide = z.infer<typeof DiffSideSchema>;

/**
 * open: waiting for the agent; addressed: the agent revised it (or the owner marked it);
 * outdated: never sent, and the lines it pointed at changed.
 */
export const ReviewCommentStatusSchema = z.enum(["open", "addressed", "outdated"]);
export type ReviewCommentStatus = z.infer<typeof ReviewCommentStatusSchema>;

export const REVIEW_COMMENT_MAX_CHARS = 2000;

export const ReviewCommentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable(),
  /** The change set the comment is shown on (moves to a newer one while its lines are still there). */
  changeSetId: z.string(),
  path: z.string(),
  /** First row of the range. */
  side: DiffSideSchema,
  line: z.number().int().min(1),
  /** Last row of the range (the comment shows under it). Same as the first row for one line. */
  endSide: DiffSideSchema,
  endLine: z.number().int().min(1),
  /** The commented diff rows, each starting with "+", "-" or " ". Untrusted file content: show as text. */
  quote: z.string(),
  body: z.string(),
  status: ReviewCommentStatusSchema,
  /** changed: a later version no longer has these lines; agent: the agent said so; owner: marked by the owner. */
  addressedBy: z.enum(["changed", "agent", "owner"]).nullable(),
  /** The change set in which it was addressed or went out of date. */
  addressedIn: z.string().nullable(),
  /** When "Request changes" last sent it to the agent (null = not sent yet). */
  sentAt: z.string().nullable(),
  /** Its number in that request ("Addressed: 1, 3"). */
  ref: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

const RowSchema = z.object({ side: DiffSideSchema, line: z.number().int().min(1).max(10_000_000) });

export const ReviewMethods = {
  "review.comments.list": {
    /** Comments shown on this change set, and the ones addressed by it. */
    params: z.object({ changeSetId: z.string() }).strict(),
    result: z.object({ comments: z.array(ReviewCommentSchema) }),
  },
  "review.comments.add": {
    params: z
      .object({
        changeSetId: z.string(),
        path: z.string().min(1).max(1000),
        /** The first row; `end` is the last row of a range (omitted = one line). */
        start: RowSchema,
        end: RowSchema.optional(),
        body: z.string().trim().min(1).max(REVIEW_COMMENT_MAX_CHARS),
      })
      .strict(),
    result: ReviewCommentSchema,
  },
  "review.comments.update": {
    /** Edit the text, or mark it addressed / open again. */
    params: z
      .object({
        id: z.string(),
        body: z.string().trim().min(1).max(REVIEW_COMMENT_MAX_CHARS).optional(),
        status: z.enum(["open", "addressed"]).optional(),
      })
      .strict(),
    result: ReviewCommentSchema,
  },
  "review.comments.remove": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ removed: z.boolean() }),
  },
  "review.requestChanges": {
    /** Send every open comment (and an optional overall note) to the task in one follow-up. */
    params: z
      .object({
        changeSetId: z.string(),
        note: z.string().trim().max(REVIEW_COMMENT_MAX_CHARS).optional(),
      })
      .strict(),
    result: z.object({
      taskId: z.string(),
      /** How many comments were sent. */
      sent: z.number().int(),
      /** followup: the task started again; queued: it was working, so it reads them at its next step. */
      delivery: z.enum(["queued", "followup"]),
    }),
  },
} as const;

import type { Handlers } from "./handlers";

/** Steering notes and pull-request style review comments (Diff Review). */
export const steerReviewHandlers: Pick<
  Handlers,
  | "tasks.steer"
  | "review.comments.list"
  | "review.comments.add"
  | "review.comments.update"
  | "review.comments.remove"
  | "review.requestChanges"
> = {
  "tasks.steer": (p, ctx) => ctx.tasks.steer(p.taskId, p.text),
  "review.comments.list": (p, ctx) => ({ comments: ctx.tasks.reviews.list(p.changeSetId) }),
  "review.comments.add": (p, ctx) => ctx.tasks.reviews.add(p),
  "review.comments.update": (p, ctx) => ctx.tasks.reviews.update(p.id, p),
  "review.comments.remove": (p, ctx) => ({ removed: ctx.tasks.reviews.remove(p.id) }),
  "review.requestChanges": (p, ctx) => ctx.tasks.reviews.requestChanges(p.changeSetId, p.note),
};

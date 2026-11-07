import type { ReadinessService } from "../readiness/service";
import type { HandlerContext, Handlers } from "./handlers";

function needReadiness(ctx: HandlerContext): ReadinessService {
  if (!ctx.readiness) throw new Error("The readiness report is not available in this engine.");
  return ctx.readiness;
}

/** The readiness report at review time, and the checks the owner can run from it. */
export const readinessHandlers: Pick<Handlers, "readiness.get" | "readiness.run"> = {
  "readiness.get": (p, ctx) => ({ report: needReadiness(ctx).report(p.taskId) }),
  "readiness.run": (p, ctx) => needReadiness(ctx).run(p.taskId, p.check),
};

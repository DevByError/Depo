import { type JsonValue, newId } from "@depo/shared";
import type { EventBus } from "./events/bus";

export interface ApprovalRequest {
  projectId: string | null;
  taskId: string | null;
  agent: string;
  kind: "command" | "apply" | "other";
  /** One line for the activity feed, e.g. `Run "pip install httpx"?`. */
  title: string;
  /** Why it needs a person: the policy reason. */
  reason: string;
  details?: Record<string, JsonValue>;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
}

export type ApprovalScope = "once" | "task" | "project";

/** Standing "yes" for a whole project (stored in its settings, see ProjectSettings.fullAccess). */
export interface ProjectGrants {
  has(projectId: string): boolean;
  grant(projectId: string): void;
}

/**
 * Agents ask; people decide. A request emits a `waiting_for_user` event and waits until the UI
 * answers (approvals.respond) or the task is cancelled.
 */
export class ApprovalCenter {
  private readonly pending = new Map<string, { req: PendingApproval; resolve: (ok: boolean) => void }>();
  /** Tasks whose commands the owner allowed for the rest of the task. */
  private readonly taskGrants = new Set<string>();
  private projectGrants: ProjectGrants | null = null;

  constructor(private readonly bus: EventBus) {}

  /** Wire the project settings in (the engine does this once projects exist). */
  useProjectGrants(g: ProjectGrants): void {
    this.projectGrants = g;
  }

  /** Is a command in this project or task already allowed by a standing "yes"? */
  private granted(req: ApprovalRequest): "task" | "project" | null {
    if (req.kind !== "command") return null;
    if (req.taskId && this.taskGrants.has(req.taskId)) return "task";
    if (req.projectId && this.projectGrants?.has(req.projectId)) return "project";
    return null;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  request(req: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    const standing = this.granted(req);
    if (standing) {
      this.bus.emit({
        projectId: req.projectId,
        taskId: req.taskId,
        agent: req.agent,
        type: "info",
        text: `Allowed (${standing === "project" ? "full access in this project" : "allowed for this task"}): ${req.title.replace(/\?$/, "")}`,
        details: { kind: req.kind, standing, ...(req.details ?? {}) },
        status: "succeeded",
      });
      return Promise.resolve(true);
    }
    const id = newId("req");
    const full: PendingApproval = { ...req, id, createdAt: new Date().toISOString() };
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = () => done(false);
      this.pending.set(id, { req: full, resolve: done });
      this.bus.emit({
        projectId: req.projectId,
        taskId: req.taskId,
        agent: req.agent,
        type: "waiting_for_user",
        text: req.title,
        details: { approvalId: id, kind: req.kind, reason: req.reason, ...(req.details ?? {}) },
        status: "started",
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  respond(id: string, approve: boolean, scope: ApprovalScope = "once"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (approve && p.req.kind === "command") {
      if (scope === "task" && p.req.taskId) this.taskGrants.add(p.req.taskId);
      if (scope === "project" && p.req.projectId) this.projectGrants?.grant(p.req.projectId);
    }
    this.bus.emit({
      projectId: p.req.projectId,
      taskId: p.req.taskId,
      agent: "user",
      type: "info",
      text: `${approve ? "Approved" : "Declined"}: ${p.req.title}`,
      details: { approvalId: id, approved: approve },
      status: approve ? "succeeded" : "cancelled",
    });
    p.resolve(approve);
    // Other commands already waiting under the same standing "yes" go ahead too.
    if (approve && scope !== "once")
      for (const other of [...this.pending.values()])
        if (this.granted(other.req)) this.respond(other.req.id, true);
    return true;
  }

  /** Forget a finished task's standing "yes". */
  endTask(taskId: string): void {
    this.taskGrants.delete(taskId);
  }
}

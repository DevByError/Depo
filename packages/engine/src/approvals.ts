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

/**
 * Agents ask; people decide. A request emits a `waiting_for_user` event and waits until the UI
 * answers (approvals.respond) or the task is cancelled.
 */
export class ApprovalCenter {
  private readonly pending = new Map<string, { req: PendingApproval; resolve: (ok: boolean) => void }>();

  constructor(private readonly bus: EventBus) {}

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  request(req: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
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

  respond(id: string, approve: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
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
    return true;
  }
}

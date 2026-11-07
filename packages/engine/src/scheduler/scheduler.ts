import { ModelGatewayError } from "@depo/model-gateway";
import { newId, type SchedulerJob, type SchedulerPriority, type SchedulerStatus } from "@depo/shared";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";

const PRIORITY_RANK: Record<SchedulerPriority, number> = { chat: 0, task: 1, background: 2 };
/** A job that has waited this long ignores the "stay on the loaded model" preference. */
const STARVATION_MS = 20_000;

export interface SchedulerRequest {
  projectId: string | null;
  taskId: string | null;
  model: string;
  priority: SchedulerPriority;
  label: string;
}

interface Waiting extends SchedulerJob {
  enqueuedAt: number;
  start: () => void;
  fail: (err: Error) => void;
}

export interface SchedulerOptions {
  bus: EventBus;
  maxParallel: () => number;
  /** How many jobs one project may run at once. */
  projectCap: (projectId: string) => number;
  isProjectPaused: (projectId: string) => boolean;
  now?: () => number;
  /** Queue and run times go to the engine log (component "scheduler"). */
  logger?: Logger;
}

/**
 * One queue for model work across all projects. A single local GPU serves few requests at a
 * time, so jobs wait here, ordered by priority (chat > task > background), then by staying on
 * the model that is already loaded (avoids slow reloads), then round-robin between projects.
 * CPU work (tests, builds) does not go through the scheduler and runs in parallel.
 */
export class ModelScheduler {
  private readonly queue: Waiting[] = [];
  private readonly running = new Map<string, SchedulerJob>();
  private readonly lastGrant = new Map<string, number>();
  private pausedAll = false;
  private resident: string | null = null;
  private readonly startedAt = new Map<string, number>();

  constructor(private readonly o: SchedulerOptions) {}

  async run<T>(req: SchedulerRequest, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = await this.acquire(req, signal);
    try {
      return await fn();
    } finally {
      this.release(job.id);
    }
  }

  acquire(req: SchedulerRequest, signal?: AbortSignal): Promise<SchedulerJob> {
    if (signal?.aborted) return Promise.reject(new ModelGatewayError("cancelled", "Cancelled"));
    return new Promise<SchedulerJob>((resolve, reject) => {
      const job: Waiting = {
        id: newId("sch"),
        ...req,
        since: new Date(this.now()).toISOString(),
        enqueuedAt: this.now(),
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(job);
        },
        fail: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) {
          this.queue.splice(i, 1);
          this.clearWaitNotice(job);
          job.fail(new ModelGatewayError("cancelled", "Cancelled"));
          this.notifyQueue();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
      if (this.queue.includes(job)) this.notifyQueue();
    });
  }

  release(jobId: string): void {
    const job = this.running.get(jobId);
    if (!this.running.delete(jobId)) return;
    const began = this.startedAt.get(jobId);
    this.startedAt.delete(jobId);
    if (job && began !== undefined) {
      this.o.logger?.debug("model job finished", { ...this.logFields(job), durationMs: this.now() - began });
    }
    this.pump();
    this.notifyQueue();
  }

  pause(projectId?: string): void {
    if (!projectId) this.pausedAll = true;
    this.notifyQueue();
  }

  resume(projectId?: string): void {
    if (!projectId) this.pausedAll = false;
    this.pump();
    this.notifyQueue();
  }

  /** Call after settings that affect scheduling change (limits, project pause). */
  refresh(): void {
    this.pump();
    this.notifyQueue();
  }

  status(pausedProjects: string[] = []): SchedulerStatus {
    const strip = ({ id, projectId, taskId, model, priority, label, since }: SchedulerJob): SchedulerJob => ({
      id,
      projectId,
      taskId,
      model,
      priority,
      label,
      since,
    });
    return {
      maxParallel: this.o.maxParallel(),
      pausedAll: this.pausedAll,
      pausedProjects,
      running: [...this.running.values()].map(strip),
      queued: this.ordered().map(strip),
      residentModel: this.resident,
    };
  }

  // ---- internals -----------------------------------------------------------------------------

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private runningFor(projectId: string): number {
    let n = 0;
    for (const j of this.running.values()) if (j.projectId === projectId) n++;
    return n;
  }

  private eligible(j: Waiting): boolean {
    if (this.pausedAll) return false;
    if (j.projectId) {
      if (this.o.isProjectPaused(j.projectId)) return false;
      if (this.runningFor(j.projectId) >= this.o.projectCap(j.projectId)) return false;
    }
    return true;
  }

  /** Queue in the order jobs would start. */
  private ordered(): Waiting[] {
    const now = this.now();
    return [...this.queue].sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      const stick = (j: Waiting) =>
        this.resident !== null && j.model !== this.resident && now - j.enqueuedAt < STARVATION_MS ? 1 : 0;
      const s = stick(a) - stick(b);
      if (s !== 0) return s;
      const g = (this.lastGrant.get(a.projectId ?? "") ?? 0) - (this.lastGrant.get(b.projectId ?? "") ?? 0);
      if (g !== 0) return g;
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  private pump(): void {
    while (this.running.size < Math.max(1, this.o.maxParallel())) {
      const next = this.ordered().find((j) => this.eligible(j));
      if (!next) return;
      this.queue.splice(this.queue.indexOf(next), 1);
      this.running.set(next.id, next);
      this.resident = next.model;
      this.lastGrant.set(next.projectId ?? "", this.now());
      this.clearWaitNotice(next);
      this.startedAt.set(next.id, this.now());
      const queueMs = this.now() - next.enqueuedAt;
      // Waits of a second or more are worth seeing at the default level.
      this.o.logger?.[queueMs >= 1000 ? "info" : "debug"]("model job started", {
        ...this.logFields(next),
        queueMs,
        queued: this.queue.length,
      });
      next.start();
    }
  }

  private logFields(j: SchedulerJob) {
    return {
      component: "scheduler",
      projectId: j.projectId,
      taskId: j.taskId,
      model: j.model,
      priority: j.priority,
      label: j.label,
      running: this.running.size,
    };
  }

  /** Tell each waiting task why it waits (its own feed only). */
  private notifyQueue(): void {
    const order = this.ordered();
    order.forEach((j, i) => {
      if (!j.taskId) return;
      const reason = this.pausedAll
        ? "All model work is paused"
        : j.projectId && this.o.isProjectPaused(j.projectId)
          ? "This project is paused"
          : i === 0 && this.running.size > 0
            ? "Waiting for the model to finish another job"
            : `Waiting for the model: ${i} job${i === 1 ? "" : "s"} ahead`;
      this.o.bus.emit({
        projectId: j.projectId,
        taskId: j.taskId,
        agent: "engine",
        type: "queued",
        text: reason,
        details: { jobId: `queue-${j.taskId}`, position: i + 1, running: this.running.size },
        ephemeral: true,
        status: "running",
      });
    });
  }

  private clearWaitNotice(j: SchedulerJob): void {
    if (!j.taskId) return;
    this.o.bus.emit({
      projectId: j.projectId,
      taskId: j.taskId,
      agent: "engine",
      type: "queued",
      text: "Started",
      details: { jobId: `queue-${j.taskId}`, clear: true },
      ephemeral: true,
      status: "succeeded",
    });
  }
}

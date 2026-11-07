import type { DepoEvent, PreviewDetection, PreviewInfo, RunRecipe } from "@depo/shared";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";

/**
 * The owner always gets a link: when a task (single or team) ends with changes ready for review
 * and Depo knows how to start the app, the task's private copy is started in the background
 * (setting `preview.autoStart`, on by default). Nothing is installed: a recipe that still needs
 * packages is skipped until the owner installs them from the Preview tab. The preview stops when
 * the change set is applied or discarded, unless the owner pinned it.
 */

/** What auto start needs from the preview manager (narrow, so tests can stub it). */
export interface AutoPreviewHost {
  detect(projectId: string, taskId?: string | null): Promise<PreviewDetection>;
  start(req: {
    projectId: string;
    taskId?: string | null;
    recipe?: RunRecipe;
    by?: string;
    auto?: boolean;
  }): Promise<{ preview: PreviewInfo; related: PreviewInfo[] }>;
  stop(id: string, reason?: string): Promise<boolean>;
  list(projectId?: string): PreviewInfo[];
  get(id: string): PreviewInfo | null;
}

export interface AutoPreviewOptions {
  bus: EventBus;
  logger: Logger;
  previews: AutoPreviewHost;
  /** `preview.autoStart`. */
  enabled(): boolean;
  /** The status of a change set (`applied`, `discarded`, `pending`, …), or null when unknown. */
  changeSetStatus(id: string): string | null;
}

export type AutoStartResult =
  | { started: true; previews: PreviewInfo[] }
  | {
      started: false;
      reason: "disabled" | "running" | "no_recipe" | "needs_install" | "failed";
      detail?: string;
    };

export class AutoPreview {
  /** Preview ids Depo started by itself, per task. */
  private readonly started = new Map<string, Set<string>>();
  private readonly busy = new Map<string, Promise<AutoStartResult>>();
  private unsubscribe: (() => void) | null = null;
  private readonly log: Logger;

  constructor(private readonly o: AutoPreviewOptions) {
    this.log = o.logger.child({ component: "preview" });
  }

  /** Follow the event bus: review → start; applied or discarded → stop. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.o.bus.subscribe((e) => this.onEvent(e));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onEvent(e: DepoEvent): void {
    const changeSetId = typeof e.details?.changeSetId === "string" ? e.details.changeSetId : null;
    if (!e.taskId || !changeSetId) return;
    if (e.type === "handoff" && e.status === "succeeded" && e.projectId) {
      void this.onReview(e.projectId, e.taskId);
      return;
    }
    if (e.type === "applied_changes" || (e.type === "info" && e.status === "cancelled")) {
      const status = this.o.changeSetStatus(changeSetId);
      if (status === "applied") void this.release(e.taskId, "Stopped because the changes were applied");
      else if (status === "discarded")
        void this.release(e.taskId, "Stopped because the changes were discarded");
    }
  }

  /** Start the task's private copy when its changes are ready for review (once at a time per task). */
  onReview(projectId: string, taskId: string): Promise<AutoStartResult> {
    const running = this.busy.get(taskId);
    if (running) return running;
    const p = this.startFor(projectId, taskId).finally(() => this.busy.delete(taskId));
    this.busy.set(taskId, p);
    return p;
  }

  private async startFor(projectId: string, taskId: string): Promise<AutoStartResult> {
    if (!this.o.enabled()) return { started: false, reason: "disabled" };
    const live = this.o.previews
      .list(projectId)
      .filter((p) => p.taskId === taskId && (p.state === "running" || p.state === "starting"));
    if (live.length) return { started: false, reason: "running" };
    let detection: PreviewDetection;
    try {
      detection = await this.o.previews.detect(projectId, taskId);
    } catch (err) {
      return { started: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    const recipe = detection.recipes[detection.suggested];
    if (!recipe) return { started: false, reason: "no_recipe" };
    const parts = recipe.kind === "both" ? (recipe.parts ?? []) : [recipe];
    if (recipe.missing || parts.some((p) => p.missing)) {
      this.log.info("auto preview skipped: packages are not installed", { taskId });
      return { started: false, reason: "needs_install" };
    }
    try {
      const res = await this.o.previews.start({ projectId, taskId, recipe, by: "engine", auto: true });
      const all = [...res.related, res.preview];
      const ids = this.started.get(taskId) ?? new Set<string>();
      for (const p of all) ids.add(p.id);
      this.started.set(taskId, ids);
      this.log.info("auto preview started", { taskId, previews: all.map((p) => p.id) });
      return { started: true, previews: all };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.info("auto preview could not start", { taskId, error: detail });
      return { started: false, reason: "failed", detail };
    }
  }

  /** Stop what Depo started for this task, except previews the owner pinned. */
  async release(taskId: string, reason: string): Promise<number> {
    const pendingStart = this.busy.get(taskId);
    if (pendingStart) await pendingStart.catch(() => undefined);
    const ids = this.started.get(taskId);
    if (!ids) return 0;
    let stopped = 0;
    for (const id of [...ids]) {
      const info = this.o.previews.get(id);
      if (!info) {
        ids.delete(id);
        continue;
      }
      if (info.pinned) continue;
      if (await this.o.previews.stop(id, reason)) stopped++;
      ids.delete(id);
    }
    if (ids.size === 0) this.started.delete(taskId);
    return stopped;
  }

  /** Preview ids started automatically for a task (tests, diagnostics). */
  startedFor(taskId: string): string[] {
    return [...(this.started.get(taskId) ?? [])];
  }
}

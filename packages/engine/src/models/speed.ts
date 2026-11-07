import type { ModelProvider, Role } from "@depo/model-gateway";
import { DEFAULT_KEEP_ALIVE, type JsonValue, normalizeKeepAlive, SPEED_SETTINGS } from "@depo/shared";
import type { Logger } from "../logger";
import type { ModelScheduler } from "../scheduler/scheduler";
import type { SettingsRepo } from "../settings";

/** How long runtimes keep a model loaded (setting `models.keep_alive`), in its standard form. */
export function readKeepAlive(settings: Pick<SettingsRepo, "get">): string {
  return normalizeKeepAlive(settings.get(SPEED_SETTINGS.keepAlive)) ?? DEFAULT_KEEP_ALIVE;
}

/**
 * Check a speed setting before it is saved and return the value to store. Other keys pass
 * through unchanged. Throws a plain message for a value the engine could not use.
 */
export function checkSpeedSetting(key: string, value: JsonValue): JsonValue {
  if (key === SPEED_SETTINGS.keepAlive) {
    const v = normalizeKeepAlive(value);
    if (v === null) {
      throw new Error(
        'Keep models loaded for: use a time like "5m", "30m" or "2h", "-1" (until Depo closes) or "0" (unload at once).',
      );
    }
    return v;
  }
  if (key === SPEED_SETTINGS.preload && typeof value !== "boolean") {
    throw new Error("Load the next model early: use true or false.");
  }
  return value;
}

export interface TuneOptions {
  /** The keep-alive to send when the caller did not ask for one. */
  keepAlive: () => string;
  /** The one context length for this model, or undefined when no role uses it. */
  contextFor: (model: string) => number | undefined;
  /** Called with each model this provider talks to (for unloading at exit). */
  onUse?: (model: string) => void;
}

/**
 * Every chat call to a model gets the same context length and the keep-alive setting, whoever
 * makes it (agents, reviews, memory, commit messages, benchmarks). Ollama reloads a model when
 * `num_ctx` changes and unloads it after 5 minutes by default; both cost seconds to minutes on a
 * small GPU.
 */
export function tuneProvider(p: ModelProvider, o: TuneOptions): ModelProvider {
  const preload = p.preload?.bind(p);
  return {
    id: p.id,
    kind: p.kind,
    baseUrl: p.baseUrl,
    health: (signal) => p.health(signal),
    listModels: (signal) => p.listModels(signal),
    embed: (model, inputs, signal) => p.embed(model, inputs, signal),
    chat: (req) => {
      o.onUse?.(req.model);
      const contextLength = o.contextFor(req.model) ?? req.contextLength;
      return p.chat({
        ...req,
        keepAlive: req.keepAlive ?? o.keepAlive(),
        ...(contextLength !== undefined ? { contextLength } : {}),
      });
    },
    ...(p.pull ? { pull: p.pull.bind(p) } : {}),
    ...(p.remove ? { remove: p.remove.bind(p) } : {}),
    ...(preload
      ? {
          preload: (model, opts = {}) => {
            o.onUse?.(model);
            const contextLength = o.contextFor(model) ?? opts.contextLength;
            return preload(model, {
              ...opts,
              keepAlive: opts.keepAlive ?? o.keepAlive(),
              ...(contextLength !== undefined ? { contextLength } : {}),
            });
          },
        }
      : {}),
    ...(p.unload ? { unload: p.unload.bind(p) } : {}),
    ...(p.loaded ? { loaded: p.loaded.bind(p) } : {}),
  };
}

export type WarmupResult =
  | "off"
  | "no_model"
  | "unsupported"
  | "already_loaded"
  | "loaded"
  | "paused"
  | "cancelled"
  | "failed";

export interface WarmupOptions {
  models: {
    resolve(role: Role): { provider: ModelProvider; model: string; contextLength: number | undefined } | null;
  };
  scheduler?: ModelScheduler | undefined;
  /** Setting `models.preload` (default on). */
  enabled: () => boolean;
  /** Model work for this project (or all of it) is paused: loading early would be wasted. */
  paused?: (projectId: string | null) => boolean;
  logger: Logger;
}

/**
 * Warm-up: when a task starts, load the model its first step will use, at background priority,
 * while the task copies the project and builds its prompt. It never blocks the task and never
 * fails it; a model already in memory is left alone.
 */
export class ModelWarmup {
  private readonly inflight = new Map<string, Promise<WarmupResult>>();
  private readonly log: Logger;

  constructor(private readonly o: WarmupOptions) {
    this.log = o.logger.child({ component: "models" });
  }

  warm(role: Role, job: { projectId: string | null; taskId: string | null }, signal?: AbortSignal) {
    if (!this.o.enabled()) return Promise.resolve<WarmupResult>("off");
    if (this.o.paused?.(job.projectId)) return Promise.resolve<WarmupResult>("paused");
    let r: ReturnType<WarmupOptions["models"]["resolve"]>;
    try {
      r = this.o.models.resolve(role) ?? (role === "coder" ? null : this.o.models.resolve("coder"));
    } catch {
      return Promise.resolve<WarmupResult>("no_model");
    }
    if (!r) return Promise.resolve<WarmupResult>("no_model");
    const { provider, model, contextLength } = r;
    if (!provider.preload) return Promise.resolve<WarmupResult>("unsupported");
    const key = `${provider.id}\u0000${model}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.load(provider, model, contextLength, job, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load(
    provider: ModelProvider,
    model: string,
    contextLength: number | undefined,
    job: { projectId: string | null; taskId: string | null },
    signal?: AbortSignal,
  ): Promise<WarmupResult> {
    const run = async (): Promise<WarmupResult> => {
      if (signal?.aborted) return "cancelled";
      if (await isLoaded(provider, model, contextLength, signal)) return "already_loaded";
      if (signal?.aborted) return "cancelled";
      await provider.preload?.(model, {
        ...(contextLength ? { contextLength } : {}),
        ...(signal ? { signal } : {}),
      });
      return "loaded";
    };
    try {
      const result = this.o.scheduler
        ? await this.o.scheduler.run(
            {
              projectId: job.projectId,
              // No task id: a warm-up waiting in the queue is not something the task waits for.
              taskId: null,
              model,
              priority: "background",
              label: "Load the model early",
            },
            run,
            signal,
          )
        : await run();
      this.log.debug("warm-up", { model, result, taskId: job.taskId, projectId: job.projectId });
      return result;
    } catch (err) {
      if (signal?.aborted) return "cancelled";
      this.log.debug("warm-up failed", { model, taskId: job.taskId, err });
      return "failed";
    }
  }
}

/** Is the model in the runtime's memory already, with the context length it will be asked for? */
async function isLoaded(
  provider: ModelProvider,
  model: string,
  contextLength: number | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!provider.loaded) return false;
  try {
    const list = await provider.loaded(signal);
    const want = model.replace(/:latest$/, "");
    const hit = list.find((m) => m.name === model || m.name.replace(/:latest$/, "") === want);
    if (!hit) return false;
    return hit.contextLength === null || contextLength === undefined || hit.contextLength === contextLength;
  } catch {
    return false;
  }
}

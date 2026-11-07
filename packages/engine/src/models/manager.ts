import os from "node:os";
import path from "node:path";
import {
  type AutoFitPlan,
  autoFit,
  type Benchmark,
  collectChat,
  createProvider,
  DEFAULT_CATALOG,
  DEFAULT_PROVIDERS,
  type HardwareProfile,
  HardwareProfileSchema,
  isLocalUrl,
  type ModelCatalog,
  type ModelProvider,
  type ProviderKind,
  parseCatalog,
  type QualityMode,
  ROLES,
  type Role,
  weightsGB,
} from "@depo/model-gateway";
import {
  type Assignments,
  AssignmentsSchema,
  type InstalledModel,
  type JsonValue,
  newId,
  type ProviderConfigDto,
  ProviderConfigSchema,
  type ProviderStatus,
  type PullJob,
} from "@depo/shared";
import { z } from "zod";
import type { EventBus } from "../events/bus";
import { diskFreeGB, profileHardware } from "../hardware/profiler";
import type { Logger } from "../logger";
import { instrumentProvider, type ModelCallStats } from "../logs/model-calls";
import type { SettingsRepo } from "../settings";

const KEY_PROVIDERS = "models.providers";
const KEY_ASSIGNMENTS = "models.assignments";
const KEY_CATALOG = "models.catalog";
const KEY_PROFILE = "hardware.profile";

/** A fixed prompt so benchmark numbers are comparable between runs and machines. */
const BENCH_PROMPT =
  "Write a Python function `merge_intervals(intervals)` that merges overlapping intervals. " +
  "Include a docstring and three doctest examples. Reply with code only.";

export interface ModelManagerOptions {
  settings: SettingsRepo;
  bus: EventBus;
  logger: Logger;
  /** Profiles hardware; replaceable in tests. */
  profile?: () => Promise<Omit<HardwareProfile, "benchmark">>;
  /** Builds providers; replaceable in tests. */
  providerFactory?: (cfg: ProviderConfigDto) => ModelProvider;
  /** Where Ollama stores models, for the free-space check. */
  ollamaModelsDir?: string;
  /** Recent model call timings (Engine panel). */
  callStats?: ModelCallStats;
}

interface Job {
  dto: PullJob;
  ctl: AbortController;
}

/**
 * Owns everything about local models: providers, hardware profile, catalog, Auto-Fit plan,
 * per-role assignments, downloads and benchmarks. State lives in settings so it survives restarts.
 */
export class ModelManager {
  private readonly jobs = new Map<string, Job>();
  private readonly log: Logger;

  constructor(private readonly o: ModelManagerOptions) {
    this.log = o.logger.child({ component: "models" });
  }

  // ---- providers -------------------------------------------------------------------------

  providerConfigs(): ProviderConfigDto[] {
    const raw = this.o.settings.get(KEY_PROVIDERS);
    const parsed = z.array(ProviderConfigSchema).safeParse(raw);
    return parsed.success && parsed.data.length ? parsed.data : DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  }

  setProviders(list: ProviderConfigDto[]): ProviderConfigDto[] {
    const ids = new Set<string>();
    for (const p of list) {
      if (ids.has(p.id)) throw new Error(`Duplicate provider id: ${p.id}`);
      ids.add(p.id);
      if (!isLocalUrl(p.baseUrl)) {
        throw new Error(
          `${p.baseUrl} is not a local or LAN address. Depo only uses models on your own machines.`,
        );
      }
    }
    this.o.settings.set(KEY_PROVIDERS, list as unknown as JsonValue);
    return list;
  }

  provider(id: string): ModelProvider {
    const cfg = this.providerConfigs().find((p) => p.id === id);
    if (!cfg) throw new Error(`Unknown model provider: ${id}`);
    if (!cfg.enabled) throw new Error(`Model provider ${id} is turned off.`);
    // Every chat call is timed and logged (tokens/s, time to first token, errors).
    return instrumentProvider((this.o.providerFactory ?? createProvider)(cfg), this.log, this.o.callStats);
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.providerConfigs().map(async (cfg) => {
        if (!cfg.enabled) return { ...cfg, ok: false, version: null, message: "Turned off" };
        const h = await this.provider(cfg.id).health(AbortSignal.timeout(4000));
        return { ...cfg, ...h };
      }),
    );
  }

  async installed(): Promise<InstalledModel[]> {
    const status = await this.providerStatus();
    const tagToCatalog = new Map<string, string>();
    for (const m of this.catalog().catalog.models)
      for (const q of m.quantizations) tagToCatalog.set(q.tag, m.id);
    const lists = await Promise.all(
      status
        .filter((s) => s.ok)
        .map(async (s) => {
          try {
            const models = await this.provider(s.id).listModels(AbortSignal.timeout(10_000));
            return models.map((m) => ({
              providerId: s.id,
              ...m,
              catalogId: tagToCatalog.get(m.name) ?? tagToCatalog.get(m.name.replace(/:latest$/, "")) ?? null,
            }));
          } catch (err) {
            this.log.warn("listModels failed", { provider: s.id, err });
            return [];
          }
        }),
    );
    return lists.flat();
  }

  // ---- catalog, hardware, plan -----------------------------------------------------------

  catalog(): { catalog: ModelCatalog; custom: boolean } {
    const raw = this.o.settings.get(KEY_CATALOG);
    if (raw !== null) {
      try {
        return { catalog: parseCatalog(raw), custom: true };
      } catch (err) {
        this.log.warn("stored catalog is invalid; using the built-in one", { err });
      }
    }
    return { catalog: DEFAULT_CATALOG, custom: false };
  }

  importCatalog(json: string | null): { catalog: ModelCatalog; custom: boolean } {
    if (json === null) {
      this.o.settings.set(KEY_CATALOG, null);
      return { catalog: DEFAULT_CATALOG, custom: false };
    }
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("That file is not valid JSON.");
    }
    const catalog = parseCatalog(data);
    this.o.settings.set(KEY_CATALOG, catalog as unknown as JsonValue);
    return { catalog, custom: true };
  }

  hardware(): HardwareProfile | null {
    const parsed = HardwareProfileSchema.safeParse(this.o.settings.get(KEY_PROFILE));
    return parsed.success ? parsed.data : null;
  }

  async profileHardware(dataDir: string): Promise<HardwareProfile> {
    const started = Date.now();
    const base = await (this.o.profile ?? (() => profileHardware(this.modelsDiskPath(dataDir))))();
    const profile: HardwareProfile = { ...base, benchmark: this.hardware()?.benchmark ?? null };
    this.o.settings.set(KEY_PROFILE, profile as unknown as JsonValue);
    const gpu = profile.gpus.length
      ? profile.gpus.map((g) => `${g.name} (${g.vramGB} GB)`).join(", ")
      : "no dedicated GPU";
    this.o.bus.emit({
      agent: "engine",
      type: "hardware_profiled",
      text: `Hardware: ${gpu}, ${profile.ramGB} GB RAM, ${profile.cpu.threads} CPU threads`,
      details: profile as unknown as Record<string, JsonValue>,
      durationMs: Date.now() - started,
      status: "succeeded",
    });
    return profile;
  }

  plan(mode?: QualityMode): AutoFitPlan | null {
    const hw = this.hardware();
    if (!hw) return null;
    const configured = this.o.settings.get("quality.mode");
    const m: QualityMode = mode ?? (configured === "balanced" ? "balanced" : "max_quality");
    return autoFit(hw, { mode: m, catalog: this.catalog().catalog });
  }

  // ---- assignments -----------------------------------------------------------------------

  assignments(): { assignments: Assignments; effective: Assignments } {
    const parsed = AssignmentsSchema.safeParse(this.o.settings.get(KEY_ASSIGNMENTS) ?? {});
    const assignments = parsed.success ? parsed.data : {};
    const plan = this.plan();
    const ollama = this.providerConfigs().find((p) => p.kind === "ollama" && p.enabled);
    const effective: Assignments = {};
    for (const role of ROLES) {
      const manual = assignments[role];
      const auto = plan?.roles[role];
      if (manual) effective[role] = manual;
      else if (auto && ollama) effective[role] = { providerId: ollama.id, model: auto.tag };
    }
    return { assignments, effective };
  }

  assign(role: Role, ref: { providerId: string; model: string } | null) {
    const { assignments } = this.assignments();
    if (ref) {
      this.provider(ref.providerId); // validates the id
      assignments[role] = ref;
    } else {
      delete assignments[role];
    }
    this.o.settings.set(KEY_ASSIGNMENTS, assignments as unknown as JsonValue);
    return this.assignments();
  }

  /** The model an agent in `role` should use right now, with the context length to request. */
  resolve(role: Role): { provider: ModelProvider; model: string; contextLength: number | undefined } | null {
    const ref = this.assignments().effective[role];
    if (!ref) return null;
    const planned = this.plan()?.roles[role];
    return {
      provider: this.provider(ref.providerId),
      model: ref.model,
      contextLength: planned && planned.tag === ref.model ? planned.contextLength : undefined,
    };
  }

  // ---- downloads -------------------------------------------------------------------------

  pulls(): PullJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j.dto }));
  }

  /** Start a download in the background. Progress arrives as `model_download` events. */
  startPull(ref: { providerId: string; model: string }, dataDir: string): PullJob {
    const provider = this.provider(ref.providerId);
    if (!provider.pull) {
      throw new Error(
        `${provider.kind === "lmstudio" ? "LM Studio" : "llama.cpp"} manages its own models. Download them in that app.`,
      );
    }
    for (const j of this.jobs.values()) {
      if (j.dto.state === "running" && j.dto.model === ref.model && j.dto.providerId === ref.providerId) {
        return { ...j.dto };
      }
    }
    this.checkDiskSpace(ref.model, provider.kind, provider.baseUrl, dataDir);

    const job: Job = {
      dto: {
        jobId: newId("job"),
        providerId: ref.providerId,
        model: ref.model,
        status: "starting",
        completedBytes: null,
        totalBytes: null,
        state: "running",
        error: null,
      },
      ctl: new AbortController(),
    };
    this.jobs.set(job.dto.jobId, job);
    const started = Date.now();
    this.emitPull(job, "started", `Downloading ${ref.model}`);

    let lastEmit = 0;
    const pull = provider.pull.bind(provider);
    void (async () => {
      try {
        await pull(
          ref.model,
          (p) => {
            job.dto.status = p.status;
            if (p.totalBytes !== null) job.dto.totalBytes = p.totalBytes;
            if (p.completedBytes !== null) job.dto.completedBytes = p.completedBytes;
            const now = Date.now();
            if (now - lastEmit >= 500) {
              lastEmit = now;
              this.emitPull(job, "running", `Downloading ${ref.model}: ${describeProgress(job.dto)}`, true);
            }
          },
          job.ctl.signal,
        );
        job.dto.state = "succeeded";
        job.dto.status = "success";
        this.emitPull(job, "succeeded", `Downloaded ${ref.model}`, false, Date.now() - started);
      } catch (err) {
        const cancelled = job.ctl.signal.aborted;
        job.dto.state = cancelled ? "cancelled" : "failed";
        job.dto.error = cancelled ? null : err instanceof Error ? err.message : String(err);
        this.emitPull(
          job,
          cancelled ? "cancelled" : "failed",
          cancelled
            ? `Cancelled download of ${ref.model}`
            : `Download of ${ref.model} failed: ${job.dto.error}`,
          false,
          Date.now() - started,
        );
      }
    })();
    return { ...job.dto };
  }

  cancelPull(jobId: string): boolean {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    if (j.dto.state !== "running") return false;
    j.ctl.abort();
    return true;
  }

  async remove(ref: { providerId: string; model: string }): Promise<void> {
    const provider = this.provider(ref.providerId);
    if (!provider.remove) throw new Error("This runtime manages its own models. Remove them in that app.");
    await provider.remove(ref.model);
    const { assignments } = this.assignments();
    for (const role of ROLES) {
      const a = assignments[role];
      if (a && a.providerId === ref.providerId && a.model === ref.model) this.assign(role, null);
    }
    this.o.bus.emit({
      agent: "engine",
      type: "info",
      text: `Deleted model ${ref.model}`,
      details: { ...ref },
      status: "succeeded",
    });
  }

  // ---- benchmark -------------------------------------------------------------------------

  async benchmark(ref: { providerId: string; model: string }): Promise<Benchmark> {
    const provider = this.provider(ref.providerId);
    this.o.bus.emit({
      agent: "engine",
      type: "model_benchmark",
      text: `Benchmarking ${ref.model}`,
      details: { ...ref },
      status: "started",
    });
    // Warm-up loads the model so load time does not count against generation speed.
    await collectChat(
      provider.chat({
        model: ref.model,
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 1,
        temperature: 0,
      }),
    );
    let first = 0;
    const t0 = performance.now();
    const res = await collectChat(
      provider.chat({
        model: ref.model,
        messages: [{ role: "user", content: BENCH_PROMPT }],
        maxTokens: 160,
        temperature: 0,
      }),
      () => {
        if (!first) first = performance.now();
      },
    );
    const wallMs = performance.now() - (first || t0);
    const tokens = res.usage?.completionTokens || Math.max(1, Math.round(res.text.length / 4));
    const genMs = res.usage?.durationMs ?? wallMs;
    const tps = tokens / Math.max(0.001, genMs / 1000);
    const catalogId =
      this.catalog().catalog.models.find((m) => m.quantizations.some((q) => q.tag === ref.model))?.id ?? null;
    const benchmark: Benchmark = {
      catalogId,
      model: ref.model,
      tokensPerSec: Math.round(tps * 10) / 10,
      promptTokensPerSec: null,
      at: new Date().toISOString(),
    };
    const hw = this.hardware();
    if (hw) this.o.settings.set(KEY_PROFILE, { ...hw, benchmark } as unknown as JsonValue);
    this.o.bus.emit({
      agent: "engine",
      type: "model_benchmark",
      text: `${ref.model}: ${benchmark.tokensPerSec} tokens/sec`,
      details: { ...ref, tokensPerSec: benchmark.tokensPerSec, tokens },
      durationMs: Math.round(performance.now() - t0),
      status: "succeeded",
    });
    return benchmark;
  }

  // ---- internals -------------------------------------------------------------------------

  private modelsDiskPath(dataDir: string): string {
    return this.o.ollamaModelsDir ?? process.env.OLLAMA_MODELS ?? (os.homedir() || dataDir);
  }

  private checkDiskSpace(model: string, kind: ProviderKind, baseUrl: string, dataDir: string) {
    // Only meaningful when the runtime stores models on this machine.
    if (kind !== "ollama" || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseUrl)) return;
    const entry = this.catalog().catalog.models.flatMap((m) =>
      m.quantizations.filter((q) => q.tag === model).map((q) => weightsGB(m, q)),
    )[0];
    if (entry === undefined) return;
    const free = diskFreeGB(path.resolve(this.modelsDiskPath(dataDir)));
    if (free !== null && free < entry * 1.05 + 2) {
      throw new Error(
        `Not enough disk space for ${model}: it needs about ${entry.toFixed(1)} GB and ${free.toFixed(1)} GB is free.`,
      );
    }
  }

  private emitPull(
    job: Job,
    status: "started" | "running" | "succeeded" | "failed" | "cancelled",
    text: string,
    ephemeral = false,
    durationMs?: number,
  ) {
    this.o.bus.emit({
      agent: "engine",
      type: "model_download",
      text,
      details: { ...job.dto },
      status,
      ephemeral,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
}

function describeProgress(j: PullJob): string {
  if (j.totalBytes && j.completedBytes !== null) {
    const pct = Math.floor((j.completedBytes / j.totalBytes) * 100);
    return `${pct}% of ${(j.totalBytes / 1e9).toFixed(1)} GB`;
  }
  return j.status;
}

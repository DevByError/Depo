import { z } from "zod";
import {
  activeGB,
  type CatalogModel,
  DEFAULT_CATALOG,
  kvGB,
  type ModelCatalog,
  memoryNeedGB,
  QUANT_QUALITY,
  type Quant,
  QuantSchema,
  ROLES,
  type Role,
  RoleSchema,
} from "./catalog";
import type { HardwareProfile } from "./hardware";

/**
 * Auto-Fit planner (spec §8.3). For each role, walk catalog models strongest-first and take
 * the first one that fits in memory and runs at a usable speed, trying in order:
 *   1. full GPU at high precision (Q8/Q6)   2. full GPU at Q5/Q4
 *   3. GPU + RAM split (dense)               4. GPU + RAM split (MoE: small active compute)
 *   5. CPU only                              6. the next smaller model
 * Roles are planned independently because Depo loads one big model at a time (§8.4).
 * Speeds are bandwidth estimates, scaled by a real benchmark when one exists.
 */

export const QualityModeSchema = z.enum(["max_quality", "balanced"]);
export type QualityMode = z.infer<typeof QualityModeSchema>;
export type Placement = "gpu" | "split" | "cpu";
export type Strategy = 1 | 2 | 3 | 4 | 5 | 6;

export const RolePlanSchema = z.object({
  role: RoleSchema,
  modelId: z.string(),
  modelName: z.string(),
  tag: z.string(),
  quant: QuantSchema,
  contextLength: z.number().int(),
  placement: z.enum(["gpu", "split", "cpu"]),
  /** Share of the model held in VRAM, 0–1. */
  gpuFraction: z.number(),
  memoryGB: z.number(),
  estTokensPerSec: z.number(),
  /** Which Auto-Fit strategy (1–6, spec §8.3) produced this choice. */
  strategy: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  qualityLabel: z.enum(["Excellent", "Great", "Good", "Basic"]),
  speedLabel: z.enum(["Fast", "Good", "Slow", "Very slow"]),
  /** True when this is the strongest catalog model for the role. */
  strongest: z.boolean(),
  /** True when hardware forced anything below the strongest model at high precision on GPU. */
  steppedDown: z.boolean(),
  summary: z.string(),
});
export type RolePlan = z.infer<typeof RolePlanSchema>;

export const AutoFitPlanSchema = z.object({
  mode: QualityModeSchema,
  budget: z.object({
    gpuGB: z.number(),
    ramGB: z.number(),
    gpuBandwidthGBs: z.number(),
    ramBandwidthGBs: z.number(),
    calibration: z.number(),
  }),
  roles: z.partialRecord(RoleSchema, RolePlanSchema),
  /** Roles nothing in the catalog could serve, with the reason. */
  unavailable: z.partialRecord(RoleSchema, z.string()),
  qualityFirst: z.object({ active: z.boolean(), measures: z.array(z.string()) }),
  headline: z.string(),
});
export type AutoFitPlan = z.infer<typeof AutoFitPlanSchema>;

const ROLE_LABEL: Record<Role, string> = {
  coder: "coder",
  reasoning: "reasoning model",
  vision: "vision model",
  embedding: "embedding model",
  fast: "quick-task model",
};

/** Context lengths tried per role, largest first. */
const CONTEXTS: Record<Role, number[]> = {
  coder: [32768, 16384],
  reasoning: [32768, 16384, 8192],
  vision: [8192, 4096],
  embedding: [8192],
  fast: [16384, 8192],
};

/** Minimum tokens/sec for a plan to count as usable. Weak PCs get slower, not worse. */
const MIN_SPEED: Record<QualityMode, Record<Role, number>> = {
  max_quality: { coder: 4, reasoning: 3, vision: 3, embedding: 0, fast: 20 },
  balanced: { coder: 10, reasoning: 6, vision: 3, embedding: 0, fast: 35 },
};

/** Real-world tokens/sec is well below the theoretical bandwidth bound. */
const EFFICIENCY = 0.6;
const EMBEDDING_MAX_GB = 4;

export function gpuBandwidthGuess(vramGB: number): number {
  if (vramGB <= 4) return 150;
  if (vramGB <= 8) return 300;
  if (vramGB <= 12) return 400;
  if (vramGB <= 16) return 450;
  if (vramGB <= 24) return 900;
  return 1000;
}

export function memoryBudget(hw: HardwareProfile): {
  gpuGB: number;
  ramGB: number;
  gpuBandwidthGBs: number;
  ramBandwidthGBs: number;
} {
  const ramReserve = Math.max(3, hw.ramGB * 0.1);
  if (hw.unifiedMemory) {
    // Unified memory: the GPU may use roughly 70–75% of system RAM; nothing left to split into.
    const gpuGB = Math.max(0, hw.ramGB * 0.72 - 1);
    const bw = hw.gpus[0]?.bandwidthGBs ?? 200;
    return { gpuGB, ramGB: 0, gpuBandwidthGBs: bw, ramBandwidthGBs: bw };
  }
  const usable = hw.gpus.filter((g) => g.vramGB >= 2);
  const vram = usable.reduce((s, g) => s + g.vramGB, 0);
  const gpuGB = usable.length ? Math.max(0, vram * 0.92 - 0.4 * usable.length) : 0;
  const bw = usable.length
    ? Math.min(...usable.map((g) => g.bandwidthGBs ?? gpuBandwidthGuess(g.vramGB)))
    : 0;
  return {
    gpuGB,
    ramGB: Math.max(0, hw.ramGB - ramReserve),
    gpuBandwidthGBs: bw,
    ramBandwidthGBs: hw.cpu.avx2 === false ? 30 : 45,
  };
}

interface Fit {
  placement: Placement;
  gpuFraction: number;
  need: number;
  speed: number;
}

function fitOn(
  model: CatalogModel,
  qi: CatalogModel["quantizations"][number],
  ctx: number,
  b: ReturnType<typeof memoryBudget>,
  calibration: number,
): Fit | null {
  const need = memoryNeedGB(model, qi, ctx);
  const active = activeGB(model, qi) + kvGB(model, ctx) * 0.25;
  const speedFor = (f: number) => {
    const secs = active * (f > 0 ? f / b.gpuBandwidthGBs : 0) + active * ((1 - f) / b.ramBandwidthGBs);
    return (EFFICIENCY * calibration) / secs;
  };
  if (b.gpuGB > 0 && need <= b.gpuGB) return { placement: "gpu", gpuFraction: 1, need, speed: speedFor(1) };
  if (need <= b.gpuGB + b.ramGB) {
    if (b.gpuGB > 0) {
      const f = b.gpuGB / need;
      return { placement: "split", gpuFraction: f, need, speed: speedFor(f) };
    }
    return { placement: "cpu", gpuFraction: 0, need, speed: speedFor(0) };
  }
  return null;
}

function strategyFor(model: CatalogModel, quant: Quant, fit: Fit, isTop: boolean): Strategy {
  if (!isTop && fit.placement === "gpu") return 6;
  if (fit.placement === "gpu") return quant === "q4_K_M" || quant === "q5_K_M" ? 2 : 1;
  if (fit.placement === "split") return model.activeParamsB ? 4 : 3;
  return isTop ? 5 : 6;
}

function qualityLabel(score: number, quant: Quant): RolePlan["qualityLabel"] {
  const q = score * QUANT_QUALITY[quant];
  if (q >= 84) return "Excellent";
  if (q >= 72) return "Great";
  if (q >= 58) return "Good";
  return "Basic";
}

function speedLabel(tps: number): RolePlan["speedLabel"] {
  if (tps >= 30) return "Fast";
  if (tps >= 12) return "Good";
  if (tps >= 4) return "Slow";
  return "Very slow";
}

const PLACEMENT_WORDS: Record<Placement, string> = {
  gpu: "fully on the graphics card",
  split: "split between the graphics card and system memory",
  cpu: "on the processor and system memory",
};

function describe(p: Omit<RolePlan, "summary">): string {
  const which = p.strongest ? `the strongest ${ROLE_LABEL[p.role]}` : `a smaller ${ROLE_LABEL[p.role]}`;
  const precision =
    p.quant === "q8_0" || p.quant === "fp16" || p.quant === "mxfp4" || p.quant === "q6_K"
      ? "at full quality"
      : "at reduced precision";
  const speed =
    p.role === "embedding" ? "" : ` Expect about ${Math.max(1, Math.round(p.estTokensPerSec))} tokens/sec.`;
  return `Your PC can run ${which} (${p.modelName}) ${precision}, ${PLACEMENT_WORDS[p.placement]}.${speed} Quality: ${p.qualityLabel}, Speed: ${p.speedLabel}.`;
}

function rank(cat: ModelCatalog, role: Role): CatalogModel[] {
  return cat.models
    .filter((m) => m.scores[role] !== undefined)
    .sort((a, b) => (b.scores[role] ?? 0) - (a.scores[role] ?? 0));
}

/** Quantizations best-first: higher precision first. */
function quantOrder(m: CatalogModel): CatalogModel["quantizations"] {
  const order: Quant[] = ["fp16", "q8_0", "mxfp4", "q6_K", "q5_K_M", "q4_K_M"];
  return [...m.quantizations].sort((a, b) => order.indexOf(a.quant) - order.indexOf(b.quant));
}

interface Candidate {
  model: CatalogModel;
  qi: CatalogModel["quantizations"][number];
  ctx: number;
  fit: Fit;
}

/** Best way to run one model: full GPU at the best precision, else the best split/CPU option. */
function bestOption(
  model: CatalogModel,
  role: Role,
  limit: ReturnType<typeof memoryBudget>,
  mode: QualityMode,
  calibration: number,
): { pick: Candidate | null; tooSlow: boolean } {
  const minSpeed = role === "embedding" ? 0 : MIN_SPEED[mode][role];
  const options: Candidate[] = [];
  let tooSlow = false;
  for (const qi of quantOrder(model)) {
    // Per precision: the largest context that fits at all, and the largest that fits fully on the
    // GPU. A smaller context that keeps the model on the GPU beats a larger one that spills into
    // system memory, which is several times slower.
    let any: Candidate | null = null;
    let gpu: Candidate | null = null;
    for (const ctx of CONTEXTS[role].filter((c) => c <= model.contextMax)) {
      const fit = fitOn(model, qi, ctx, limit, calibration);
      if (!fit) continue;
      if (fit.speed < minSpeed) {
        tooSlow = true;
        continue;
      }
      any ??= { model, qi, ctx, fit };
      if (fit.placement === "gpu") {
        gpu = { model, qi, ctx, fit };
        break;
      }
    }
    if (gpu) options.push(gpu);
    else if (any) options.push(any);
  }
  const onGpu = options.find((o) => o.fit.placement === "gpu");
  if (onGpu) return { pick: onGpu, tooSlow };
  if (options.length === 0) return { pick: null, tooSlow };
  // Split or CPU: keep the best precision if it is comfortably fast, else take the fastest.
  const comfortable = role === "embedding" ? 0 : COMFORTABLE_SPEED[role];
  const pick =
    options.find((o) => o.fit.speed >= comfortable) ??
    options.reduce((a, b) => (b.fit.speed > a.fit.speed ? b : a));
  return { pick, tooSlow };
}

/** Speeds above which higher precision is preferred over a faster, smaller quantization. */
const COMFORTABLE_SPEED: Record<Role, number> = {
  coder: 10,
  reasoning: 8,
  vision: 4,
  embedding: 0,
  fast: 25,
};
/** A model within this many score points that is this many times faster wins the tie. */
const NEAR_TIE_POINTS = 2;
const NEAR_TIE_SPEEDUP = 3;

function planRole(
  role: Role,
  cat: ModelCatalog,
  b: ReturnType<typeof memoryBudget>,
  mode: QualityMode,
  calibration: number,
): RolePlan | string {
  const ranked = rank(cat, role);
  const top = ranked[0];
  if (!top) return "The model catalog has no models for this role.";
  const limit =
    role === "embedding"
      ? { ...b, gpuGB: 0, ramGB: Math.min(EMBEDDING_MAX_GB, (b.gpuGB + b.ramGB) * 0.1) }
      : b;
  let tooSlow = false;
  let chosen: Candidate | null = null;
  let chosenIdx = -1;
  for (const [i, model] of ranked.entries()) {
    const r = bestOption(model, role, limit, mode, calibration);
    tooSlow ||= r.tooSlow;
    if (r.pick) {
      chosen = r.pick;
      chosenIdx = i;
      break;
    }
  }
  if (!chosen) {
    return tooSlow
      ? "Models for this role fit in memory but would run too slowly to be useful on this PC."
      : "No model for this role fits in this PC's memory.";
  }
  if (role !== "embedding") {
    const chosenScore = chosen.model.scores[role] ?? 0;
    for (const model of ranked.slice(chosenIdx + 1)) {
      if ((model.scores[role] ?? 0) < chosenScore - NEAR_TIE_POINTS) break;
      const alt = bestOption(model, role, limit, mode, calibration).pick;
      if (alt && alt.fit.speed >= chosen.fit.speed * NEAR_TIE_SPEEDUP) {
        chosen = alt;
        break;
      }
    }
  }

  const { model, qi, ctx, fit } = chosen;
  const isTop = model === top;
  const score = model.scores[role] ?? 0;
  const highPrecision = qi.quant !== "q4_K_M" && qi.quant !== "q5_K_M";
  const base = {
    role,
    modelId: model.id,
    modelName: model.name,
    tag: qi.tag,
    quant: qi.quant,
    contextLength: ctx,
    placement: role === "embedding" ? ("cpu" as const) : fit.placement,
    gpuFraction: role === "embedding" ? 0 : Math.round(fit.gpuFraction * 100) / 100,
    memoryGB: Math.round(fit.need * 10) / 10,
    estTokensPerSec: Math.round(fit.speed * 10) / 10,
    strategy: role === "embedding" ? (isTop ? 1 : 6) : strategyFor(model, qi.quant, fit, isTop),
    qualityLabel: qualityLabel(score, qi.quant),
    speedLabel: speedLabel(fit.speed),
    strongest: isTop,
    steppedDown: !isTop || !highPrecision || (role !== "embedding" && fit.placement !== "gpu"),
  } satisfies Omit<RolePlan, "summary">;
  return { ...base, summary: describe(base) };
}

export function autoFit(
  hw: HardwareProfile,
  opts: { mode?: QualityMode; catalog?: ModelCatalog } = {},
): AutoFitPlan {
  const mode = opts.mode ?? "max_quality";
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const budget = memoryBudget(hw);
  const calibration = calibrate(hw, catalog, budget);
  const roles: AutoFitPlan["roles"] = {};
  const unavailable: AutoFitPlan["unavailable"] = {};
  for (const role of ROLES) {
    const r = planRole(role, catalog, budget, mode, calibration);
    if (typeof r === "string") unavailable[role] = r;
    else roles[role] = r;
  }

  const stepped = Object.values(roles).some((r) => r.steppedDown && r.role !== "embedding");
  const measures = stepped
    ? [
        "Load one big model at a time and let agents take turns",
        "Split work into smaller, well-scoped steps",
        "Best-of-3 candidates for important code",
        "More test-and-fix loops and stricter reviews",
        "Compilers, linters and tests decide, not the model's opinion",
        "Tighter retrieval and summaries to fit the context window",
      ]
    : [];
  const headline = headlineFor(roles.coder);
  return {
    mode,
    budget: {
      gpuGB: round1(budget.gpuGB),
      ramGB: round1(budget.ramGB),
      gpuBandwidthGBs: budget.gpuBandwidthGBs,
      ramBandwidthGBs: budget.ramBandwidthGBs,
      calibration: Math.round(calibration * 100) / 100,
    },
    roles,
    unavailable,
    qualityFirst: { active: stepped, measures },
    headline,
  };
}

/** Context lengths Depo may request, largest first. */
const CONTEXT_STEPS = [131_072, 65_536, 32_768, 16_384, 8192, 4096, 2048];

/**
 * The largest context length at which this model tag fits in the PC's memory (VRAM and RAM
 * together), or null when the tag is not in the catalog. Used to cap the one context length a
 * model gets for every call (Ollama reloads a model whenever the context length changes).
 */
export function maxContextFor(
  hw: HardwareProfile,
  tag: string,
  catalog: ModelCatalog = DEFAULT_CATALOG,
): number | null {
  const want = tag.replace(/:latest$/, "");
  const budget = memoryBudget(hw);
  for (const model of catalog.models) {
    const qi = model.quantizations.find((q) => q.tag === tag || q.tag === want);
    if (!qi) continue;
    const steps = CONTEXT_STEPS.filter((c) => c <= model.contextMax);
    for (const ctx of steps) if (fitOn(model, qi, ctx, budget, 1)) return ctx;
    return steps.at(-1) ?? null;
  }
  return null;
}

/**
 * Scale estimates by a real measurement: predict the benchmarked model's speed with the same
 * formula and compare. Clamped so one odd run can't distort the plan wildly.
 */
function calibrate(hw: HardwareProfile, cat: ModelCatalog, b: ReturnType<typeof memoryBudget>): number {
  const bench = hw.benchmark;
  if (!bench?.catalogId) return 1;
  const model = cat.models.find((m) => m.id === bench.catalogId);
  if (!model) return 1;
  const qi =
    model.quantizations.find((q) => q.tag === bench.model) ??
    model.quantizations.find((q) => q.quant === "q4_K_M") ??
    model.quantizations[0];
  if (!qi) return 1;
  const fit = fitOn(model, qi, 4096, b, 1);
  if (!fit) return 1;
  return Math.min(4, Math.max(0.25, bench.tokensPerSec / fit.speed));
}

function headlineFor(coder: RolePlan | undefined): string {
  if (!coder) return "No coding model fits this PC. You can connect a stronger PC on your network.";
  if (coder.qualityLabel === "Excellent") {
    return coder.speedLabel === "Fast" || coder.speedLabel === "Good"
      ? "Your PC runs top-tier models at a good speed."
      : "Your PC runs top-tier models. Some are slow, so Depo queues work for them.";
  }
  if (coder.qualityLabel === "Basic") {
    return "Your PC runs small models. Depo will compensate with smaller steps and more testing.";
  }
  return "Your PC runs strong models. Depo adds extra checking where it had to step down.";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

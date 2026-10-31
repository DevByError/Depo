import { z } from "zod";
import defaultCatalogJson from "../catalog/models-catalog.json";

/**
 * The model catalog: every model Depo knows how to plan for. It ships with the app and can be
 * replaced at runtime (Models screen → Update catalog) so stronger models can be added without
 * a new release. Sizes are in GB (10^9 bytes); parameters in billions.
 */
export const ROLES = ["coder", "reasoning", "vision", "embedding", "fast"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const QUANTS = ["fp16", "q8_0", "q6_K", "q5_K_M", "q4_K_M", "mxfp4"] as const;
export const QuantSchema = z.enum(QUANTS);
export type Quant = z.infer<typeof QuantSchema>;

/** Average bits per weight in a GGUF file, used when the catalog gives no exact size. */
export const BITS_PER_WEIGHT: Record<Quant, number> = {
  fp16: 16,
  q8_0: 8.5,
  q6_K: 6.56,
  q5_K_M: 5.69,
  q4_K_M: 4.85,
  mxfp4: 4.25,
};

/** How much of the full-precision quality a quantization keeps (rough, from published evals). */
export const QUANT_QUALITY: Record<Quant, number> = {
  fp16: 1,
  q8_0: 1,
  q6_K: 0.99,
  q5_K_M: 0.975,
  q4_K_M: 0.95,
  // gpt-oss is trained for MXFP4: it is the native precision, not a reduction.
  mxfp4: 1,
};

export const CatalogQuantSchema = z.object({
  quant: QuantSchema,
  /** Ollama tag to pull, e.g. `qwen3-coder:30b-a3b-q8_0`. */
  tag: z.string().min(1),
  /** Exact download size when known; otherwise estimated from parameters × bits. */
  sizeGB: z.number().positive().optional(),
});

export const CatalogModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/),
  name: z.string().min(1),
  family: z.string().min(1),
  paramsB: z.number().positive(),
  /** Active parameters per token for mixture-of-experts models. */
  activeParamsB: z.number().positive().optional(),
  contextMax: z.number().int().positive(),
  /** KV-cache bytes per token of context at f16 (2 × layers × kv_heads × head_dim × 2). */
  kvBytesPerToken: z.number().int().nonnegative(),
  /** Extra memory beyond weights + KV, e.g. a vision projector. */
  extraGB: z.number().nonnegative().default(0),
  capabilities: z.array(z.enum(["tools", "vision", "thinking", "embedding", "json"])).default([]),
  /** Relative strength per role, 0–100. Higher is better; only roles listed are considered. */
  scores: z.partialRecord(RoleSchema, z.number().min(0).max(100)),
  quantizations: z.array(CatalogQuantSchema).min(1),
  license: z.string().optional(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const ModelCatalogSchema = z.object({
  version: z.number().int().positive(),
  updated: z.string(),
  models: z.array(CatalogModelSchema).min(1),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export function parseCatalog(json: unknown): ModelCatalog {
  const cat = ModelCatalogSchema.parse(json);
  const ids = new Set<string>();
  for (const m of cat.models) {
    if (ids.has(m.id)) throw new Error(`Duplicate catalog id: ${m.id}`);
    ids.add(m.id);
  }
  return cat;
}

export const DEFAULT_CATALOG: ModelCatalog = parseCatalog(defaultCatalogJson);

export function weightsGB(model: CatalogModel, q: z.infer<typeof CatalogQuantSchema>): number {
  return q.sizeGB ?? (model.paramsB * BITS_PER_WEIGHT[q.quant]) / 8;
}

/** Bytes read from memory to produce one token: the active weights. */
export function activeGB(model: CatalogModel, q: z.infer<typeof CatalogQuantSchema>): number {
  const total = weightsGB(model, q);
  return model.activeParamsB ? (total * model.activeParamsB) / model.paramsB : total;
}

export function kvGB(model: CatalogModel, contextLength: number): number {
  return (model.kvBytesPerToken * contextLength) / 1e9;
}

/** Fixed runtime overhead: compute buffers, CUDA context, graph. */
export const RUNTIME_OVERHEAD_GB = 0.6;

export function memoryNeedGB(
  model: CatalogModel,
  q: z.infer<typeof CatalogQuantSchema>,
  contextLength: number,
): number {
  return weightsGB(model, q) + kvGB(model, contextLength) + model.extraGB + RUNTIME_OVERHEAD_GB;
}

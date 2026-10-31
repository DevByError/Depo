import { z } from "zod";

/** What the hardware profiler found. Produced by the engine, consumed by the Auto-Fit planner. */
export const GpuSchema = z.object({
  name: z.string(),
  vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
  vramGB: z.number().nonnegative(),
  /** Where the number came from, e.g. `nvidia-smi`, `registry`, `unified`. */
  source: z.string(),
  /** Measured or estimated memory bandwidth, GB/s. */
  bandwidthGBs: z.number().positive().optional(),
});
export type Gpu = z.infer<typeof GpuSchema>;

export const BenchmarkSchema = z.object({
  /** Catalog id of the benchmarked model, if it is in the catalog. */
  catalogId: z.string().nullable(),
  model: z.string(),
  tokensPerSec: z.number().positive(),
  promptTokensPerSec: z.number().positive().nullable(),
  at: z.string(),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

export const HardwareProfileSchema = z.object({
  os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
  cpu: z.object({
    model: z.string(),
    threads: z.number().int().positive(),
    avx: z.boolean().nullable(),
    avx2: z.boolean().nullable(),
    avx512: z.boolean().nullable(),
  }),
  ramGB: z.number().positive(),
  /** Apple Silicon and similar: GPU and CPU share one memory pool. */
  unifiedMemory: z.boolean(),
  gpus: z.array(GpuSchema),
  diskFreeGB: z.number().nonnegative().nullable(),
  benchmark: BenchmarkSchema.nullable(),
  profiledAt: z.string(),
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

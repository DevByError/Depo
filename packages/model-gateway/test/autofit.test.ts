import { describe, expect, test } from "bun:test";
import {
  AutoFitPlanSchema,
  autoFit,
  DEFAULT_CATALOG,
  type HardwareProfile,
  memoryBudget,
  memoryNeedGB,
  parseCatalog,
} from "../src/index";

function hw(vramGB: number, ramGB: number, extra: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: { platform: "win32", release: "10.0.26100", arch: "x64" },
    cpu: { model: "Test CPU", threads: 16, avx: true, avx2: true, avx512: false },
    ramGB,
    unifiedMemory: false,
    gpus: vramGB ? [{ name: "Test GPU", vendor: "nvidia", vramGB, source: "nvidia-smi" }] : [],
    diskFreeGB: 500,
    benchmark: null,
    profiledAt: "2026-10-31T00:00:00Z",
    ...extra,
  };
}

const allRoles = (p: ReturnType<typeof autoFit>) => Object.values(p.roles);

describe("model catalog", () => {
  test("default catalog is valid and covers every role", () => {
    for (const role of ["coder", "reasoning", "vision", "embedding", "fast"] as const) {
      expect(DEFAULT_CATALOG.models.some((m) => m.scores[role] !== undefined)).toBe(true);
    }
    const tags = DEFAULT_CATALOG.models.flatMap((m) => m.quantizations.map((q) => q.tag));
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("rejects duplicates and malformed entries", () => {
    const m = DEFAULT_CATALOG.models[0];
    expect(() => parseCatalog({ version: 1, updated: "x", models: [m, m] })).toThrow(/Duplicate/);
    expect(() => parseCatalog({ version: 1, updated: "x", models: [{ ...m, paramsB: -1 }] })).toThrow();
  });

  test("memory need includes weights, KV cache and overhead", () => {
    const m = DEFAULT_CATALOG.models.find((x) => x.id === "qwen2.5-coder-7b");
    const q4 = m?.quantizations.find((q) => q.quant === "q4_K_M");
    if (!m || !q4) throw new Error("catalog entry missing");
    // 7.6B × 4.85 bits ≈ 4.6 GB, + 32k × 57 KB ≈ 1.9 GB, + 0.6 GB
    expect(memoryNeedGB(m, q4, 32768)).toBeCloseTo(7.08, 1);
  });
});

describe("Auto-Fit planner", () => {
  test("weak laptop (4 GB VRAM, 24 GB RAM): MoE coder split, gpt-oss-20b reasoning, Quality-First on", () => {
    const p = autoFit(hw(4, 24));
    expect(p.roles.coder?.modelId).toBe("qwen3-coder-30b");
    expect(p.roles.coder?.placement).toBe("split");
    expect(p.roles.coder?.strategy).toBe(4);
    expect(p.roles.reasoning?.modelId).toBe("gpt-oss-20b");
    expect(p.roles.vision).toBeDefined();
    expect(p.roles.vision?.memoryGB).toBeLessThan(25);
    expect(p.qualityFirst.active).toBe(true);
    expect(p.qualityFirst.measures.length).toBeGreaterThan(3);
  });

  test("mid desktop (16 GB VRAM, 64 GB RAM): 30B-class coder, 120B-class reasoning with RAM offload", () => {
    const p = autoFit(hw(16, 64));
    expect(p.roles.coder?.modelId).toBe("qwen3-coder-30b");
    expect(p.roles.reasoning?.modelId).toBe("gpt-oss-120b");
    expect(p.roles.reasoning?.placement).toBe("split");
  });

  test("strong desktop (48 GB VRAM, 128 GB RAM): top coder on GPU at high precision, gpt-oss-120b", () => {
    const p = autoFit(hw(48, 128));
    expect(p.roles.coder).toMatchObject({ modelId: "qwen3-coder-30b", quant: "q8_0", placement: "gpu" });
    expect(p.roles.reasoning?.modelId).toBe("gpt-oss-120b");
    expect(p.headline).toContain("top-tier");
  });

  test("workstation (2 × 48 GB, 256 GB RAM): largest models", () => {
    const p = autoFit(
      hw(0, 256, {
        gpus: [
          { name: "A", vendor: "nvidia", vramGB: 48, source: "nvidia-smi" },
          { name: "B", vendor: "nvidia", vramGB: 48, source: "nvidia-smi" },
        ],
      }),
    );
    expect(p.budget.gpuGB).toBeGreaterThan(85);
    expect(p.roles.reasoning?.placement).toBe("gpu");
    expect(p.roles.vision?.modelId).toBe("qwen3-vl-235b");
  });

  test("no GPU: CPU-only plan that still works", () => {
    const p = autoFit(hw(0, 16));
    for (const r of allRoles(p)) expect(r.placement).toBe("cpu");
    expect(p.roles.coder).toBeDefined();
    expect(p.roles.coder?.estTokensPerSec).toBeGreaterThanOrEqual(4);
  });

  test("unified memory (Apple Silicon) puts everything on the GPU pool", () => {
    const p = autoFit(
      hw(0, 64, {
        unifiedMemory: true,
        gpus: [{ name: "M3 Max", vendor: "apple", vramGB: 64, source: "unified", bandwidthGBs: 400 }],
      }),
    );
    expect(p.budget.ramGB).toBe(0);
    expect(p.roles.coder?.placement).toBe("gpu");
  });

  test("tiny machine reports what is missing instead of guessing", () => {
    const p = autoFit(hw(0, 4));
    expect(p.unavailable.reasoning).toBeDefined();
    expect(p.headline.length).toBeGreaterThan(10);
  });

  test("balanced mode demands more speed than max quality", () => {
    const max = autoFit(hw(4, 16), { mode: "max_quality" });
    const bal = autoFit(hw(4, 16), { mode: "balanced" });
    expect(bal.mode).toBe("balanced");
    expect(bal.roles.coder?.estTokensPerSec ?? 0).toBeGreaterThanOrEqual(10);
    expect(max.roles.coder?.estTokensPerSec ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("never steps down further than needed: more memory never yields a weaker coder", () => {
    let last = 0;
    for (const [v, r] of [
      [0, 8],
      [0, 16],
      [4, 16],
      [4, 24],
      [8, 32],
      [12, 32],
      [16, 64],
      [24, 64],
      [48, 128],
    ] as const) {
      const p = autoFit(hw(v, r));
      const id = p.roles.coder?.modelId;
      const score = DEFAULT_CATALOG.models.find((m) => m.id === id)?.scores.coder ?? 0;
      expect(score).toBeGreaterThanOrEqual(last);
      last = score;
    }
  });

  test("a real benchmark scales speed estimates", () => {
    const base = autoFit(hw(8, 32));
    const slow = autoFit(
      hw(8, 32, {
        benchmark: {
          catalogId: "qwen2.5-coder-1.5b",
          model: "qwen2.5-coder:1.5b",
          tokensPerSec: 20,
          promptTokensPerSec: null,
          at: "x",
        },
      }),
    );
    expect(slow.budget.calibration).toBeLessThan(1);
    expect(slow.roles.fast?.estTokensPerSec ?? 0).toBeLessThan(base.roles.fast?.estTokensPerSec ?? 0);
  });

  test("plan matches its schema and speaks in plain words", () => {
    const p = autoFit(hw(4, 24));
    expect(AutoFitPlanSchema.parse(p)).toEqual(p);
    expect(p.roles.coder?.summary).toMatch(
      /^Your PC can run .+ Expect about \d+ tokens\/sec\. Quality: \w+, Speed: [\w ]+\.$/,
    );
  });

  test("budget leaves room for the OS and ignores tiny GPUs", () => {
    const b = memoryBudget(
      hw(0, 32, { gpus: [{ name: "iGPU", vendor: "intel", vramGB: 0.5, source: "registry" }] }),
    );
    expect(b.gpuGB).toBe(0);
    expect(b.ramGB).toBeCloseTo(28.8, 1);
  });
});

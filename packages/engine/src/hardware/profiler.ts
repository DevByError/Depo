import fs from "node:fs";
import os from "node:os";
import type { Gpu, HardwareProfile } from "@depo/model-gateway";
import { type CommandRunner, runCommand } from "./run";

const GB = 1e9;

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(out: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    const [name, mib] = parts;
    const n = Number(mib);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    gpus.push({ name, vendor: "nvidia", vramGB: round1((n * 1024 * 1024) / GB), source: "nvidia-smi" });
  }
  return gpus;
}

export function vendorOf(name: string): Gpu["vendor"] {
  const s = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|tesla/.test(s)) return "nvidia";
  if (/amd|radeon|advanced micro/.test(s)) return "amd";
  if (/intel|arc|iris|uhd/.test(s)) return "intel";
  if (/apple/.test(s)) return "apple";
  return "other";
}

const VIRTUAL_ADAPTER =
  /basic display|basic render|remote|parsec|virtual|hyper-v|vmware|virtualbox|citrix|spacedesk|idd/i;

/**
 * Display adapters from the registry (PowerShell, see WINDOWS_GPU_SCRIPT). Unlike WMI's
 * AdapterRAM, `HardwareInformation.qwMemorySize` is 64-bit, so cards above 4 GB report correctly.
 */
export function parseWindowsGpuJson(out: string): Gpu[] {
  let rows: unknown;
  try {
    rows = JSON.parse(out);
  } catch {
    return [];
  }
  const list = Array.isArray(rows) ? rows : [rows];
  const gpus: Gpu[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const name = typeof row.DriverDesc === "string" ? row.DriverDesc.trim() : "";
    if (!name || VIRTUAL_ADAPTER.test(name)) continue;
    const qw = Number(row.qw);
    const dw = Number(row.dw);
    const bytes = Number.isFinite(qw) && qw > 0 ? qw : Number.isFinite(dw) && dw > 0 ? dw : 0;
    gpus.push({ name, vendor: vendorOf(name), vramGB: round1(bytes / GB), source: "registry" });
  }
  return gpus;
}

export const WINDOWS_GPU_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' |",
  "Where-Object { $_.PSChildName -match '^\\d{4}$' } | ForEach-Object {",
  "$p = Get-ItemProperty $_.PSPath;",
  "$dw = $p.'HardwareInformation.MemorySize'; if ($dw -is [byte[]]) { $dw = [BitConverter]::ToUInt32($dw, 0) };",
  "[pscustomobject]@{ DriverDesc = $p.DriverDesc; qw = $p.'HardwareInformation.qwMemorySize'; dw = $dw } } |",
  "ConvertTo-Json -Compress",
].join(" ");

/** rocm-smi --showmeminfo vram --json --showproductname */
export function parseRocmSmi(out: string): Gpu[] {
  let j: Record<string, Record<string, string>>;
  try {
    j = JSON.parse(out);
  } catch {
    return [];
  }
  const gpus: Gpu[] = [];
  for (const [key, v] of Object.entries(j)) {
    if (!key.startsWith("card")) continue;
    const total = Number(v["VRAM Total Memory (B)"]);
    if (!Number.isFinite(total) || total <= 0) continue;
    const name = v["Card Series"] ?? v["Card series"] ?? v["Card Model"] ?? "AMD GPU";
    gpus.push({ name, vendor: "amd", vramGB: round1(total / GB), source: "rocm-smi" });
  }
  return gpus;
}

export function parseCpuFlags(cpuinfo: string): { avx: boolean; avx2: boolean; avx512: boolean } | null {
  const line = cpuinfo.split("\n").find((l) => /^(flags|Features)\s*:/.test(l));
  if (!line) return null;
  const flags = new Set(line.split(":")[1]?.trim().split(/\s+/));
  return { avx: flags.has("avx"), avx2: flags.has("avx2"), avx512: flags.has("avx512f") };
}

/** Windows: kernel32!IsProcessorFeaturePresent (PF_AVX=39, PF_AVX2=40, PF_AVX512F=41). */
async function windowsCpuFlags(): Promise<{ avx: boolean; avx2: boolean; avx512: boolean } | null> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 },
    });
    const has = (f: number) => lib.symbols.IsProcessorFeaturePresent(f) !== 0;
    const r = { avx: has(39), avx2: has(40), avx512: has(41) };
    lib.close();
    return r;
  } catch {
    return null;
  }
}

export interface ProfilerDeps {
  platform: NodeJS.Platform;
  arch: string;
  run: CommandRunner;
  readFile: (p: string) => string | null;
  /** Folder whose drive holds the model store, for the free-space check. */
  diskPath: string;
}

function defaultDeps(diskPath: string): ProfilerDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    run: runCommand,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    diskPath,
  };
}

export async function detectGpus(deps: ProfilerDeps): Promise<{ gpus: Gpu[]; unified: boolean }> {
  if (deps.platform === "darwin" && deps.arch === "arm64") {
    const name = (await deps.run(["sysctl", "-n", "machdep.cpu.brand_string"]))?.trim() || "Apple Silicon";
    return {
      gpus: [{ name, vendor: "apple", vramGB: round1(os.totalmem() / GB), source: "unified" }],
      unified: true,
    };
  }
  const smi = await deps.run([
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  const nvidia = smi ? parseNvidiaSmi(smi) : [];
  let others: Gpu[] = [];
  if (deps.platform === "win32") {
    const out = await deps.run([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_GPU_SCRIPT,
    ]);
    others = out ? parseWindowsGpuJson(out) : [];
    if (nvidia.length) others = others.filter((g) => g.vendor !== "nvidia");
  } else if (deps.platform === "linux") {
    const out = await deps.run(["rocm-smi", "--showmeminfo", "vram", "--showproductname", "--json"]);
    others = out ? parseRocmSmi(out) : [];
  }
  return { gpus: [...nvidia, ...others], unified: false };
}

async function cpuFlags(deps: ProfilerDeps) {
  if (deps.platform === "win32") return windowsCpuFlags();
  if (deps.platform === "linux") {
    const info = deps.readFile("/proc/cpuinfo");
    return info ? parseCpuFlags(info) : null;
  }
  if (deps.platform === "darwin" && deps.arch === "x64") {
    const out =
      (await deps.run(["sysctl", "-n", "machdep.cpu.features", "machdep.cpu.leaf7_features"])) ?? "";
    const f = new Set(out.toUpperCase().split(/\s+/));
    return { avx: f.has("AVX1.0"), avx2: f.has("AVX2"), avx512: f.has("AVX512F") };
  }
  return null;
}

export function diskFreeGB(p: string): number | null {
  try {
    const s = fs.statfsSync(p);
    return round1((s.bavail * s.bsize) / GB);
  } catch {
    return null;
  }
}

/** Profile this machine. Takes a few seconds on Windows (PowerShell start-up). */
export async function profileHardware(
  diskPath: string,
  overrides: Partial<ProfilerDeps> = {},
): Promise<Omit<HardwareProfile, "benchmark">> {
  const deps = { ...defaultDeps(diskPath), ...overrides };
  const [{ gpus, unified }, flags] = await Promise.all([detectGpus(deps), cpuFlags(deps)]);
  const cpus = os.cpus();
  return {
    os: { platform: deps.platform, release: os.release(), arch: deps.arch },
    cpu: {
      model: cpus[0]?.model.trim() || "Unknown CPU",
      threads: Math.max(1, cpus.length),
      avx: flags?.avx ?? null,
      avx2: flags?.avx2 ?? null,
      avx512: flags?.avx512 ?? null,
    },
    ramGB: round1(os.totalmem() / GB),
    unifiedMemory: unified,
    gpus,
    diskFreeGB: diskFreeGB(deps.diskPath),
    profiledAt: new Date().toISOString(),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

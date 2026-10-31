import { describe, expect, test } from "bun:test";
import {
  detectGpus,
  parseCpuFlags,
  parseNvidiaSmi,
  parseRocmSmi,
  parseWindowsGpuJson,
  profileHardware,
  vendorOf,
} from "../src/hardware/profiler";

describe("hardware profiler parsers", () => {
  test("nvidia-smi CSV (MiB) to GB", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564\r\nNVIDIA GeForce RTX 3060, 12288\n")).toEqual([
      { name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vramGB: 25.8, source: "nvidia-smi" },
      { name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramGB: 12.9, source: "nvidia-smi" },
    ]);
    expect(parseNvidiaSmi("")).toEqual([]);
    expect(parseNvidiaSmi("garbage")).toEqual([]);
  });

  test("Windows registry adapters: 64-bit size wins, virtual adapters dropped", () => {
    const json = JSON.stringify([
      { DriverDesc: "AMD Radeon RX 7800 XT", qw: 17163091968, dw: 4293918720 },
      { DriverDesc: "Intel(R) UHD Graphics 770", qw: null, dw: 134217728 },
      { DriverDesc: "Microsoft Basic Display Adapter", qw: null, dw: null },
      { DriverDesc: "Parsec Virtual Display Adapter", qw: null, dw: 0 },
    ]);
    expect(parseWindowsGpuJson(json)).toEqual([
      { name: "AMD Radeon RX 7800 XT", vendor: "amd", vramGB: 17.2, source: "registry" },
      { name: "Intel(R) UHD Graphics 770", vendor: "intel", vramGB: 0.1, source: "registry" },
    ]);
    // PowerShell emits a bare object (not an array) when there is one adapter.
    expect(
      parseWindowsGpuJson(JSON.stringify({ DriverDesc: "Intel(R) Arc(TM) A770", qw: 16e9 })),
    ).toHaveLength(1);
    expect(parseWindowsGpuJson("not json")).toEqual([]);
  });

  test("rocm-smi JSON", () => {
    const out = JSON.stringify({
      card0: { "VRAM Total Memory (B)": "25753026560", "Card Series": "Radeon RX 7900 XTX" },
      system: { "Driver version": "6.x" },
    });
    expect(parseRocmSmi(out)).toEqual([
      { name: "Radeon RX 7900 XTX", vendor: "amd", vramGB: 25.8, source: "rocm-smi" },
    ]);
  });

  test("cpu flags from /proc/cpuinfo", () => {
    expect(parseCpuFlags("processor: 0\nflags\t\t: fpu sse avx avx2 fma\n")).toEqual({
      avx: true,
      avx2: true,
      avx512: false,
    });
    expect(parseCpuFlags("nothing")).toBeNull();
  });

  test("vendor detection", () => {
    expect(vendorOf("NVIDIA RTX A6000")).toBe("nvidia");
    expect(vendorOf("AMD Radeon 780M Graphics")).toBe("amd");
    expect(vendorOf("Intel(R) Arc(TM) Graphics")).toBe("intel");
    expect(vendorOf("Moore Threads MTT S80")).toBe("other");
  });
});

describe("profileHardware", () => {
  test("Windows: nvidia-smi plus registry, NVIDIA not double-counted", async () => {
    const calls: string[] = [];
    const run = async (cmd: string[]) => {
      calls.push(cmd[0] ?? "");
      if (cmd[0] === "nvidia-smi") return "NVIDIA GeForce RTX 4060 Laptop GPU, 8188\n";
      if (cmd[0] === "powershell.exe")
        return JSON.stringify([
          { DriverDesc: "NVIDIA GeForce RTX 4060 Laptop GPU", qw: 8589934592 },
          { DriverDesc: "AMD Radeon(TM) Graphics", qw: 536870912 },
        ]);
      return null;
    };
    const { gpus, unified } = await detectGpus({
      platform: "win32",
      arch: "x64",
      run,
      readFile: () => null,
      diskPath: ".",
    });
    expect(unified).toBe(false);
    expect(gpus.map((g) => [g.vendor, g.source])).toEqual([
      ["nvidia", "nvidia-smi"],
      ["amd", "registry"],
    ]);
    expect(calls).toEqual(["nvidia-smi", "powershell.exe"]);
  });

  test("no GPU tools at all still yields a usable profile", async () => {
    const p = await profileHardware(".", {
      platform: "linux",
      arch: "x64",
      run: async () => null,
      readFile: () => "flags : avx avx2 avx512f",
    });
    expect(p.gpus).toEqual([]);
    expect(p.cpu.avx512).toBe(true);
    expect(p.ramGB).toBeGreaterThan(0);
    expect(p.cpu.threads).toBeGreaterThan(0);
    expect(p.diskFreeGB).not.toBeNull();
  });

  test("Apple Silicon reports unified memory", async () => {
    const p = await profileHardware(".", {
      platform: "darwin",
      arch: "arm64",
      run: async () => "Apple M3 Max\n",
      readFile: () => null,
    });
    expect(p.unifiedMemory).toBe(true);
    expect(p.gpus[0]).toMatchObject({ name: "Apple M3 Max", vendor: "apple", source: "unified" });
  });

  test("real profile of this machine completes", async () => {
    const p = await profileHardware(".");
    expect(p.os.platform).toBe(process.platform);
    expect(p.ramGB).toBeGreaterThan(0);
  });
});

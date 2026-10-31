#!/usr/bin/env bun
/**
 * Compile the engine into a single executable and place it where Tauri expects the sidecar:
 *   apps/desktop/src-tauri/binaries/depo-engine-<rust target triple>[.exe]
 *
 * Usage: bun scripts/build-engine.ts [--target <rust triple>]
 * Default target is the host triple reported by `rustc -vV` (falls back to the current platform).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

const BUN_TARGETS: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
};

function hostTriple(): string {
  try {
    const out = Bun.spawnSync(["rustc", "-vV"]).stdout.toString();
    const m = out.match(/^host:\s*(\S+)/m);
    if (m?.[1]) return m[1];
  } catch {
    // rustc not installed: fall through
  }
  if (process.platform === "win32")
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (process.platform === "darwin")
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

const argIdx = process.argv.indexOf("--target");
const triple = argIdx > -1 ? process.argv[argIdx + 1] : hostTriple();
if (!triple || !BUN_TARGETS[triple]) {
  console.error(`Unsupported target: ${triple}. Known: ${Object.keys(BUN_TARGETS).join(", ")}`);
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "apps/desktop/src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, `depo-engine-${triple}${triple.includes("windows") ? ".exe" : ""}`);

const args = [
  "build",
  "--compile",
  "--minify",
  `--target=${BUN_TARGETS[triple]}`,
  path.join(root, "packages/engine/src/main.ts"),
  "--outfile",
  outfile,
];
if (triple.includes("windows")) args.push("--windows-hide-console");

console.log(`Building engine sidecar for ${triple} -> ${path.relative(root, outfile)}`);
const res = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(res.exitCode ?? 1);

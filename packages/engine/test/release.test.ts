import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DEPO_VERSION } from "@depo/shared";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const jsonVersion = (rel: string) => (JSON.parse(read(rel)) as { version: string }).version;

test("every place that carries the version says the same thing", () => {
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1];
  const versions = {
    shared: DEPO_VERSION,
    root: jsonVersion("package.json"),
    desktop: jsonVersion("apps/desktop/package.json"),
    engine: jsonVersion("packages/engine/package.json"),
    gateway: jsonVersion("packages/model-gateway/package.json"),
    sharedPackage: jsonVersion("packages/shared/package.json"),
    tauri: jsonVersion("apps/desktop/src-tauri/tauri.conf.json"),
    cargo,
  };
  expect(new Set(Object.values(versions)).size, JSON.stringify(versions)).toBe(1);
});

test("set-version refuses anything that is not a version and leaves the files alone", () => {
  const before = read("package.json");
  const r = Bun.spawnSync(["bun", "scripts/set-version.ts", "latest; rm -rf /"], { cwd: root });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("Give a version");
  expect(read("package.json")).toBe(before);
});

test("the release workflow builds only from tags, checks first, and never prints secrets", () => {
  const wf = read(".github/workflows/release.yml");
  expect(wf).toContain("tags:");
  expect(wf).toContain("bun run check");
  expect(wf).toContain("secrets.");
  // Secrets are only passed through env, never echoed.
  expect(/echo[^\n]*secrets\./.test(wf)).toBe(false);
  // The workflow must refuse a tag that does not match the app version.
  expect(wf).toContain("DEPO_VERSION");
});

test("the app icon, installer art and the documented release steps exist", () => {
  for (const f of [
    "apps/desktop/src-tauri/icons/icon.ico",
    "apps/desktop/src-tauri/installer/hooks.nsh",
    "docs/RELEASE.md",
  ])
    expect(fs.existsSync(path.join(root, f)), f).toBe(true);
});

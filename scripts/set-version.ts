/**
 * Set the version everywhere it lives, so an installer, the engine and the UI never disagree.
 *   bun scripts/set-version.ts 0.2.0
 * Files: root + workspace package.json, apps/desktop/src-tauri/tauri.conf.json and Cargo.toml,
 * and DEPO_VERSION in packages/shared/src/index.ts. Prints what it changed; changes nothing on a bad input.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Give a version like 0.2.0 or 0.2.0-beta.1, for example: bun scripts/set-version.ts 0.2.0");
  process.exit(1);
}

function edit(rel: string, change: (text: string) => string) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = change(before);
  if (after === before) console.log(`  unchanged  ${rel}`);
  else {
    fs.writeFileSync(file, after);
    console.log(`  updated    ${rel}`);
  }
}

const json = (rel: string) => edit(rel, (t) => t.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));

for (const rel of [
  "package.json",
  "apps/desktop/package.json",
  "packages/engine/package.json",
  "packages/model-gateway/package.json",
  "packages/shared/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
]) {
  json(rel);
}
edit("apps/desktop/src-tauri/Cargo.toml", (t) =>
  t.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
);
edit("packages/shared/src/index.ts", (t) =>
  t.replace(/(export const DEPO_VERSION = ")[^"]+(")/, `$1${version}$2`),
);
console.log(
  `Version is now ${version}. Next: update the docs, run "bun run check", commit, and tag v${version}.`,
);

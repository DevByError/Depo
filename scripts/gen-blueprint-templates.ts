/**
 * Writes packages/engine/src/blueprints/templates-<id>.ts: a text import of every template file
 * under files/<id>/, so `bun build --compile` embeds them in the engine. Run it after adding or
 * removing a .tpl file:  bun scripts/gen-blueprint-templates.ts  (it formats them with biome).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../packages/engine/src/blueprints");
const SETS: Record<string, string> = {
  "fastapi-service": "FASTAPI_TEMPLATES",
  "react-web-app": "WEB_TEMPLATES",
  fullstack: "FULLSTACK_TEMPLATES",
  "next-bun-mysql": "NEXT_BUN_TEMPLATES",
};

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.name.endsWith(".tpl")) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function ident(rel: string, used: Set<string>): string {
  const base = rel
    .replace(/\.tpl$/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const parts = base.split("_");
  let name =
    (parts[0] ?? "").toLowerCase() +
    parts
      .slice(1)
      .map((p) => p.slice(0, 1).toUpperCase() + p.slice(1))
      .join("");
  if (!/^[A-Za-z]/.test(name)) name = `t${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
  let out = name;
  for (let n = 2; used.has(out); n++) out = `${name}${n}`;
  used.add(out);
  return out;
}

const written: string[] = [];
for (const [folder, constant] of Object.entries(SETS)) {
  // Plain code-point order, the same on every platform.
  const rels = walk(path.join(ROOT, "files", folder)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const used = new Set<string>();
  const lines = [
    `// Generated list of the ${folder} blueprint's template files (files/${folder}), embedded as text so`,
    "// `bun build --compile` ships them inside the engine. Every .tpl file there must be listed here;",
    "// blueprints.test.ts checks it. Regenerate with: bun scripts/gen-blueprint-templates.ts",
  ];
  const entries: string[] = [];
  for (const rel of rels) {
    const name = ident(rel, used);
    lines.push(`import ${name} from "./files/${folder}/${rel}" with { type: "text" };`);
    entries.push(`  "${rel.replace(/\.tpl$/, "")}": ${name},`);
  }
  lines.push("", `export const ${constant}: Record<string, string> = {`, ...entries, "};");
  const out = path.join(ROOT, `templates-${folder}.ts`);
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  written.push(out);
  console.log(`${path.relative(process.cwd(), out)}: ${rels.length} files`);
}
// Biome sorts the imports its own way; format so the files stay lint-clean.
Bun.spawnSync(["bunx", "biome", "check", "--write", ...written], { stdout: "inherit", stderr: "inherit" });

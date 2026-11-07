import fs from "node:fs";
import path from "node:path";
import type { BlueprintDetail, BlueprintSummary } from "@depo/shared";
import { FASTAPI_SERVICE } from "./fastapi-service";
import { FULLSTACK } from "./fullstack";
import { REACT_WEB_APP } from "./react-web-app";
import type { Blueprint, BlueprintFile, BlueprintVars } from "./types";

export type { Blueprint, BlueprintFile, BlueprintManifest, BlueprintVars } from "./types";

/** The blueprints, the most complete first. */
export const BLUEPRINTS: Blueprint[] = [FULLSTACK, FASTAPI_SERVICE, REACT_WEB_APP];

export function findBlueprint(id: string): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id.trim().toLowerCase());
}

const SAMPLE: BlueprintVars = { name: "my-app" };

export function blueprintSummary(b: Blueprint): BlueprintSummary {
  return {
    id: b.id,
    title: b.title,
    summary: b.summary,
    stack: b.stack,
    features: b.features,
    runCommand: b.runCommand,
    testCommand: b.testCommand,
    ports: b.ports,
    extendGuide: b.extendGuide,
    fileCount: b.files(SAMPLE).length,
  };
}

export function blueprintDetail(b: Blueprint): BlueprintDetail {
  const files = b.files(SAMPLE).map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, "utf8") }));
  return {
    ...blueprintSummary(b),
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
}

// ---- is this folder blank enough for a blueprint? ------------------------------------------

/** Top-level names that do not count as a project: docs, git, editor settings, OS clutter. */
const ALLOWED_DIRS = new Set([".git", ".depo", "docs", ".github", ".vscode", ".idea"]);
const ALLOWED_FILES =
  /^(readme|license|licence|changelog|contributing|code_of_conduct|notice|authors)(\.[a-z0-9]+)?$|\.(md|markdown|txt|rst|adoc)$|^\.(gitignore|gitattributes|editorconfig|ds_store)$|^(thumbs\.db|desktop\.ini)$/i;

/**
 * The top-level entries that make `root` "a project already": anything that is not docs, git or
 * editor settings. Empty means a blueprint may start here.
 */
export function projectEntries(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() ? !ALLOWED_DIRS.has(e.name) : !ALLOWED_FILES.test(e.name)))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
}

export function isBlankProject(root: string): boolean {
  return projectEntries(root).length === 0;
}

// ---- writing ------------------------------------------------------------------------------

/** Name and description from a short README (# Title, then text), to keep the owner's words. */
export function readmeVars(text: string): { name?: string; description?: string } {
  const t = text.replace(/\r\n?/g, "\n").trim();
  const m = /^#\s+(.+)\n?([\s\S]*)$/.exec(t);
  if (!m) return t ? { description: t } : {};
  const description = (m[2] ?? "").trim();
  return { name: (m[1] ?? "").trim(), ...(description ? { description } : {}) };
}

/** Lines of `extra` that `base` does not have yet, appended (for .gitignore and .gitattributes). */
export function mergeLines(base: string, extra: string): string {
  const have = new Set(base.split(/\r?\n/).map((l) => l.trim()));
  const add = extra.split("\n").filter((l) => l.trim() && !have.has(l.trim()));
  if (!add.length) return base;
  return `${base.replace(/\s*$/, "")}\n${add.join("\n")}\n`;
}

export interface PlannedFile extends BlueprintFile {
  /** "new": no file there; "same": identical already; "replace": a short README or a merged list. */
  action: "new" | "same" | "replace";
}

/** README.md longer than this is the owner's own document: it is kept, and the blueprint's skipped. */
const OWN_README_BYTES = 4000;

/**
 * What writing `blueprint` into `root` would do, file by file. Existing docs are respected: a
 * short README keeps the owner's title and text at the top of the blueprint's README, a long one
 * is kept as it is, and .gitignore / .gitattributes get the missing lines appended.
 */
export function planBlueprint(
  root: string,
  blueprint: Blueprint,
  vars: BlueprintVars,
): { files: PlannedFile[]; kept: string[] } {
  const readmePath = path.join(root, "README.md");
  let readme: string | null = null;
  try {
    readme = fs.readFileSync(readmePath, "utf8");
  } catch {
    readme = null;
  }
  const fromReadme = readme && Buffer.byteLength(readme) <= OWN_README_BYTES ? readmeVars(readme) : {};
  const merged: BlueprintVars = {
    name: vars.name.trim() || fromReadme.name || "My app",
    description: vars.description?.trim() || fromReadme.description || "",
  };
  const kept: string[] = [];
  const files: PlannedFile[] = [];
  for (const f of blueprint.files(merged)) {
    const abs = path.join(root, ...f.path.split("/"));
    let current: string | null = null;
    try {
      current = fs.readFileSync(abs, "utf8");
    } catch {
      current = null;
    }
    if (current === null) files.push({ ...f, action: "new" });
    else if (current === f.content) files.push({ ...f, action: "same" });
    else if (f.path === "README.md" && Buffer.byteLength(current) > OWN_README_BYTES) kept.push(f.path);
    else if (f.path === ".gitignore" || f.path === ".gitattributes")
      files.push({ ...f, content: mergeLines(current, f.content), action: "replace" });
    else if (f.path === "README.md") files.push({ ...f, action: "replace" });
    else kept.push(f.path); // never reached in a blank project; listed rather than overwritten
  }
  return { files, kept };
}

/** Write a blueprint into an empty (or docs-only) folder. Returns the files written. */
export function writeBlueprint(root: string, blueprint: Blueprint, vars: BlueprintVars): BlueprintFile[] {
  const others = projectEntries(root);
  if (others.length)
    throw new Error(`The folder already has a project in it (${others.slice(0, 5).join(", ")}).`);
  const { files } = planBlueprint(root, blueprint, vars);
  const written: BlueprintFile[] = [];
  for (const f of files) {
    if (f.action === "same") continue;
    const abs = path.join(root, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    if (f.path.endsWith(".sh") && process.platform !== "win32") fs.chmodSync(abs, 0o755);
    written.push(f);
  }
  return written;
}

/** File paths grouped by folder, in a few lines (for tool output that must stay small). */
export function compactTree(paths: string[], maxChars = 1800): string {
  const byDir = new Map<string, string[]>();
  for (const p of [...paths].sort()) {
    const i = p.lastIndexOf("/");
    const dir = i < 0 ? "." : p.slice(0, i);
    const list = byDir.get(dir) ?? [];
    list.push(i < 0 ? p : p.slice(i + 1));
    byDir.set(dir, list);
  }
  const lines: string[] = [];
  let used = 0;
  for (const [dir, names] of byDir) {
    const line = `${dir === "." ? "(root)" : `${dir}/`}: ${names.join(", ")}`;
    if (used + line.length > maxChars) {
      lines.push(`... and ${byDir.size - lines.length} more folders`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

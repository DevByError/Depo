import fs from "node:fs";
import path from "node:path";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Folders agents never read or write, wherever they appear. */
const BLOCKED_SEGMENTS = new Set([".git", ".depo"]);

/** Normalise a model-supplied relative path to forward slashes without leading `./`. */
export function cleanRel(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Resolve `rel` inside `root` and refuse anything that escapes it: absolute paths, `..`,
 * drive letters, UNC paths, and symlinks/junctions that point outside.
 */
export function resolveInside(root: string, rel: string): { abs: string; rel: string } {
  const r = cleanRel(rel.trim());
  if (r === "" || r === ".") return { abs: path.resolve(root), rel: "." };
  if (path.isAbsolute(r) || /^[a-zA-Z]:/.test(r) || r.startsWith("//")) {
    throw new ToolError(`Use a path relative to the project root, not ${rel}`);
  }
  const parts = r.split("/");
  if (parts.some((s) => s === "..")) throw new ToolError(`Path ${rel} leaves the project folder`);
  if (parts.some((s) => BLOCKED_SEGMENTS.has(s))) throw new ToolError(`Path ${rel} is in a protected folder`);
  // Windows ignores trailing dots/spaces and supports alternate data streams: refuse both.
  if (parts.some((s) => /[. ]$/.test(s) || s.includes(":"))) throw new ToolError(`Invalid path: ${rel}`);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...parts);
  if (!isWithin(rootAbs, abs)) throw new ToolError(`Path ${rel} leaves the project folder`);

  // Follow symlinks on the longest existing prefix and re-check.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== rootAbs) probe = path.dirname(probe);
  const realRoot = fs.realpathSync.native(rootAbs);
  const realProbe = fs.realpathSync.native(probe);
  if (!isWithin(realRoot, realProbe)) throw new ToolError(`Path ${rel} points outside the project folder`);
  return { abs, rel: parts.join("/") };
}

export function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

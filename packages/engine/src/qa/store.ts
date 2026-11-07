import fs from "node:fs";
import path from "node:path";
import { type PageCheck, PageCheckSchema } from "@depo/shared";
import { isWithin } from "../tools/paths";

/**
 * Where page checks keep their files: `<root>/.depo/qa/<check id>/` with one PNG per width, a small
 * thumbnail per width and `check.json`. For a task the root is its private copy (`.depo` is never
 * part of a change set and agents cannot read or write it); for the project folder it is a folder
 * in Depo's own data, so nothing is written into the owner's project.
 */

export const QA_REL = ".depo/qa";
const ID = /^qa_[0-9a-f]{28}$/;
const IMAGE = /^\.depo\/qa\/(qa_[0-9a-f]{28})\/(phone|tablet|desktop)(-thumb)?\.png$/;
/** Checks kept per root; older ones are deleted. */
export const KEEP_CHECKS = 20;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export class QaPathError extends Error {}

export function isCheckId(id: string): boolean {
  return ID.test(id);
}

export function checkDir(root: string, id: string): string {
  if (!ID.test(id)) throw new QaPathError("That is not a page check id.");
  return path.join(root, ".depo", "qa", id);
}

/**
 * Validate a screenshot path that came from the UI and return the real file inside `root`.
 * Only `.depo/qa/<id>/<width>[-thumb].png` is accepted, links may not point elsewhere, and the
 * file must be a regular file of a sane size.
 */
export function resolveCheckImage(root: string, rel: string): string {
  const clean = rel
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  if (!IMAGE.test(clean)) throw new QaPathError("Only screenshots of page checks can be shown.");
  const base = path.resolve(root, ".depo", "qa");
  const abs = path.resolve(root, ...clean.split("/"));
  if (!isWithin(base, abs)) throw new QaPathError("That screenshot is outside the page checks folder.");
  let real: string;
  let realBase: string;
  try {
    real = fs.realpathSync.native(abs);
    realBase = fs.realpathSync.native(base);
  } catch {
    throw new QaPathError("That screenshot no longer exists.");
  }
  if (!isWithin(realBase, real)) throw new QaPathError("That screenshot is outside the page checks folder.");
  const st = fs.statSync(real);
  if (!st.isFile()) throw new QaPathError("That screenshot is not a file.");
  if (st.size > MAX_IMAGE_BYTES) throw new QaPathError("That screenshot is too large to show.");
  return real;
}

export function saveCheck(root: string, check: PageCheck): void {
  const dir = checkDir(root, check.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "check.json"), JSON.stringify(check));
}

export function loadCheck(root: string, id: string): PageCheck | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(checkDir(root, id), "check.json"), "utf8"));
    const parsed = PageCheckSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function checkIds(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, ".depo", "qa"))
      .filter((n) => ID.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The newest checks first (ids sort by time). */
export function listChecks(root: string, limit: number): PageCheck[] {
  const out: PageCheck[] = [];
  for (const id of checkIds(root)) {
    if (out.length >= limit) break;
    const c = loadCheck(root, id);
    if (c) out.push(c);
  }
  return out;
}

/** Delete all but the newest `keep` checks. */
export function pruneChecks(root: string, keep = KEEP_CHECKS): void {
  for (const id of checkIds(root).slice(keep)) {
    try {
      fs.rmSync(checkDir(root, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // locked for a moment: the next prune removes it
    }
  }
}

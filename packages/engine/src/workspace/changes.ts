import fs from "node:fs";
import path from "node:path";
import type { FileChange, Hunk } from "@depo/shared";
import { applyPatch, structuredPatch } from "diff";
import { isBinary } from "../tools/fs-tools";
import { hashBytes, hashFile, type Manifest, walkProject } from "./snapshot";

const CONTEXT_LINES = 3;

function readMaybe(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/**
 * Compare the shadow workspace with the snapshot it was made from. Original text comes from
 * the project itself; if the project file changed since the snapshot, the change is marked
 * as a conflict and the diff is computed against the project's current text.
 */
export function computeChanges(projectRoot: string, shadowRoot: string, manifest: Manifest): FileChange[] {
  const now = new Set(walkProject(shadowRoot));
  const paths = [...new Set([...Object.keys(manifest), ...now])].sort();
  const changes: FileChange[] = [];
  for (const rel of paths) {
    const baseHash = manifest[rel] ?? null;
    const shadowBuf = now.has(rel) ? readMaybe(path.join(shadowRoot, rel)) : null;
    const shadowHash = shadowBuf ? hashBytes(shadowBuf) : null;
    if (shadowHash === baseHash) continue;
    const projectBuf = readMaybe(path.join(projectRoot, rel));
    const projectHash = projectBuf ? hashBytes(projectBuf) : null;
    const conflict = projectHash !== baseHash;
    if (conflict && projectHash === shadowHash) continue; // the same change already landed
    const kind: FileChange["kind"] =
      baseHash === null ? "added" : shadowBuf === null ? "deleted" : "modified";
    const binary =
      (shadowBuf !== null && isBinary(shadowBuf)) || (projectBuf !== null && isBinary(projectBuf));
    let hunks: Hunk[] = [];
    let additions = 0;
    let deletions = 0;
    if (!binary) {
      const oldText = projectBuf?.toString("utf8") ?? "";
      const newText = shadowBuf?.toString("utf8") ?? "";
      const patch = structuredPatch(rel, rel, oldText, newText, "", "", { context: CONTEXT_LINES });
      hunks = patch.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      }));
      for (const h of hunks) {
        for (const l of h.lines) {
          if (l.startsWith("+")) additions++;
          else if (l.startsWith("-")) deletions++;
        }
      }
    }
    changes.push({
      path: rel,
      kind,
      binary,
      additions,
      deletions,
      hunks,
      baseHash,
      conflict,
      status: "pending",
    });
  }
  return changes;
}

/**
 * New content for a project file after applying some hunks of a change to its current text.
 * Returns null when the hunks no longer apply cleanly.
 */
export function applyHunks(current: string, change: FileChange, hunkIndexes: number[]): string | null {
  const selected = hunkIndexes
    .filter((i) => i >= 0 && i < change.hunks.length)
    .sort((a, b) => a - b)
    .map((i) => change.hunks[i] as Hunk);
  if (selected.length === 0) return current;
  const result = applyPatch(current, {
    oldFileName: change.path,
    newFileName: change.path,
    oldHeader: "",
    newHeader: "",
    hunks: selected,
  });
  return result === false ? null : result;
}

export { hashFile };

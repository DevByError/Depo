import fs from "node:fs";
import path from "node:path";

/**
 * A save point of the private copy (ADR-0086): the project's own files as they were before a
 * step, so a step that went wrong can start again from exactly there. Installed packages, build
 * output and Depo's data are left alone (they are not the project's code and can be large).
 */

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  ".data",
  "dist",
  "build",
  "out",
  ".depo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "target",
  ".pytest_cache",
]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface SavePoint {
  /** Relative path (forward slashes) → content. */
  files: Map<string, Buffer>;
  /** Folders that existed (relative). */
  dirs: Set<string>;
}

function walk(
  root: string,
  onFile: (rel: string, abs: string) => boolean,
  onDir?: (rel: string) => void,
): boolean {
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        onDir?.(r);
        stack.push(r);
      } else if (e.isFile()) {
        if (!onFile(r, path.join(root, r))) return false;
      }
    }
  }
  return true;
}

/** The copy's files now, or null when they are too many or too large to keep in memory. */
export function takeSavePoint(root: string): SavePoint | null {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  let total = 0;
  const ok = walk(
    root,
    (rel, abs) => {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        return true;
      }
      // A huge file (a database dump, a binary) is not code a step writes: it stays as it is.
      if (size > MAX_FILE) return true;
      total += size;
      if (total > MAX_TOTAL || files.size >= MAX_FILES) return false;
      try {
        files.set(rel, fs.readFileSync(abs));
      } catch {
        // unreadable: leave it alone
      }
      return true;
    },
    (rel) => dirs.add(rel),
  );
  return ok ? { files, dirs } : null;
}

/** Files that differ from the save point now (changed, added or deleted), relative. */
export function changedSince(root: string, sp: SavePoint, scope?: ReadonlySet<string>): string[] {
  const all = changedAll(root, sp);
  return scope ? all.filter((f) => scope.has(f)) : all;
}

function changedAll(root: string, sp: SavePoint): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  walk(root, (rel, abs) => {
    seen.add(rel);
    const before = sp.files.get(rel);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      return true;
    }
    if (size > MAX_FILE) return true;
    if (!before) out.push(rel);
    else {
      try {
        if (!fs.readFileSync(abs).equals(before)) out.push(rel);
      } catch {
        // unreadable: skip
      }
    }
    return true;
  });
  for (const rel of sp.files.keys()) if (!seen.has(rel)) out.push(rel);
  return out.sort();
}

/**
 * Puts back only the listed files (a step that ran beside others must not undo their work): each
 * gets its save point content back, or is removed when the save point did not have it.
 */
export function restoreFiles(
  root: string,
  sp: SavePoint,
  files: Iterable<string>,
): { restored: string[]; removed: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const before = sp.files.get(rel);
    try {
      if (before === undefined) {
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          removed.push(rel);
        }
      } else {
        let same = false;
        try {
          same = fs.readFileSync(abs).equals(before);
        } catch {
          same = false;
        }
        if (!same) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, before);
          restored.push(rel);
        }
      }
    } catch {
      // in use: leave it
    }
  }
  return { restored, removed };
}

/** Puts the copy back as it was at the save point. Returns what it changed. */
export function restoreSavePoint(root: string, sp: SavePoint): { restored: string[]; removed: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const now: string[] = [];
  const nowDirs: string[] = [];
  walk(
    root,
    (rel) => {
      now.push(rel);
      return true;
    },
    (rel) => nowDirs.push(rel),
  );
  for (const rel of now) {
    if (sp.files.has(rel)) continue;
    try {
      if (fs.statSync(path.join(root, rel)).size > MAX_FILE) continue;
      fs.rmSync(path.join(root, rel), { force: true });
      removed.push(rel);
    } catch {
      // in use: leave it
    }
  }
  for (const [rel, content] of sp.files) {
    const abs = path.join(root, rel);
    let same = false;
    try {
      same = fs.readFileSync(abs).equals(content);
    } catch {
      same = false;
    }
    if (same) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      restored.push(rel);
    } catch {
      // in use: leave it
    }
  }
  // Folders the step created and that are empty now.
  for (const rel of nowDirs.sort((a, b) => b.length - a.length)) {
    if (sp.dirs.has(rel)) continue;
    try {
      fs.rmdirSync(path.join(root, rel));
    } catch {
      // not empty: keep it
    }
  }
  return { restored, removed };
}

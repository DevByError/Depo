import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORES } from "../tools/fs-tools";
import { toRel } from "../tools/paths";

/**
 * Folders that are linked into the shadow workspace instead of copied: they are large,
 * the agent should not edit them, and tests need them (installed packages).
 */
export const LINKED_DIRS = new Set(["node_modules", ".venv", "venv", "env"]);
/** Files above this size are not copied (and not part of change sets). */
export const MAX_SNAPSHOT_FILE = 20 * 1024 * 1024;

export function hashBytes(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(buf).digest("hex");
}

export function hashFile(abs: string): string | null {
  try {
    return hashBytes(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/** Project files that belong in a workspace: everything except ignored, linked and huge files. */
export function walkProject(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (DEFAULT_IGNORES.has(it.name) || LINKED_DIRS.has(it.name)) continue;
        walk(full);
      } else if (it.isFile()) {
        try {
          if (fs.statSync(full).size <= MAX_SNAPSHOT_FILE) out.push(toRel(root, full));
        } catch {
          // vanished while walking
        }
      }
    }
  };
  walk(root);
  return out.sort();
}

export type Manifest = Record<string, string>;

/**
 * Copy the project into `dest` and return {relative path → content hash}. Linked folders at
 * the top level (node_modules, .venv …) become junctions (Windows) or symlinks to the originals.
 */
export function createShadow(
  projectRoot: string,
  dest: string,
): { manifest: Manifest; linked: string[]; bytes: number } {
  fs.mkdirSync(dest, { recursive: true });
  const manifest: Manifest = {};
  let bytes = 0;
  for (const rel of walkProject(projectRoot)) {
    const src = path.join(projectRoot, rel);
    const dst = path.join(dest, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(src);
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    try {
      const st = fs.statSync(src);
      fs.utimesSync(dst, st.atime, st.mtime);
    } catch {
      // timestamps are a nicety
    }
    manifest[rel] = hashBytes(buf);
    bytes += buf.length;
  }
  const linked: string[] = [];
  for (const name of LINKED_DIRS) {
    const src = path.join(projectRoot, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    try {
      fs.symlinkSync(src, path.join(dest, name), process.platform === "win32" ? "junction" : "dir");
      linked.push(name);
    } catch {
      // Without a link the agent can still work; installs would go into the shadow copy.
    }
  }
  return { manifest, linked, bytes };
}

/** Remove a shadow workspace without following its links into the real project. */
export function removeShadow(dest: string): void {
  // Unlink dependency links first so deleting never walks into the real project's folders.
  // `dest` may be the shadow tree itself or a workspace folder that holds it in `tree/`.
  for (const name of [...LINKED_DIRS].flatMap((n) => [n, path.join("tree", n)])) {
    const p = path.join(dest, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || (process.platform === "win32" && st.isDirectory() && isJunction(p)))
        fs.unlinkSync(p);
    } catch {
      // not there
    }
  }
  // Links in sub-projects (frontend/node_modules …), made when a preview runs a monorepo copy.
  unlinkNested(dest, 0);
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function isLink(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() || (process.platform === "win32" && st.isDirectory() && isJunction(p));
  } catch {
    return false;
  }
}

function unlinkNested(dir: string, level: number): void {
  if (level > 4) return;
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (LINKED_DIRS.has(it.name) && isLink(full)) {
      try {
        fs.unlinkSync(full);
      } catch {
        // rmSync below removes the link itself, never its target
      }
      continue;
    }
    if (
      it.isDirectory() &&
      !it.isSymbolicLink() &&
      !DEFAULT_IGNORES.has(it.name) &&
      !LINKED_DIRS.has(it.name)
    )
      unlinkNested(full, level + 1);
  }
}

/**
 * Link dependency folders of sub-projects (for example `frontend/node_modules` or
 * `backend/.venv`) from the real project into a shadow copy, so an app in a monorepo copy can
 * start without installing everything again. Top-level links are made by `createShadow`.
 * Returns the links made.
 */
export function linkNestedDependencies(projectRoot: string, shadowRoot: string): string[] {
  const made: string[] = [];
  const subs: string[] = [];
  let items: fs.Dirent[] = [];
  try {
    items = fs.readdirSync(shadowRoot, { withFileTypes: true });
  } catch {
    return made;
  }
  for (const it of items) {
    if (
      !it.isDirectory() ||
      it.name.startsWith(".") ||
      DEFAULT_IGNORES.has(it.name) ||
      LINKED_DIRS.has(it.name)
    )
      continue;
    subs.push(it.name);
    if (["apps", "packages", "services"].includes(it.name)) {
      try {
        for (const s of fs.readdirSync(path.join(shadowRoot, it.name), { withFileTypes: true }))
          if (s.isDirectory() && !s.name.startsWith(".")) subs.push(path.join(it.name, s.name));
      } catch {
        // unreadable
      }
    }
  }
  for (const rel of subs) {
    for (const name of LINKED_DIRS) {
      const src = path.join(projectRoot, rel, name);
      const dst = path.join(shadowRoot, rel, name);
      try {
        if (fs.existsSync(dst) || isLink(dst) || !fs.statSync(src).isDirectory()) continue;
        fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
        made.push(path.join(rel, name));
      } catch {
        // not there, or links are not allowed: the preview offers an install instead
      }
    }
  }
  return made;
}

function isJunction(p: string): boolean {
  try {
    return fs.readlinkSync(p).length > 0;
  } catch {
    return false;
  }
}

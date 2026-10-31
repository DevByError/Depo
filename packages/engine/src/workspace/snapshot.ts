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
  for (const name of LINKED_DIRS) {
    const p = path.join(dest, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || (process.platform === "win32" && st.isDirectory() && isJunction(p)))
        fs.unlinkSync(p);
    } catch {
      // not there
    }
  }
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function isJunction(p: string): boolean {
  try {
    return fs.readlinkSync(p).length > 0;
  } catch {
    return false;
  }
}

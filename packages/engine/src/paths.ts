import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DataDirs {
  root: string;
  db: string;
  backups: string;
  logs: string;
  workspaces: string;
  agents: string;
  skills: string;
  knowledge: string;
  models: string;
}

type Env = Record<string, string | undefined>;

/**
 * Resolve the app data root.
 * - `DEPO_DATA_DIR` overrides everything (tests, portable installs).
 * - Windows: `%LOCALAPPDATA%\Depo`.
 * - Other OSes (dev only for now): `$XDG_DATA_HOME/depo` or `~/.local/share/depo`.
 */
export function resolveDataRoot(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.DEPO_DATA_DIR?.trim();
  if (override) return (platform === "win32" ? path.win32 : path.posix).resolve(override);
  if (platform === "win32") {
    const local =
      env.LOCALAPPDATA?.trim() || path.win32.join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    return path.win32.join(local, "Depo");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(homedir(), ".local", "share"), "depo");
}

export function dataDirs(root: string): DataDirs {
  return {
    root,
    db: path.join(root, "db"),
    backups: path.join(root, "db", "backups"),
    logs: path.join(root, "logs"),
    workspaces: path.join(root, "workspaces"),
    agents: path.join(root, "agents"),
    skills: path.join(root, "skills"),
    knowledge: path.join(root, "knowledge"),
    models: path.join(root, "models"),
  };
}

export function ensureDataDirs(dirs: DataDirs): void {
  for (const dir of Object.values(dirs)) mkdirSync(toLongPath(dir), { recursive: true });
}

/**
 * Windows MAX_PATH is 260 characters. Prefix long absolute paths with `\\?\`
 * (or `\\?\UNC\` for network shares) so Win32 APIs accept them.
 * On other platforms, or for short paths, the path is returned unchanged.
 */
export function toLongPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  if (p.startsWith("\\\\?\\")) return p;
  const resolved = path.win32.resolve(p);
  if (resolved.length < 248) return p;
  if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

/** Display a path the way Windows users expect (backslashes) without changing its meaning. */
export function displayPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  return p
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\");
}

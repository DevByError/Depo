import fs from "node:fs";
import path from "node:path";

/**
 * Where the MySQL-compatible server for test databases comes from: Depo's own portable MariaDB
 * (downloaded into the data folder on Windows), then the PATH, then the usual install folders
 * (MariaDB, MySQL Server, XAMPP, Laragon on Windows; system folders elsewhere).
 */

export interface DbBinaries {
  /** MariaDB or Oracle MySQL (they set up a new data folder differently); a guess from the names until `--version` confirms it. */
  kind: "mariadb" | "mysql";
  /** mariadbd / mysqld. */
  server: string;
  /** mariadb / mysql (the command-line client). */
  client: string;
  /** mariadb-install-db / mysql_install_db, when there is one. */
  installDb: string | null;
  /** Where the server was found. */
  source: "depo" | "path" | "installed";
}

const SERVERS = ["mariadbd", "mysqld"];
const CLIENTS = ["mariadb", "mysql"];
const INSTALLERS = ["mariadb-install-db", "mysql_install_db"];

function listDirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(parent, e.name))
      .sort()
      .reverse(); // newest version first, by name
  } catch {
    return [];
  }
}

/** Folders that may hold the binaries, best first, each with where it came from. */
export function candidateDirs(o: {
  toolsDir: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}): { dir: string; source: DbBinaries["source"] }[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const out: { dir: string; source: DbBinaries["source"] }[] = [];
  for (const d of listDirs(path.join(o.toolsDir, "mariadb")))
    out.push({ dir: path.join(d, "bin"), source: "depo" });
  const sep = platform === "win32" ? ";" : ":";
  for (const d of (env.PATH ?? env.Path ?? "").split(sep))
    if (d.trim()) out.push({ dir: d.trim(), source: "path" });
  if (platform === "win32") {
    const pf = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean) as string[];
    for (const base of [...new Set(pf)]) {
      for (const d of listDirs(base))
        if (/^mariadb/i.test(path.basename(d))) out.push({ dir: path.join(d, "bin"), source: "installed" });
      for (const d of listDirs(path.join(base, "MySQL")))
        if (/^mysql server/i.test(path.basename(d)))
          out.push({ dir: path.join(d, "bin"), source: "installed" });
    }
    out.push({ dir: "C:\\xampp\\mysql\\bin", source: "installed" });
    for (const tool of ["mysql", "mariadb"])
      for (const d of listDirs(path.join("C:\\laragon\\bin", tool)))
        out.push({ dir: path.join(d, "bin"), source: "installed" });
  } else {
    for (const d of [
      "/usr/sbin",
      "/usr/bin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/mysql/bin",
    ])
      out.push({ dir: d, source: "installed" });
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = platform === "win32" ? c.dir.toLowerCase() : c.dir;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function exe(dir: string, name: string, platform: NodeJS.Platform): string | null {
  const file = path.join(dir, platform === "win32" ? `${name}.exe` : name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** The first folder with a server; the client and installer from the same folder when possible. */
export function findBinaries(o: {
  toolsDir: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}): DbBinaries | null {
  const platform = o.platform ?? process.platform;
  const dirs = candidateDirs(o);
  const first = (names: string[], prefer: string) => {
    for (const n of names) {
      const hit = exe(prefer, n, platform);
      if (hit) return hit;
    }
    for (const { dir } of dirs)
      for (const n of names) {
        const hit = exe(dir, n, platform);
        if (hit) return hit;
      }
    return null;
  };
  for (const { dir, source } of dirs) {
    for (const s of SERVERS) {
      const server = exe(dir, s, platform);
      if (!server) continue;
      // A client next to the server matches its version; otherwise any client on the list.
      const client = first(s === "mariadbd" ? CLIENTS : [...CLIENTS].reverse(), dir);
      if (!client) continue;
      const installDb = first(INSTALLERS, dir);
      const kind: DbBinaries["kind"] =
        s === "mariadbd" || (installDb && /mariadb-install-db/i.test(installDb)) || /mariadb/i.test(dir)
          ? "mariadb"
          : "mysql";
      return { kind, server, client, installDb, source };
    }
  }
  return null;
}

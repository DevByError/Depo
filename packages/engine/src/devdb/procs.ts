import fs from "node:fs";
import path from "node:path";

/**
 * Finding and stopping a test database's server process. A server that was not shut down
 * cleanly can stay alive after Depo let go of it: on Windows, MySQL 8 runs as a small monitor
 * process with the real server as its child, so stopping only the process Depo started leaves
 * the server running and holding the data folder's files. Every later start then fails with
 * "ibdata1 must be writable" or "Unable to lock". Depo finds such a server by the data folder on
 * its command line (never by name alone, so another MySQL on the PC is left alone) and stops it.
 */

export interface ServerProcs {
  /** MySQL / MariaDB server processes running now: pid and full command line. */
  list(): Promise<{ pid: number; command: string }[]>;
  /**
   * Stop a process and the processes it started; resolves once it is gone. Where it can shut down
   * cleanly first (not on Windows), it gets `graceMs` before it is killed.
   */
  kill(pid: number, graceMs?: number): Promise<void>;
}

const SERVER_NAME = /^(mysqld|mariadbd|mysqld-nt)(\.exe)?$/i;

async function run(argv: string[], timeoutMs: number): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [out] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      return out;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(200);
  }
  return !alive(pid);
}

/** The system's way of listing and stopping server processes. */
export function systemProcs(platform: NodeJS.Platform = process.platform): ServerProcs {
  if (platform === "win32")
    return {
      async list() {
        // Encoded, so no quoting can go wrong between Bun, cmd rules and PowerShell.
        const script =
          "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='mysqld.exe' OR Name='mariadbd.exe' OR Name='mysqld-nt.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
        const out = await run(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          20_000,
        );
        return parseList(out);
      },
      async kill(pid) {
        // /T: the monitor and the server it started; /F: it no longer answers anyway.
        await run(["taskkill", "/PID", String(pid), "/T", "/F"], 15_000);
        await gone(pid, 5000);
      },
    };
  return {
    async list() {
      if (platform === "linux" && fs.existsSync("/proc/self/cmdline")) {
        const out: { pid: number; command: string }[] = [];
        for (const name of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(name)) continue;
          try {
            const argv = fs
              .readFileSync(path.join("/proc", name, "cmdline"), "utf8")
              .split("\0")
              .filter(Boolean);
            if (argv[0] && SERVER_NAME.test(path.basename(argv[0])))
              out.push({ pid: Number(name), command: argv.join(" ") });
          } catch {
            // gone, or not ours to read
          }
        }
        return out;
      }
      return parseList(await run(["ps", "-axww", "-o", "pid=,command="], 10_000), true);
    },
    async kill(pid, graceMs = 20_000) {
      try {
        // TERM first: the server shuts down cleanly and InnoDB has nothing to recover.
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      if (await gone(pid, graceMs)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
      await gone(pid, 5000);
    },
  };
}

/** `pid<TAB or spaces>command` lines; with `byName`, only server programs are kept. */
export function parseList(out: string, byName = false): { pid: number; command: string }[] {
  const list: { pid: number; command: string }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (byName) {
      const exe = m[2].split(/\s+/)[0] ?? "";
      if (!SERVER_NAME.test(path.basename(exe))) continue;
    }
    list.push({ pid: Number(m[1]), command: m[2] });
  }
  return list;
}

/** Does this command line run a server on `dataDir`? (case and slashes ignored on Windows) */
export function runsOn(
  command: string,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const norm = (s: string) => (platform === "win32" ? s.replace(/\\/g, "/").toLowerCase() : s);
  const cmd = norm(command);
  const dir = norm(dataDir).replace(/\/+$/, "");
  for (let at = cmd.indexOf(dir); at >= 0; at = cmd.indexOf(dir, at + 1)) {
    const before = cmd[at - 1];
    const after = cmd[at + dir.length];
    if (
      (before === "=" || before === '"' || before === " " || before === "'") &&
      (after === undefined || after === '"' || after === " " || after === "'" || after === "/")
    )
      return true;
  }
  return false;
}

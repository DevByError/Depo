import fs from "node:fs";
import type { LogLine } from "@depo/shared";
import type { Logger } from "../logger";
import { displayPath } from "../paths";
import { type DiagnosticsSources, exportDiagnostics } from "./export";
import { ModelCallStats } from "./model-calls";
import {
  type LogFilter,
  type LogQuery,
  levelAllowed,
  logFiles,
  otherFiltersMatch,
  queryLogs,
  recentComponents,
  textNeedles,
  toLogLine,
} from "./query";

/** Components the engine logs under, so the filter lists them before they have written anything. */
export const KNOWN_COMPONENTS = [
  "agent",
  "api",
  "db",
  "design",
  "engine",
  "events",
  "index",
  "knowledge",
  "lab",
  "mcp",
  "models",
  "preview",
  "projects",
  "scheduler",
  "security",
  "skills",
  "tasks",
  "team",
  "tools",
  "workspace",
];

export interface LogServiceOptions {
  logger: Logger;
  stats?: ModelCallStats;
  /** Test hook: what "Open logs folder" runs. */
  openFolder?: (dir: string) => void;
}

/** Reads the engine's own logs for the UI: search, live tail, export and model timings. */
export class LogService {
  readonly stats: ModelCallStats;
  private readonly log: Logger;

  constructor(private readonly o: LogServiceOptions) {
    this.stats = o.stats ?? new ModelCallStats();
    this.log = o.logger;
  }

  get dir(): string {
    return this.log.dir;
  }

  async query(q: LogQuery) {
    // Lines still in the write buffer must be in the file before it is read; newer ones come
    // through the tail from the cursor returned here.
    this.log.flush();
    const cursor = this.log.cursor;
    let headBytes: number | undefined;
    try {
      headBytes = fs.statSync(this.log.file).size;
    } catch {
      headBytes = undefined;
    }
    const res = await queryLogs(this.log.dir, { ...q, headBytes });
    return { ...res, cursor };
  }

  tail(cursor: number, f: LogFilter & { limit: number }) {
    const t = this.log.tail(cursor, 5000);
    const needles = textNeedles(f.text);
    const lines: LogLine[] = [];
    for (const e of t.entries) {
      if (!otherFiltersMatch(e.record, f, needles) || !levelAllowed(e.record.level, f)) continue;
      lines.push(toLogLine(e.record, `live#${e.seq}`));
    }
    return { lines: lines.slice(-f.limit), cursor: t.cursor, reset: t.reset };
  }

  async components(): Promise<string[]> {
    const set = new Set([...KNOWN_COMPONENTS, ...this.log.components()]);
    for (const c of await recentComponents(this.log.dir)) set.add(c);
    return [...set].sort();
  }

  info() {
    return {
      dir: displayPath(this.log.dir),
      level: this.log.level,
      files: logFiles(this.log.dir).flatMap((f) => {
        try {
          const st = fs.statSync(f.file);
          return [{ name: f.name, bytes: st.size, modifiedAt: st.mtime.toISOString() }];
        } catch {
          return [];
        }
      }),
    };
  }

  export(sources: Omit<DiagnosticsSources, "logger" | "modelStats">, destDir?: string) {
    return exportDiagnostics(
      {
        ...sources,
        logger: this.log,
        modelStats: () => ({ models: this.stats.summary(), calls: this.stats.recent(300) }),
      },
      destDir,
    );
  }

  /** The owner's "Clear logs": old files deleted, the current one emptied. */
  clear(): { removed: number; bytes: number } {
    const r = this.log.clear();
    this.log.info("logs cleared by the owner", { files: r.removed, bytes: r.bytes });
    return r;
  }

  /** Show the logs folder in Explorer (Finder, or the file manager on Linux in dev). */
  openFolder(): { ok: boolean; path: string } {
    const dir = this.log.dir;
    try {
      if (this.o.openFolder) this.o.openFolder(dir);
      else {
        const cmd =
          process.platform === "win32"
            ? ["explorer.exe", dir]
            : process.platform === "darwin"
              ? ["open", dir]
              : ["xdg-open", dir];
        // A fixed program and our own folder: no shell, nothing from the user.
        const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        child.unref();
      }
      return { ok: true, path: displayPath(dir) };
    } catch (err) {
      this.log.warn("could not open the logs folder", { component: "engine", err });
      return { ok: false, path: displayPath(dir) };
    }
  }
}

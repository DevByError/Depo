import fs from "node:fs";
import path from "node:path";
import { newId } from "@depo/shared";
import { z } from "zod";
import type { AppDb } from "../db";
import type { EventBus } from "../events/bus";
import { type AgentTool, tool } from "../tools/index";
import { writeStream } from "../util/github";
import { listZip, readZipEntry } from "../util/unzip";

export const OSV_ECOSYSTEMS = [
  "npm",
  "PyPI",
  "crates.io",
  "Go",
  "Maven",
  "NuGet",
  "RubyGems",
  "Packagist",
  "Pub",
] as const;
const OSV_HOST = "https://osv-vulnerabilities.storage.googleapis.com";

export interface OsvStatus {
  ecosystem: string;
  count: number;
  importedAt: string;
  source: string;
}

export interface OsvMatch {
  id: string;
  aliases: string[];
  package: string;
  version: string;
  summary: string;
  severity: string | null;
  fixed: string | null;
}

interface Range {
  type: string;
  events: { introduced?: string; fixed?: string; last_affected?: string; limit?: string }[];
}

/** Compare two version strings loosely (numeric parts first, then pre-release tags). */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^[vV=]/, "")
      .split("+")[0] ?? "";
  const split = (v: string) => {
    const [main = "", pre = ""] = norm(v).split(/-(.*)/s);
    return { nums: main.split(/[.]/).map((p) => Number.parseInt(p.replace(/\D.*$/, ""), 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Is `version` inside the affected ranges / explicit versions of one OSV entry? */
export function isAffected(version: string, ranges: Range[], versions: string[]): boolean {
  if (versions.includes(version)) return true;
  for (const r of ranges) {
    if (r.type === "GIT") continue;
    let affected = false;
    for (const ev of r.events) {
      if (ev.introduced !== undefined)
        affected = ev.introduced === "0" || compareVersions(version, ev.introduced) >= 0 ? true : affected;
      if (ev.fixed !== undefined && compareVersions(version, ev.fixed) >= 0) affected = false;
      if (ev.last_affected !== undefined && compareVersions(version, ev.last_affected) > 0) affected = false;
    }
    if (affected) return true;
  }
  return false;
}

/** Read the packages a project depends on (name and a concrete version) from its manifests. */
export function readDependencies(
  root: string,
): { ecosystem: string; name: string; version: string; file: string }[] {
  const out: { ecosystem: string; name: string; version: string; file: string }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (
        e.name === "node_modules" ||
        e.name.startsWith(".") ||
        e.name === "__pycache__" ||
        e.name === "venv"
      )
        continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      try {
        if (e.name === "package.json") {
          const j = JSON.parse(fs.readFileSync(full, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          for (const [name, spec] of Object.entries({ ...j.devDependencies, ...j.dependencies })) {
            const v = /\d+(\.\d+){0,2}([-.\w]*)/.exec(spec)?.[0];
            if (v) out.push({ ecosystem: "npm", name, version: v, file: rel });
          }
        } else if (/^requirements.*\.txt$/.test(e.name)) {
          for (const line of fs.readFileSync(full, "utf8").split("\n")) {
            const m = /^\s*([A-Za-z0-9_.-]+)\s*(?:\[.*\])?\s*(?:==|~=|>=)\s*([\w.]+)/.exec(line);
            if (m?.[1] && m[2])
              out.push({
                ecosystem: "PyPI",
                name: m[1].toLowerCase().replace(/_/g, "-"),
                version: m[2],
                file: rel,
              });
          }
        } else if (e.name === "Cargo.toml") {
          for (const m of fs
            .readFileSync(full, "utf8")
            .matchAll(/^\s*([\w-]+)\s*=\s*(?:"([\d.]+)"|\{[^}]*version\s*=\s*"([\d.]+)")/gm)) {
            if (m[1] && (m[2] || m[3]))
              out.push({ ecosystem: "crates.io", name: m[1], version: (m[2] ?? m[3]) as string, file: rel });
          }
        }
      } catch {
        // an unreadable manifest is skipped
      }
    }
  };
  walk(root, 0);
  return out;
}

/** An offline copy of the OSV vulnerability database for the ecosystems the user imports. */
export class OsvService {
  private readonly sql;

  constructor(
    private readonly o: { db: AppDb; bus: EventBus; dir: string; fetchImpl?: typeof fetch; base?: string },
  ) {
    this.sql = o.db.$client;
    fs.mkdirSync(o.dir, { recursive: true });
  }

  status(): OsvStatus[] {
    return this.sql
      .query<{ ecosystem: string; count: number; imported_at: string; source: string }, []>(
        "SELECT ecosystem, count, imported_at, source FROM osv_meta ORDER BY ecosystem",
      )
      .all()
      .map((r) => ({ ecosystem: r.ecosystem, count: r.count, importedAt: r.imported_at, source: r.source }));
  }

  /**
   * Import one ecosystem from a local .zip (an OSV `all.zip`) or download it from OSV (the user asked).
   * `packages` limits the import to those names, which keeps the database small.
   */
  async import(input: { ecosystem: string; zipPath?: string; packages?: string[] }): Promise<OsvStatus> {
    const eco = OSV_ECOSYSTEMS.find((e) => e.toLowerCase() === input.ecosystem.toLowerCase());
    if (!eco) throw new Error(`Unknown ecosystem. Choose one of: ${OSV_ECOSYSTEMS.join(", ")}.`);
    let zip = input.zipPath?.trim() || "";
    let source = zip;
    let downloaded = false;
    if (!zip) {
      zip = path.join(this.o.dir, `${newId("job")}.zip`);
      source = `${this.o.base ?? OSV_HOST}/${eco}/all.zip`;
      const res = await (this.o.fetchImpl ?? fetch)(source, { headers: { "User-Agent": "Depo" } });
      if (!res.ok) throw new Error(`OSV answered ${res.status} for ${eco}.`);
      await writeStream(res, zip, 1.5 * 1024 * 1024 * 1024);
      downloaded = true;
    } else if (!fs.existsSync(zip)) throw new Error(`File not found: ${zip}`);
    try {
      const names = input.packages?.length ? new Set(input.packages.map((p) => p.toLowerCase())) : null;
      const ins = this.sql.query(
        "INSERT OR REPLACE INTO osv_vulns (id, ecosystem, package, summary, details, severity, ranges, versions, fixed, aliases, modified) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      let count = 0;
      this.sql.query("DELETE FROM osv_vulns WHERE ecosystem = ?").run(eco);
      const entries = listZip(zip).filter((e) => !e.isDir && e.name.endsWith(".json"));
      const tx = this.sql.transaction(() => {
        for (const e of entries) {
          let rec: OsvRecord;
          try {
            rec = JSON.parse(readZipEntry(zip, e, 8 * 1024 * 1024).toString("utf8")) as OsvRecord;
          } catch {
            continue;
          }
          for (const a of rec.affected ?? []) {
            if (a.package?.ecosystem?.split(":")[0] !== eco) continue;
            const pkg = (a.package.name ?? "").toLowerCase();
            if (!pkg || (names && !names.has(pkg))) continue;
            const ranges = (a.ranges ?? []) as Range[];
            const fixed =
              ranges
                .flatMap((r) => r.events.map((ev) => ev.fixed).filter((x): x is string => !!x))
                .sort(compareVersions)
                .at(-1) ?? null;
            ins.run(
              rec.id,
              eco,
              pkg,
              (rec.summary ?? "").slice(0, 400),
              (rec.details ?? "").slice(0, 2000),
              severityOf(rec),
              JSON.stringify(ranges),
              JSON.stringify(a.versions ?? []),
              fixed,
              JSON.stringify(rec.aliases ?? []),
              rec.modified ?? null,
            );
            count++;
          }
        }
      });
      tx();
      const now = new Date().toISOString();
      this.sql
        .query("INSERT OR REPLACE INTO osv_meta (ecosystem, imported_at, count, source) VALUES (?,?,?,?)")
        .run(eco, now, count, source);
      this.o.bus.emit({
        agent: "engine",
        type: "info",
        text: `OSV database for ${eco}: ${count} entries`,
        details: { ecosystem: eco, count },
        status: "succeeded",
      });
      return { ecosystem: eco, count, importedAt: now, source };
    } finally {
      if (downloaded) fs.rmSync(zip, { force: true });
    }
  }

  check(deps: { ecosystem: string; name: string; version: string; file?: string }[]): {
    matches: OsvMatch[];
    unchecked: string[];
  } {
    const have = new Set(this.status().map((s) => s.ecosystem));
    const matches: OsvMatch[] = [];
    const unchecked = new Set<string>();
    const q = this.sql.query<
      {
        id: string;
        summary: string;
        severity: string | null;
        ranges: string;
        versions: string;
        fixed: string | null;
        aliases: string;
      },
      [string, string]
    >(
      "SELECT id, summary, severity, ranges, versions, fixed, aliases FROM osv_vulns WHERE ecosystem = ? AND package = ?",
    );
    for (const d of deps) {
      if (!have.has(d.ecosystem)) {
        unchecked.add(d.ecosystem);
        continue;
      }
      for (const r of q.all(d.ecosystem, d.name.toLowerCase())) {
        if (isAffected(d.version, JSON.parse(r.ranges) as Range[], JSON.parse(r.versions) as string[])) {
          matches.push({
            id: r.id,
            aliases: JSON.parse(r.aliases) as string[],
            package: d.name,
            version: d.version,
            summary: r.summary,
            severity: r.severity,
            fixed: r.fixed,
          });
        }
      }
    }
    return { matches, unchecked: [...unchecked] };
  }

  extrasFor(): { tools: AgentTool<z.ZodType>[]; allow: string[]; prompt: string } {
    if (this.status().length === 0) return { tools: [], allow: [], prompt: "" };
    const self = this;
    const t = tool({
      name: "check_dependencies",
      description:
        "Check the project's dependencies (package.json, requirements.txt, Cargo.toml) against the offline OSV vulnerability database. Lists known vulnerabilities with the version that fixes them.",
      schema: z.object({}),
      async run(_a, ctx) {
        const deps = readDependencies(ctx.root);
        const r = self.check(deps);
        ctx.bus.emit({
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          agent: ctx.agent,
          type: "security_scan",
          text: `Dependency check: ${deps.length} packages, ${r.matches.length} known vulnerabilities`,
          details: { packages: deps.length, vulnerabilities: r.matches.length },
          status: r.matches.length ? "failed" : "succeeded",
        });
        const lines = [
          `Checked ${deps.length} dependencies against OSV (${self
            .status()
            .map((s) => s.ecosystem)
            .join(", ")}).`,
        ];
        for (const m of r.matches)
          lines.push(
            `- ${m.package}@${m.version}: ${m.id}${m.aliases.length ? ` (${m.aliases.slice(0, 2).join(", ")})` : ""} ${m.severity ? `[${m.severity}] ` : ""}${m.summary}${m.fixed ? ` → fixed in ${m.fixed}` : ""}`,
          );
        if (!r.matches.length) lines.push("No known vulnerabilities found.");
        if (r.unchecked.length) lines.push(`Not checked (no OSV data imported): ${r.unchecked.join(", ")}.`);
        return lines.join("\n");
      },
    });
    return { tools: [t], allow: [t.name], prompt: "" };
  }
}

interface OsvRecord {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: { package?: { ecosystem?: string; name?: string }; ranges?: unknown[]; versions?: string[] }[];
}

function severityOf(r: OsvRecord): string | null {
  const s = r.database_specific?.severity;
  if (s) return s.toUpperCase();
  const score = r.severity?.[0]?.score;
  return score ? (score.startsWith("CVSS") ? "CVSS" : score) : null;
}

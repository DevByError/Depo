import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { EventBus } from "../events/bus";
import type { OsvService } from "../knowledge/osv";
import { readDependencies } from "../knowledge/osv";
import { type AgentTool, type ToolContext, tool } from "../tools/index";
import { ToolError } from "../tools/paths";
import { dedupe, type Finding, type Severity, scanBuiltin } from "./builtin";
import {
  detectScanners,
  isLocalTarget,
  parseK6,
  parseLighthouse,
  runScanner,
  SCANNERS,
  type ScannerId,
  type ScannerStatus,
  whichSync,
} from "./scanners";

const WEIGHT: Record<Severity, number> = { critical: 30, high: 15, medium: 5, low: 1, info: 0 };
const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface SecurityScore {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  blocksRelease: boolean;
  counts: Record<Severity, number>;
  reasons: string[];
}

/** 100 minus a penalty per finding (capped per severity so one noisy rule cannot zero the score). */
export function scoreFindings(findings: Finding[]): SecurityScore {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const cap: Record<Severity, number> = { critical: 60, high: 45, medium: 25, low: 10, info: 0 };
  let penalty = 0;
  for (const s of ORDER) penalty += Math.min(cap[s], counts[s] * WEIGHT[s]);
  const overall = Math.max(0, 100 - penalty);
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F";
  const reasons: string[] = [];
  if (counts.critical) reasons.push(`${counts.critical} critical finding(s).`);
  if (counts.high) reasons.push(`${counts.high} high severity finding(s).`);
  if (overall < 60) reasons.push(`Score ${overall}/100 is below 60.`);
  return { overall, grade, blocksRelease: reasons.length > 0, counts, reasons };
}

export interface ScanReport {
  at: string;
  findings: Finding[];
  score: SecurityScore;
  ran: { tool: string; note: string }[];
  skipped: { tool: string; install: string }[];
}

export interface RuntimeStatus {
  id: string;
  name: string;
  installed: boolean;
  path: string | null;
  install: string;
}

const RUNTIMES: { id: string; name: string; exe: string; install: string }[] = [
  { id: "docker", name: "Docker", exe: "docker", install: "Install Docker Desktop from docker.com" },
  { id: "postgres", name: "PostgreSQL", exe: "psql", install: "winget install PostgreSQL.PostgreSQL" },
  { id: "mysql", name: "MySQL / MariaDB", exe: "mysql", install: "winget install Oracle.MySQL" },
  {
    id: "redis",
    name: "Redis",
    exe: "redis-server",
    install: "Run it in Docker: docker run -p 6379:6379 redis",
  },
  { id: "mongo", name: "MongoDB", exe: "mongod", install: "winget install MongoDB.Server" },
  { id: "python", name: "Python", exe: "python", install: "winget install Python.Python.3.12" },
  { id: "node", name: "Node.js", exe: "node", install: "winget install OpenJS.NodeJS.LTS" },
  { id: "git", name: "Git", exe: "git", install: "winget install Git.Git" },
];

export function markdownReport(r: ScanReport): string {
  const lines = [
    "# Security scan",
    "",
    `Score: **${r.score.overall}/100 (${r.score.grade})**${r.score.blocksRelease ? " - release blocked" : ""}`,
    `Findings: ${ORDER.map((s) => `${r.score.counts[s]} ${s}`).join(", ")}`,
    `Checked with: ${r.ran.map((x) => x.tool).join(", ") || "nothing"}`,
  ];
  if (r.skipped.length)
    lines.push(`Not installed (optional): ${r.skipped.map((s) => `${s.tool} (${s.install})`).join("; ")}`);
  lines.push("");
  const sorted = [...r.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  if (!sorted.length) lines.push("No findings.");
  for (const f of sorted)
    lines.push(`- **${f.severity}** ${f.file}:${f.line} [${f.tool}/${f.rule}] ${f.title}\n  Fix: ${f.fix}`);
  return `${lines.join("\n")}\n`;
}

export class SecurityService {
  private last = new Map<string, ScanReport>();
  constructor(
    private readonly deps: {
      bus: EventBus;
      osv: OsvService;
      /** Test seam: where to look for programs. */
      find?: (exe: string) => string | null;
      /** Test seam: run an external scanner. */
      run?: typeof runScanner;
    },
  ) {}

  scanners(): ScannerStatus[] {
    return detectScanners(this.deps.find ?? whichSync);
  }

  runtimes(): RuntimeStatus[] {
    const find = this.deps.find ?? whichSync;
    return RUNTIMES.map((r) => {
      const p = find(r.exe);
      return { id: r.id, name: r.name, installed: p !== null, path: p, install: r.install };
    });
  }

  lastReport(projectId: string): ScanReport | null {
    return this.last.get(projectId) ?? null;
  }

  async scan(
    root: string,
    opts: { projectId?: string | null; signal?: AbortSignal } = {},
  ): Promise<ScanReport> {
    const ran: ScanReport["ran"] = [];
    const skipped: ScanReport["skipped"] = [];
    let findings = scanBuiltin(root);
    ran.push({ tool: "depo built-in rules", note: `${findings.length} finding(s)` });

    // Dependencies against the offline OSV database, when imported.
    if (this.deps.osv.status().length) {
      const deps = readDependencies(root);
      const m = this.deps.osv.check(deps).matches;
      for (const x of m)
        findings.push({
          tool: "osv",
          rule: x.id,
          severity: /crit/i.test(x.severity ?? "")
            ? "critical"
            : /high/i.test(x.severity ?? "")
              ? "high"
              : "medium",
          file: deps.find((d) => d.name === x.package)?.file ?? "dependencies",
          line: 1,
          title: `${x.package}@${x.version}: ${x.summary}`.slice(0, 300),
          fix: x.fixed ? `Upgrade to ${x.fixed}.` : "Upgrade to a patched version or replace the package.",
        });
      ran.push({ tool: "osv (offline)", note: `${m.length} vulnerable package(s)` });
    } else {
      skipped.push({ tool: "osv (offline)", install: "Import an OSV database in the Knowledge tab" });
    }

    const run = this.deps.run ?? runScanner;
    const tmp = path.join(os.tmpdir(), `depo-scan-${process.pid}-${Date.now()}`);
    try {
      for (const s of this.scanners()) {
        if (!["semgrep", "gitleaks", "bandit", "osv-scanner", "trivy"].includes(s.id)) continue;
        if (!s.installed) {
          skipped.push({ tool: s.name, install: s.install });
          continue;
        }
        const r = await run(s.id, root, tmp, opts.signal);
        findings.push(...r.findings);
        ran.push({ tool: s.name, note: r.note });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    findings = dedupe(findings);
    const report: ScanReport = {
      at: new Date().toISOString(),
      findings,
      score: scoreFindings(findings),
      ran,
      skipped,
    };
    if (opts.projectId) this.last.set(opts.projectId, report);
    return report;
  }

  extrasFor(agentId: string): { tools: AgentTool<z.ZodType>[]; allow: string[]; prompt: string } {
    if (!["security", "testing", "enhancement", "coder", "integration"].includes(agentId))
      return { tools: [], allow: [], prompt: "" };
    const self = this;
    const emit = (
      ctx: ToolContext,
      text: string,
      failed: boolean,
      details: Record<string, string | number | boolean>,
    ) =>
      ctx.bus.emit({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        agent: ctx.agent,
        type: "security_scan",
        text,
        details,
        status: failed ? "failed" : "succeeded",
      });

    const tools: AgentTool<z.ZodType>[] = [
      tool({
        name: "security_status",
        description:
          "Say which security and testing tools are installed (Semgrep, Gitleaks, OSV-Scanner, Trivy, Bandit, ZAP, k6, Lighthouse) and which local runtimes exist (Docker, PostgreSQL, Redis...), with how to install the missing ones. Nothing is installed automatically.",
        schema: z.object({}),
        async run() {
          const lines = ["Scanners:"];
          for (const s of self.scanners())
            lines.push(
              `- ${s.name}: ${s.installed ? "installed" : `not installed (${s.install})`} - ${s.purpose}`,
            );
          lines.push("Runtimes:");
          for (const r of self.runtimes())
            lines.push(`- ${r.name}: ${r.installed ? "installed" : `not installed (${r.install})`}`);
          lines.push("Built in, always available: secret and insecure-code rules, SQLite.");
          return lines.join("\n");
        },
      }),
      tool({
        name: "security_scan",
        description:
          "Scan the project for secrets, insecure code patterns and vulnerable dependencies using the built-in rules plus every installed scanner. Returns findings with file, line and how to fix, a score out of 100, and writes reviews/security-scan.md and scores/security.json. Run it, fix the findings, and run it again until nothing high or critical remains.",
        schema: z.object({}),
        async run(_a, ctx) {
          const r = await self.scan(ctx.root, {
            projectId: ctx.projectId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (ctx.team) {
            ctx.team.write("reviews/security-scan.md", markdownReport(r), "replace");
            ctx.team.write(
              "scores/security.json",
              JSON.stringify({ ...r.score, at: r.at, tools: r.ran.map((x) => x.tool) }),
              "replace",
            );
            if (r.score.blocksRelease)
              ctx.team.send({
                to: "manager",
                type: "blocker",
                summary:
                  `Security scan blocks the release (${r.score.overall}/100): ${r.score.reasons.join(" ")}`.slice(
                    0,
                    1800,
                  ),
                confidence: 0.9,
              });
          }
          emit(
            ctx,
            `Security scan: ${r.score.overall}/100, ${r.findings.length} finding(s)`,
            r.score.blocksRelease,
            {
              score: r.score.overall,
              findings: r.findings.length,
            },
          );
          const top = [...r.findings]
            .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
            .slice(0, 40);
          const lines = [
            `Security score ${r.score.overall}/100 (${r.score.grade}). ${r.score.blocksRelease ? `RELEASE BLOCKED: ${r.score.reasons.join(" ")}` : "Release is not blocked."}`,
            `Checked with: ${r.ran.map((x) => `${x.tool} (${x.note})`).join("; ")}.`,
          ];
          if (r.skipped.length)
            lines.push(
              `Not available: ${r.skipped.map((x) => x.tool).join(", ")} (use security_status for how to install).`,
            );
          for (const f of top)
            lines.push(`- ${f.severity} ${f.file}:${f.line} [${f.rule}] ${f.title} Fix: ${f.fix}`);
          if (r.findings.length > top.length) lines.push(`...and ${r.findings.length - top.length} more.`);
          if (!r.findings.length) lines.push("No findings.");
          return lines.join("\n");
        },
      }),
      tool({
        name: "performance_check",
        description:
          "Measure a running local web app: 'lighthouse' scores performance, accessibility, best practices and SEO; 'k6' load tests it. Only localhost addresses are allowed. If the tool is not installed this says how to install it.",
        schema: z.object({
          tool: z.enum(["lighthouse", "k6"]),
          url: z.string().min(1).max(300).describe("e.g. http://localhost:3000"),
          seconds: z.number().int().min(3).max(60).default(10).describe("k6 duration"),
          users: z.number().int().min(1).max(50).default(5).describe("k6 virtual users"),
        }),
        async run(a, ctx) {
          if (!isLocalTarget(a.url)) throw new ToolError("Only http(s)://localhost addresses can be tested.");
          const info = SCANNERS.find((s) => s.id === a.tool);
          const found = (self.deps.find ?? whichSync)(info?.exe ?? a.tool);
          if (!found)
            return `${info?.name ?? a.tool} is not installed. To add it: ${info?.install}. Nothing was installed.`;
          const { runShell } = await import("../tools/shell/run");
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "depo-perf-"));
          try {
            if (a.tool === "lighthouse") {
              const out = path.join(tmp, "lh.json");
              await runShell({
                command: `lighthouse "${a.url}" --output json --output-path "${out}" --quiet --chrome-flags="--headless --no-sandbox"`,
                cwd: ctx.root,
                timeoutMs: 180_000,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
                maxOutputBytes: 8000,
              });
              const s = parseLighthouse(JSON.parse(fs.readFileSync(out, "utf8")));
              if (!s) return "Lighthouse ran but produced no scores.";
              ctx.team?.write(
                "scores/perf.json",
                JSON.stringify({ tool: "lighthouse", ...s, at: new Date().toISOString() }),
                "replace",
              );
              return `Lighthouse: performance ${s.performance}, accessibility ${s.accessibility}, best practices ${s.bestPractices}, SEO ${s.seo} (out of 100).`;
            }
            const script = path.join(tmp, "load.js");
            const out = path.join(tmp, "k6.json");
            fs.writeFileSync(
              script,
              `import http from 'k6/http';\nexport const options = { vus: ${a.users}, duration: '${a.seconds}s' };\nexport default function () { http.get(${JSON.stringify(a.url)}); }\n`,
            );
            await runShell({
              command: `k6 run --quiet --summary-export "${out}" "${script}"`,
              cwd: ctx.root,
              timeoutMs: (a.seconds + 60) * 1000,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              maxOutputBytes: 8000,
            });
            const s = parseK6(JSON.parse(fs.readFileSync(out, "utf8")));
            if (!s) return "k6 ran but produced no summary.";
            ctx.team?.write(
              "scores/perf.json",
              JSON.stringify({ tool: "k6", ...s, at: new Date().toISOString() }),
              "replace",
            );
            return `k6: ${s.requests} requests, ${(s.failedRate * 100).toFixed(1)}% failed, average ${s.avgMs} ms, 95th percentile ${s.p95Ms} ms.`;
          } catch (err) {
            if (err instanceof ToolError) throw err;
            throw new ToolError(
              `${a.tool} did not produce a result: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
      }),
    ];
    return {
      tools,
      allow: tools.map((t) => t.name),
      prompt:
        "Security and performance tools are available: security_status, security_scan and performance_check. Fix every high or critical finding and run security_scan again to prove it is gone.",
    };
  }
}

export type { ScannerId };

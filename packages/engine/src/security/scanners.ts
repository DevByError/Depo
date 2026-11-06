import fs from "node:fs";
import path from "node:path";
import { runShell } from "../tools/shell/run";
import type { Finding, Severity } from "./builtin";

/**
 * External scanners Depo can use when they are installed. Depo never downloads them on its own:
 * `detect` says what is there and `install` tells the user how to add the rest.
 */

export type ScannerId =
  | "semgrep"
  | "gitleaks"
  | "osv-scanner"
  | "trivy"
  | "bandit"
  | "zap"
  | "k6"
  | "lighthouse";

export interface ScannerInfo {
  id: ScannerId;
  name: string;
  kind: "code" | "secrets" | "dependencies" | "container" | "web" | "load" | "performance";
  purpose: string;
  /** Executable to look for on PATH. */
  exe: string;
  install: string;
}

export const SCANNERS: ScannerInfo[] = [
  {
    id: "semgrep",
    name: "Semgrep",
    kind: "code",
    purpose: "Finds insecure code patterns in many languages",
    exe: "semgrep",
    install: "pip install semgrep",
  },
  {
    id: "gitleaks",
    name: "Gitleaks",
    kind: "secrets",
    purpose: "Finds secrets in files and in git history",
    exe: "gitleaks",
    install: "winget install Gitleaks.Gitleaks",
  },
  {
    id: "osv-scanner",
    name: "OSV-Scanner",
    kind: "dependencies",
    purpose: "Checks dependencies against the OSV vulnerability database",
    exe: "osv-scanner",
    install:
      "winget install Google.OSVScanner (or go install github.com/google/osv-scanner/cmd/osv-scanner@latest)",
  },
  {
    id: "trivy",
    name: "Trivy",
    kind: "container",
    purpose: "Scans dependencies, Dockerfiles and container images",
    exe: "trivy",
    install: "winget install AquaSecurity.Trivy",
  },
  {
    id: "bandit",
    name: "Bandit",
    kind: "code",
    purpose: "Finds security problems in Python code",
    exe: "bandit",
    install: "pip install bandit",
  },
  {
    id: "zap",
    name: "OWASP ZAP",
    kind: "web",
    purpose: "Attacks a running web app to find vulnerabilities (baseline scan)",
    exe: "zap-baseline.py",
    install:
      "Install OWASP ZAP from zaproxy.org (or run it with Docker), then make zap-baseline.py available on PATH",
  },
  {
    id: "k6",
    name: "k6",
    kind: "load",
    purpose: "Load tests an HTTP service",
    exe: "k6",
    install: "winget install k6.k6",
  },
  {
    id: "lighthouse",
    name: "Lighthouse",
    kind: "performance",
    purpose: "Scores performance, accessibility, SEO and best practices of a page",
    exe: "lighthouse",
    install: "npm install -g lighthouse",
  },
];

export interface ScannerStatus extends ScannerInfo {
  installed: boolean;
  path: string | null;
}

/** Find an executable on PATH (and PATHEXT on Windows) without running anything. */
export function whichSync(exe: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, exe + e);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function detectScanners(find: (exe: string) => string | null = whichSync): ScannerStatus[] {
  return SCANNERS.map((s) => {
    const p = find(s.exe);
    return { ...s, installed: p !== null, path: p };
  });
}

const sev = (s: string | number | undefined | null): Severity => {
  const v = String(s ?? "").toLowerCase();
  if (v.includes("crit")) return "critical";
  if (v === "high" || v === "error") return "high";
  if (v === "medium" || v === "moderate" || v === "warning") return "medium";
  if (v === "low") return "low";
  if (v === "info" || v === "note") return "info";
  return "medium";
};

const rel = (root: string, f: string) => {
  const norm = f.replace(/\\/g, "/");
  const r = path.isAbsolute(f) ? path.relative(root, f).replace(/\\/g, "/") : norm.replace(/^\.\//, "");
  return r.startsWith("..") ? norm : r;
};

type J = Record<string, unknown>;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/** Parsers turn each scanner's JSON into the common Finding shape. Unknown shapes give no findings. */
export const PARSERS: Partial<Record<ScannerId, (json: unknown, root: string) => Finding[]>> = {
  semgrep(json, root) {
    return arr((json as J)?.results).map((r) => {
      const extra = (r.extra ?? {}) as J;
      return {
        tool: "semgrep",
        rule: str(r.check_id),
        severity: sev(str(extra.severity)),
        file: rel(root, str(r.path)),
        line: num(((r.start ?? {}) as J).line),
        title: str(extra.message).slice(0, 300),
        fix: str(extra.fix) || "See the Semgrep rule for the recommended change.",
      };
    });
  },
  gitleaks(json, root) {
    return arr(json).map((r) => ({
      tool: "gitleaks",
      rule: str(r.RuleID),
      severity: "high" as Severity,
      file: rel(root, str(r.File)),
      line: num(r.StartLine),
      title: str(r.Description) || "Secret found",
      fix: "Remove the secret, rotate it, and load it from an environment variable.",
    }));
  },
  bandit(json, root) {
    return arr((json as J)?.results).map((r) => ({
      tool: "bandit",
      rule: str(r.test_id),
      severity: sev(str(r.issue_severity)),
      file: rel(root, str(r.filename)),
      line: num(r.line_number),
      title: str(r.issue_text).slice(0, 300),
      fix: str(r.more_info) ? `See ${str(r.more_info)}` : "Replace the flagged call with a safe alternative.",
    }));
  },
  "osv-scanner"(json) {
    const out: Finding[] = [];
    for (const res of arr((json as J)?.results)) {
      const source = str(((res.source ?? {}) as J).path);
      for (const pkg of arr(res.packages)) {
        const p = (pkg.package ?? {}) as J;
        for (const v of arr(pkg.vulnerabilities)) {
          out.push({
            tool: "osv-scanner",
            rule: str(v.id),
            severity: sev(str(((v.database_specific ?? {}) as J).severity) || "high"),
            file: source || "dependencies",
            line: 1,
            title: `${str(p.name)}@${str(p.version)}: ${str(v.summary) || str(v.id)}`.slice(0, 300),
            fix: "Upgrade the package to a fixed version listed in the advisory.",
          });
        }
      }
    }
    return out;
  },
  trivy(json) {
    const out: Finding[] = [];
    for (const res of arr((json as J)?.Results)) {
      const target = str(res.Target);
      for (const v of arr(res.Vulnerabilities)) {
        out.push({
          tool: "trivy",
          rule: str(v.VulnerabilityID),
          severity: sev(str(v.Severity)),
          file: target,
          line: 1,
          title:
            `${str(v.PkgName)}@${str(v.InstalledVersion)}: ${str(v.Title) || str(v.VulnerabilityID)}`.slice(
              0,
              300,
            ),
          fix: str(v.FixedVersion)
            ? `Upgrade to ${str(v.FixedVersion)}`
            : "No fixed version yet; consider an alternative.",
        });
      }
      for (const m of arr(res.Misconfigurations)) {
        out.push({
          tool: "trivy",
          rule: str(m.ID),
          severity: sev(str(m.Severity)),
          file: target,
          line: num(((m.CauseMetadata ?? {}) as J).StartLine) || 1,
          title: str(m.Title).slice(0, 300),
          fix: str(m.Resolution) || "See the Trivy advisory.",
        });
      }
    }
    return out;
  },
};

export interface ScanRun {
  tool: ScannerId;
  ran: boolean;
  findings: Finding[];
  note: string;
}

const COMMANDS: Partial<Record<ScannerId, (root: string, out: string) => string>> = {
  semgrep: (_r, out) => `semgrep scan --config auto --json --quiet --metrics off --output "${out}" .`,
  gitleaks: (_r, out) => `gitleaks detect --no-git --source . --report-format json --report-path "${out}"`,
  bandit: (_r, out) => `bandit -r . -f json -o "${out}" -q`,
  "osv-scanner": (_r, out) => `osv-scanner --format json --output "${out}" -r .`,
  trivy: (_r, out) => `trivy fs --format json --output "${out}" --quiet .`,
};

/** Run one installed scanner on the folder and parse its report. A non-zero exit often just means "found issues". */
export async function runScanner(
  id: ScannerId,
  root: string,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<ScanRun> {
  const cmd = COMMANDS[id];
  const parse = PARSERS[id];
  if (!cmd || !parse) return { tool: id, ran: false, findings: [], note: "No automatic scan for this tool." };
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `${id}.json`);
  const r = await runShell({
    command: cmd(root, out),
    cwd: root,
    timeoutMs: 300_000,
    ...(signal ? { signal } : {}),
    maxOutputBytes: 20_000,
  });
  if (r.timedOut) return { tool: id, ran: true, findings: [], note: "Timed out after 5 minutes." };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch {
    return {
      tool: id,
      ran: true,
      findings: [],
      note: `No report was produced (exit ${r.exitCode}). ${r.output.trim().slice(-300)}`,
    };
  } finally {
    fs.rmSync(out, { force: true });
  }
  const findings = parse(json, root);
  return { tool: id, ran: true, findings, note: `${findings.length} finding(s).` };
}

/* ---- Performance and load tools: summaries only ---- */

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export function parseLighthouse(json: unknown): LighthouseScores | null {
  const c = ((json as J)?.categories ?? null) as J | null;
  if (!c) return null;
  const score = (k: string) => Math.round(num(((c[k] ?? {}) as J).score) * 100);
  return {
    performance: score("performance"),
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
    seo: score("seo"),
  };
}

export interface K6Summary {
  requests: number;
  failedRate: number;
  p95Ms: number;
  avgMs: number;
}

export function parseK6(json: unknown): K6Summary | null {
  const m = ((json as J)?.metrics ?? null) as J | null;
  if (!m) return null;
  const dur = (m.http_req_duration ?? {}) as J;
  const vals = (dur.values ?? dur) as J;
  const reqs = (m.http_reqs ?? {}) as J;
  const failed = (m.http_req_failed ?? {}) as J;
  return {
    requests: num(((reqs.values ?? reqs) as J).count),
    failedRate: num(((failed.values ?? failed) as J).rate ?? ((failed.values ?? failed) as J).value),
    p95Ms: Math.round(num(vals["p(95)"])),
    avgMs: Math.round(num(vals.avg)),
  };
}

/** Only local addresses may be attacked or load tested. */
export function isLocalTarget(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createEngine, type Engine } from "../src/engine";
import { scanBuiltin } from "../src/security/builtin";
import {
  detectScanners,
  isLocalTarget,
  PARSERS,
  parseK6,
  parseLighthouse,
  type ScannerId,
} from "../src/security/scanners";
import { markdownReport, scoreFindings } from "../src/security/service";
import { executeTool, type TeamHooks, type ToolContext } from "../src/tools/index";
import { TEST_TOKEN, tempDir } from "./helpers";

let cleanup: (() => void)[] = [];
let engine: Engine | null = null;
afterEach(async () => {
  await engine?.stop("test");
  engine = null;
  for (const c of cleanup) c();
  cleanup = [];
});

// A small project with the mistakes the scanner must find. Secret-looking values are built at run time.
const AWS = `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`;
const VULN_PY = [
  "import hashlib, subprocess, sqlite3",
  "from flask import Flask, request",
  "app = Flask(__name__)",
  `API_KEY = "${"sk_live_"}${"abcdefghijklmnop1234"}"`,
  "@app.route('/user')",
  "def user():",
  "    uid = request.args['id']",
  "    db = sqlite3.connect('x.db')",
  '    row = db.execute(f"SELECT * FROM users WHERE id = {uid}").fetchone()',
  "    subprocess.run('ls ' + uid, shell=True)",
  "    return str(eval(request.args['expr']))",
  "def h(p): return hashlib.md5(p.encode()).hexdigest()",
  "if __name__ == '__main__':",
  "    app.run(host='0.0.0.0', debug=True)",
  "",
].join("\n");
const FIXED_PY = [
  "import hashlib, os, subprocess, sqlite3, ast",
  "from flask import Flask, request",
  "app = Flask(__name__)",
  "API_KEY = os.environ['API_KEY']",
  "@app.route('/user')",
  "def user():",
  "    uid = request.args['id']",
  "    db = sqlite3.connect('x.db')",
  "    row = db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()",
  "    subprocess.run(['ls', uid])",
  "    return str(ast.literal_eval(request.args['expr']))",
  "def h(p): return hashlib.sha256(p.encode()).hexdigest()",
  "if __name__ == '__main__':",
  "    app.run(host='127.0.0.1')",
  "",
].join("\n");

function seed(root: string) {
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "app.py"), VULN_PY);
  fs.writeFileSync(path.join(root, "web/page.js"), "el.innerHTML = location.hash;\n");
  fs.writeFileSync(path.join(root, ".env"), `AWS_KEY=${AWS}\n`);
}

describe("built-in security rules", () => {
  test("a seeded vulnerable project is detected with file, line and a fix", () => {
    const t = tempDir("depo sec seed");
    cleanup.push(t.cleanup);
    seed(t.dir);
    const f = scanBuiltin(t.dir);
    const rules = new Set(f.map((x) => x.rule));
    for (const r of [
      "secret.token",
      "py.sql-injection",
      "py.shell-true",
      "py.eval",
      "py.weak-hash",
      "py.debug",
      "py.bind-all",
      "web.xss",
      "secret.aws-key",
      "secret.env-file",
    ])
      expect(rules.has(r)).toBe(true);
    const sql = f.find((x) => x.rule === "py.sql-injection");
    expect(sql?.file).toBe("app.py");
    expect(sql?.line).toBe(9);
    expect(sql?.fix).toContain("parameters");
    const score = scoreFindings(f);
    expect(score.blocksRelease).toBe(true);
    expect(score.overall).toBeLessThan(60);
  });

  test("the fixed version of the same code is clean", () => {
    const t = tempDir("depo sec fixed");
    cleanup.push(t.cleanup);
    fs.writeFileSync(path.join(t.dir, "app.py"), FIXED_PY);
    const f = scanBuiltin(t.dir);
    expect(f).toEqual([]);
    expect(scoreFindings(f).overall).toBe(100);
  });

  test("placeholders, comments, ignored lines, node_modules and tests do not raise alarms", () => {
    const t = tempDir("depo sec quiet");
    cleanup.push(t.cleanup);
    fs.mkdirSync(path.join(t.dir, "node_modules/x"), { recursive: true });
    fs.mkdirSync(path.join(t.dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "node_modules/x/a.js"), "el.innerHTML = x; eval(y)\n");
    fs.writeFileSync(
      path.join(t.dir, "a.py"),
      [
        "# password = 'hunter2hunter2'",
        "password = os.environ['P']",
        'SECRET_KEY = "changeme"',
        'api_key = "your-api-key-here"',
        "x = eval(code)  # depo-ignore reviewed",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(t.dir, "tests/t.py"), "x = eval(a)\n");
    fs.writeFileSync(path.join(t.dir, ".env.example"), "KEY=abc\n");
    const f = scanBuiltin(t.dir);
    // The only finding is the sample-folder eval, lowered from high to medium.
    expect(f.map((x) => `${x.file}:${x.severity}`)).toEqual(["tests/t.py:medium"]);
  });

  test("scoring caps noisy rules and treats high findings as blocking", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      tool: "depo",
      rule: "r",
      severity: "low" as const,
      file: "f",
      line: i,
      title: "t",
      fix: "f",
    }));
    const s = scoreFindings(many);
    expect(s.overall).toBe(90);
    expect(s.blocksRelease).toBe(false);
    const one = scoreFindings([{ ...many[0], severity: "high" as const } as (typeof many)[number]]);
    expect(one.blocksRelease).toBe(true);
    expect(one.overall).toBe(85);
  });
});

describe("external scanners", () => {
  test("detection looks only at PATH and gives install help for missing tools", () => {
    const s = detectScanners((exe) => (exe === "semgrep" ? "C:/tools/semgrep.exe" : null));
    expect(s.length).toBe(8);
    expect(s.find((x) => x.id === "semgrep")?.installed).toBe(true);
    const k6 = s.find((x) => x.id === "k6");
    expect(k6?.installed).toBe(false);
    expect(k6?.install).toContain("winget");
  });

  test("parsers turn each tool's JSON into findings and tolerate junk", () => {
    const root = "C:/proj";
    const p = (id: ScannerId, j: unknown) => PARSERS[id]?.(j, root) ?? [];
    expect(
      p("semgrep", {
        results: [
          {
            check_id: "python.sql",
            path: "C:/proj/app.py",
            start: { line: 4 },
            extra: { severity: "ERROR", message: "SQL injection" },
          },
        ],
      }),
    ).toEqual([
      {
        tool: "semgrep",
        rule: "python.sql",
        severity: "high",
        file: "app.py",
        line: 4,
        title: "SQL injection",
        fix: "See the Semgrep rule for the recommended change.",
      },
    ]);
    expect(p("gitleaks", [{ RuleID: "aws", File: "a.env", StartLine: 2, Description: "AWS" }])[0]?.line).toBe(
      2,
    );
    expect(
      p("bandit", {
        results: [
          { test_id: "B602", issue_severity: "HIGH", filename: "x.py", line_number: 3, issue_text: "shell" },
        ],
      })[0]?.severity,
    ).toBe("high");
    expect(
      p("osv-scanner", {
        results: [
          {
            source: { path: "package.json" },
            packages: [
              {
                package: { name: "lodash", version: "4.0.0" },
                vulnerabilities: [{ id: "GHSA-1", summary: "bad" }],
              },
            ],
          },
        ],
      })[0]?.title,
    ).toContain("lodash@4.0.0");
    const trivy = p("trivy", {
      Results: [
        {
          Target: "package-lock.json",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-1",
              PkgName: "x",
              InstalledVersion: "1",
              FixedVersion: "2",
              Severity: "CRITICAL",
              Title: "t",
            },
          ],
          Misconfigurations: [{ ID: "DS002", Severity: "HIGH", Title: "root user", Resolution: "Add USER" }],
        },
      ],
    });
    expect(trivy.map((x) => x.severity)).toEqual(["critical", "high"]);
    for (const id of ["semgrep", "gitleaks", "bandit", "osv-scanner", "trivy"] as const) {
      expect(p(id, null)).toEqual([]);
      expect(p(id, { weird: true })).toEqual([]);
    }
  });

  test("Lighthouse and k6 summaries, and only local addresses are allowed", () => {
    expect(
      parseLighthouse({
        categories: {
          performance: { score: 0.91 },
          accessibility: { score: 1 },
          "best-practices": { score: 0.8 },
          seo: { score: 0.5 },
        },
      }),
    ).toEqual({ performance: 91, accessibility: 100, bestPractices: 80, seo: 50 });
    expect(parseLighthouse({})).toBeNull();
    expect(
      parseK6({
        metrics: {
          http_reqs: { count: 120 },
          http_req_failed: { value: 0.02 },
          http_req_duration: { avg: 12.4, "p(95)": 40.2 },
        },
      }),
    ).toEqual({ requests: 120, failedRate: 0.02, p95Ms: 40, avgMs: 12 });
    expect(isLocalTarget("http://localhost:3000")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1/x")).toBe(true);
    expect(isLocalTarget("https://example.com")).toBe(false);
    expect(isLocalTarget("http://localhost.evil.com")).toBe(false);
    expect(isLocalTarget("file:///etc/passwd")).toBe(false);
  });
});

function fakeTeam(): { team: TeamHooks; written: Map<string, string>; sent: string[] } {
  const written = new Map<string, string>();
  const sent: string[] = [];
  return {
    written,
    sent,
    team: {
      read: (s) => (written.has(s) ? { content: written.get(s) ?? "", version: 1, owner: "x" } : null),
      list: () => [],
      write: (s, c) => {
        written.set(s, c);
        return `Saved ${s}.`;
      },
      send: (m) => {
        sent.push(`${m.type}:${m.to}`);
        return "sent";
      },
    },
  };
}

describe("security tools (Phase 6 acceptance)", () => {
  test("the Security agent finds the seeded problems, they get fixed, and a rescan proves it", async () => {
    const t = tempDir("depo sec accept");
    cleanup.push(t.cleanup);
    engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    await engine.start();
    const root = path.join(t.dir, "ws");
    fs.mkdirSync(root, { recursive: true });
    seed(root);
    const f = fakeTeam();
    const extra = engine.security.extrasFor("security");
    expect(extra.allow).toEqual(["security_status", "security_scan", "performance_check"]);
    expect(engine.security.extrasFor("frontend").tools).toEqual([]);
    const ctx: ToolContext = {
      root,
      bus: engine.bus,
      approvals: engine.approvals,
      projectId: null,
      taskId: null,
      agent: "security@1.0.0",
      team: f.team,
      extraTools: extra.tools,
    };

    const before = await executeTool("security_scan", {}, ctx);
    expect(before.isError).toBe(false);
    expect(before.content).toContain("RELEASE BLOCKED");
    expect(before.content).toContain("app.py:9");
    expect(JSON.parse(f.written.get("scores/security.json") ?? "{}").blocksRelease).toBe(true);
    expect(f.written.get("reviews/security-scan.md")).toContain("Fix:");
    expect(f.sent).toContain("blocker:manager");

    // The fix (a coder agent would do this through the normal edit tools).
    fs.writeFileSync(path.join(root, "app.py"), FIXED_PY);
    fs.writeFileSync(path.join(root, "web/page.js"), "el.textContent = location.hash;\n");
    fs.rmSync(path.join(root, ".env"));

    const after = await executeTool("security_scan", {}, ctx);
    expect(after.content).toContain("Release is not blocked");
    expect(after.content).toContain("No findings");
    const score = JSON.parse(f.written.get("scores/security.json") ?? "{}");
    expect(score.overall).toBe(100);
    expect(score.blocksRelease).toBe(false);
  });

  test("security_status explains what is missing; performance_check refuses remote hosts and missing tools", async () => {
    const t = tempDir("depo sec status");
    cleanup.push(t.cleanup);
    engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    await engine.start();
    const ctx: ToolContext = {
      root: t.dir,
      bus: engine.bus,
      approvals: engine.approvals,
      projectId: null,
      taskId: null,
      agent: "security@1.0.0",
      extraTools: engine.security.extrasFor("security").tools,
    };
    const status = await executeTool("security_status", {}, ctx);
    expect(status.content).toContain("Semgrep");
    expect(status.content).toContain("PostgreSQL");
    expect(status.content).toContain("Built in, always available");
    const remote = await executeTool("performance_check", { tool: "k6", url: "https://example.com" }, ctx);
    expect(remote.isError).toBe(true);
    expect(remote.content).toContain("localhost");
  });

  test("scan merges an installed scanner (injected) and lists the ones that are missing", async () => {
    const t = tempDir("depo sec merge");
    cleanup.push(t.cleanup);
    engine = createEngine({ dataRoot: path.join(t.dir, "data"), token: TEST_TOKEN, heartbeatMs: 60_000 });
    await engine.start();
    const { SecurityService } = await import("../src/security/service");
    const svc = new SecurityService({
      bus: engine.bus,
      osv: engine.osv,
      find: (exe) => (exe === "semgrep" ? "semgrep.exe" : null),
      run: async (id) => ({
        tool: id,
        ran: true,
        findings: [
          { tool: "semgrep", rule: "x", severity: "medium", file: "a.py", line: 1, title: "t", fix: "f" },
        ],
        note: "1 finding(s).",
      }),
    });
    fs.writeFileSync(path.join(t.dir, "a.py"), "print(1)\n");
    const r = await svc.scan(t.dir, { projectId: "p1" });
    expect(r.findings.length).toBe(1);
    expect(r.ran.map((x) => x.tool)).toContain("Semgrep");
    expect(r.skipped.map((x) => x.tool)).toContain("Gitleaks");
    expect(svc.lastReport("p1")?.findings.length).toBe(1);
    expect(markdownReport(r)).toContain("Not installed (optional)");
  });
});

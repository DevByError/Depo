import fs from "node:fs";
import path from "node:path";

/**
 * Built-in checks that need no external program: secrets in files and common insecure code
 * patterns. They are deliberately conservative (few false alarms) and every finding says how to fix it.
 * External scanners (Semgrep, Gitleaks, ...) add depth when they are installed.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  tool: string;
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  fix: string;
}

interface Rule {
  id: string;
  severity: Severity;
  title: string;
  fix: string;
  /** File extensions the rule applies to; empty = every text file. */
  ext: string[];
  re: RegExp;
}

const PY = [".py"];
const JS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const WEB = [...JS, ".html", ".vue", ".svelte"];

const SECRET_RULES: Rule[] = [
  {
    id: "secret.private-key",
    severity: "critical",
    title: "Private key committed",
    fix: "Remove the key from the repository, rotate it, and load it from an environment variable or secret store.",
    ext: [],
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: "secret.aws-key",
    severity: "critical",
    title: "AWS access key id in code",
    fix: "Rotate the key and read credentials from the environment or an IAM role.",
    ext: [],
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "secret.token",
    severity: "high",
    title: "API token in code",
    fix: "Move the token to an environment variable (and rotate it, because it is now in the history).",
    ext: [],
    re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/,
  },
  {
    id: "secret.hardcoded",
    severity: "high",
    title: "Hard-coded password, secret or API key",
    fix: "Read it from an environment variable (os.environ / process.env) and keep real values out of the repository; commit only a .env.example.",
    ext: [],
    re: /\b(?:password|passwd|secret|secret_key|api_key|apikey|auth_token|access_token|private_key)\b["']?\s*[:=]\s*["'](?!(?:\s*|changeme|change-me|your[-_ ]|example|xxx+|<|\$\{|process\.env|os\.environ|test|dummy|placeholder|\*+)["']?)[^"'\s]{8,}["']/i,
  },
];

const CODE_RULES: Rule[] = [
  {
    id: "py.sql-injection",
    severity: "high",
    title: "SQL built from user-controlled text (injection)",
    fix: "Use parameters: cursor.execute('... WHERE id = ?', (value,)) or the ORM's query API; never format values into the SQL string.",
    ext: PY,
    re: /\.execute\(\s*(?:f["']|["'][^"']*["']\s*(?:%|\+|\.format\()|[A-Za-z_]+\s*\+)/,
  },
  {
    id: "js.sql-injection",
    severity: "high",
    title: "SQL built with a template or concatenation (injection)",
    fix: "Use placeholders ($1 / ?) and pass the values separately to the driver.",
    ext: JS,
    re: /\.(?:query|execute|run|all|get)\(\s*(?:`[^`]*\$\{|["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE)[^"']*["']\s*\+)/i,
  },
  {
    id: "py.eval",
    severity: "high",
    title: "eval/exec on dynamic input (code execution)",
    fix: "Parse the data instead (json.loads, ast.literal_eval) or use an explicit dispatch table.",
    ext: PY,
    re: /(?<![\w.])(?:eval|exec)\(\s*(?!["'][^"']*["']\s*\))/,
  },
  {
    id: "js.eval",
    severity: "high",
    title: "eval / new Function on dynamic input (code execution)",
    fix: "Parse the data with JSON.parse or use an explicit lookup instead of evaluating text.",
    ext: JS,
    re: /(?<![\w.])eval\(|new Function\(/,
  },
  {
    id: "py.shell-true",
    severity: "high",
    title: "Shell command built from text (command injection)",
    fix: "Pass an argument list to subprocess.run([...]) without shell=True, and validate the arguments.",
    ext: PY,
    re: /(?:shell\s*=\s*True|os\.system\(|os\.popen\()/,
  },
  {
    id: "js.exec",
    severity: "high",
    title: "child_process.exec with a built string (command injection)",
    fix: "Use execFile / spawn with an argument array instead of a shell string.",
    ext: JS,
    re: /\bexec(?:Sync)?\(\s*(?:`[^`]*\$\{|[^)"'`]*\+)/,
  },
  {
    id: "py.pickle",
    severity: "high",
    title: "Unsafe deserialisation (pickle / yaml.load)",
    fix: "Use json, or yaml.safe_load. Never unpickle data you did not create.",
    ext: PY,
    re: /\bpickle\.loads?\(|\byaml\.load\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)(?![^)]*safe)/,
  },
  {
    id: "py.weak-hash",
    severity: "medium",
    title: "Weak hash used (MD5 / SHA-1)",
    fix: "Use SHA-256 or better; for passwords use argon2, bcrypt or scrypt.",
    ext: PY,
    re: /hashlib\.(?:md5|sha1)\(/,
  },
  {
    id: "js.weak-hash",
    severity: "medium",
    title: "Weak hash used (MD5 / SHA-1)",
    fix: "Use SHA-256 or better; for passwords use argon2, bcrypt or scrypt.",
    ext: JS,
    re: /createHash\(\s*["'](?:md5|sha1)["']\s*\)/,
  },
  {
    id: "py.tls-off",
    severity: "high",
    title: "TLS certificate checking turned off",
    fix: "Remove verify=False and fix the certificate or trust store instead.",
    ext: PY,
    re: /verify\s*=\s*False/,
  },
  {
    id: "js.tls-off",
    severity: "high",
    title: "TLS certificate checking turned off",
    fix: "Remove rejectUnauthorized: false / NODE_TLS_REJECT_UNAUTHORIZED=0.",
    ext: JS,
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
  },
  {
    id: "py.debug",
    severity: "medium",
    title: "Debug mode enabled",
    fix: "Turn debug off outside development: read it from an environment variable that defaults to false.",
    ext: PY,
    re: /\bdebug\s*=\s*True\b|DEBUG\s*=\s*True\b/,
  },
  {
    id: "web.xss",
    severity: "high",
    title: "Raw HTML inserted into the page (XSS)",
    fix: "Render text with textContent / the framework's escaping; sanitise any HTML you must insert (DOMPurify).",
    ext: WEB,
    re: /\.innerHTML\s*=|dangerouslySetInnerHTML|\bv-html\b|document\.write\(/,
  },
  {
    id: "web.cors-any",
    severity: "medium",
    title: "CORS allows every origin",
    fix: "List the exact origins that may call the API instead of '*'.",
    ext: [...PY, ...JS],
    re: /allow_origins\s*=\s*\[\s*["']\*["']\s*\]|origin\s*:\s*["']\*["']|Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']|CORS_ALLOW_ALL_ORIGINS\s*=\s*True/,
  },
  {
    id: "web.jwt-none",
    severity: "high",
    title: "JWT signature not verified",
    fix: "Always verify the signature and pin the algorithm list (e.g. algorithms=['HS256']).",
    ext: [...PY, ...JS],
    re: /verify_signature["']?\s*[:=]\s*False|algorithms?\s*[:=]\s*\[?\s*["']none["']/i,
  },
  {
    id: "py.bind-all",
    severity: "low",
    title: "Server listens on every network interface",
    fix: "Bind to 127.0.0.1 unless the service must be reachable from other machines, and put it behind a proxy.",
    ext: PY,
    re: /host\s*=\s*["']0\.0\.0\.0["']/,
  },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  "target",
  "coverage",
  ".depo",
]);
const MAX_FILES = 3000;
const MAX_BYTES = 400_000;
const TEXT_EXT = new Set([
  ...PY,
  ...WEB,
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".ps1",
  ".rb",
  ".go",
  ".java",
  ".rs",
  ".php",
  ".sql",
  ".txt",
  ".md",
  ".pem",
  ".key",
]);

/** Paths we expect to hold placeholders or sample data: findings there are reported as low. */
const SAMPLE =
  /(^|\/)(tests?|__tests__|fixtures?|examples?|docs?|samples?)\/|\.example$|\.sample$|\.test\.|\.spec\./i;

export function listScanFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) stack.push(full);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (TEXT_EXT.has(ext) || d.name.startsWith(".env") || d.name === "Dockerfile") out.push(full);
      }
    }
  }
  return out.sort();
}

const down = (s: Severity): Severity => (s === "critical" ? "high" : s === "high" ? "medium" : "low");

export function scanBuiltin(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of listScanFiles(root)) {
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const ext = path.extname(file).toLowerCase();
    const sample = SAMPLE.test(rel);
    const isEnvFile = /(^|\/)\.env($|\.(?!example|sample))/.test(rel);
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.length > 600) return;
      const trimmed = line.trim();
      // "depo-ignore" lets a developer mark a reviewed line.
      if (trimmed.includes("depo-ignore")) return;
      const isComment = /^(#|\/\/|\*|\/\*)/.test(trimmed);
      for (const r of [...SECRET_RULES, ...CODE_RULES]) {
        if (r.ext.length && !r.ext.includes(ext)) continue;
        const isSecret = r.id.startsWith("secret.");
        if (isComment && !isSecret) continue;
        if (!r.re.test(line)) continue;
        findings.push({
          tool: "depo",
          rule: r.id,
          severity: sample ? down(r.severity) : r.severity,
          file: rel,
          line: i + 1,
          title: r.title,
          fix: r.fix,
        });
      }
    });
    if (isEnvFile) {
      findings.push({
        tool: "depo",
        rule: "secret.env-file",
        severity: "medium",
        file: rel,
        line: 1,
        title: ".env file in the project",
        fix: "Keep .env out of version control (add it to .gitignore) and commit a .env.example with placeholder values.",
      });
    }
  }
  // .gitignore should cover .env when one exists.
  return dedupe(findings);
}

export function dedupe(f: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const x of f) {
    const k = `${x.file}:${x.line}:${x.rule}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

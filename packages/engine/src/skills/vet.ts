import fs from "node:fs";
import path from "node:path";

export type Severity = "high" | "medium" | "low";

export interface VetFinding {
  severity: Severity;
  rule: string;
  file: string;
  line: number;
  text: string;
}

export interface VetReport {
  verdict: "clean" | "warnings" | "blocked";
  findings: VetFinding[];
  files: number;
  scripts: number;
  scannedAt: string;
  /** Optional opinion from the Security agent's model. */
  review?: string;
}

interface Rule {
  rule: string;
  severity: Severity;
  re: RegExp;
  /** Only look in these kinds of file. */
  scope: "any" | "script" | "text";
  hint: string;
}

const RULES: Rule[] = [
  {
    rule: "pipe-to-shell",
    severity: "high",
    re: /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|python)/i,
    scope: "any",
    hint: "downloads and runs code",
  },
  {
    rule: "destructive-delete",
    severity: "high",
    re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)|\bdel\s+\/[sqf]|Remove-Item[^\n]*-Recurse[^\n]*-Force[^\n]*(C:\\|\$env:)|rd\s+\/s\s+\/q\s+[A-Za-z]:\\/i,
    scope: "any",
    hint: "deletes files outside the project",
  },
  {
    rule: "disk-or-system",
    severity: "high",
    re: /\b(format\s+[a-z]:|mkfs|diskpart|shutdown\s+\/|reg\s+(add|delete)|bcdedit|cipher\s+\/w|vssadmin\s+delete)/i,
    scope: "any",
    hint: "system-wide change",
  },
  {
    rule: "encoded-command",
    severity: "high",
    re: /(powershell|pwsh)[^\n]*-(enc|encodedcommand)\b|FromBase64String[^\n]*(iex|Invoke-Expression)|base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash)/i,
    scope: "any",
    hint: "hidden (encoded) command",
  },
  {
    rule: "credential-access",
    severity: "high",
    re: /(\.ssh[\\/](id_|authorized)|\.aws[\\/]credentials|\.npmrc|\.git-credentials|Login Data|cookies\.sqlite|\bmimikatz\b|\blsass\b)/i,
    scope: "any",
    hint: "reads credentials",
  },
  {
    rule: "exfiltration",
    severity: "high",
    re: /(send|post|upload|exfiltrate|leak)[^\n.]{0,60}(\.env|secrets?|credentials?|api[_ -]?keys?|tokens?|passwords?|source code)[^\n.]{0,60}(to|at)\s+(https?:\/\/|a remote|an external|the attacker)/i,
    scope: "any",
    hint: "sends secrets away",
  },
  {
    rule: "eval-exec",
    severity: "medium",
    re: /\b(eval|exec)\s*\(|\bnew Function\(|Invoke-Expression|\biex\b\s/i,
    scope: "script",
    hint: "runs dynamic code",
  },
  {
    rule: "shell-spawn",
    severity: "medium",
    re: /\b(os\.system|subprocess\.|child_process|Runtime\.getRuntime\(\)\.exec|Process\.Start|ShellExecute)\b/i,
    scope: "script",
    hint: "starts other programs",
  },
  {
    rule: "network-call",
    severity: "medium",
    re: /\b(requests\.(get|post|put)|urllib\.request|fetch\(|axios\.|http\.client|HttpClient|WebClient|Invoke-RestMethod|curl\s+-|wget\s)/i,
    scope: "script",
    hint: "makes network calls",
  },
  {
    rule: "install-packages",
    severity: "low",
    re: /\b(pip3?\s+install|npm\s+(i|install)|yarn\s+add|choco\s+install|winget\s+install)\b/i,
    scope: "any",
    hint: "installs software",
  },
  {
    rule: "injection-override",
    severity: "high",
    re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|polic(y|ies))\b/i,
    scope: "text",
    hint: "tries to override the agent's rules",
  },
  {
    rule: "injection-secrecy",
    severity: "high",
    re: /\b(do not|don't|never)\b[^\n]{0,30}\b(tell|inform|show|mention|reveal|let)\b[^\n]{0,30}\b(the )?user\b/i,
    scope: "text",
    hint: "asks the agent to hide things from the user",
  },
  {
    rule: "injection-prompt-leak",
    severity: "medium",
    re: /\b(reveal|print|output|repeat)\b[^\n]{0,30}\b(system prompt|hidden instructions|your instructions)\b/i,
    scope: "text",
    hint: "tries to extract the system prompt",
  },
  {
    rule: "injection-approval",
    severity: "high",
    re: /\b(without|skip|bypass|disable)\b[^\n]{0,30}\b(approval|confirmation|review|permission|asking)\b/i,
    scope: "text",
    hint: "tries to skip the user's approval",
  },
  {
    rule: "hidden-characters",
    severity: "medium",
    re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/,
    scope: "text",
    hint: "invisible characters can hide instructions",
  },
  {
    rule: "html-comment-instructions",
    severity: "medium",
    re: /<!--[^>]{20,}-->/,
    scope: "text",
    hint: "comments the reader does not see but the agent does",
  },
];

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|vbs)$/i;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|html?|csv|rst)$/i;
const MAX_FILE = 400_000;

export function vetDirectory(dir: string): VetReport {
  const findings: VetFinding[] = [];
  let files = 0;
  let scripts = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        findings.push({
          severity: "high",
          rule: "symlink",
          file: path.relative(dir, full).replace(/\\/g, "/"),
          line: 0,
          text: "A symbolic link could point outside the skill.",
        });
        continue;
      }
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      files++;
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      const isScript = SCRIPT_EXT.test(e.name);
      const isText = TEXT_EXT.test(e.name) || isScript || !path.extname(e.name);
      if (isScript) scripts++;
      if (/\.(exe|dll|msi|scr|com|jar|bin|so|dylib)$/i.test(e.name)) {
        findings.push({
          severity: "high",
          rule: "binary",
          file: rel,
          line: 0,
          text: "A compiled program cannot be reviewed.",
        });
        continue;
      }
      if (!isText) continue;
      let text = "";
      try {
        text = fs.readFileSync(full, "utf8").slice(0, MAX_FILE);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (const r of RULES) {
        if (r.scope === "script" && !isScript) continue;
        if (r.scope === "text" && isScript) continue;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (r.re.test(line)) {
            findings.push({
              severity: r.severity,
              rule: r.rule,
              file: rel,
              line: i + 1,
              text: `${r.hint}: ${line.trim().slice(0, 140)}`,
            });
            break; // one hit per rule per file is enough for the report
          }
        }
      }
    }
  };
  walk(dir);
  const hasHigh = findings.some((f) => f.severity === "high");
  return {
    verdict: hasHigh ? "blocked" : findings.length ? "warnings" : "clean",
    findings,
    files,
    scripts,
    scannedAt: new Date().toISOString(),
  };
}

/** Vet a single block of text (an MCP server description, a pasted skill). */
export function vetText(name: string, text: string): VetFinding[] {
  const out: VetFinding[] = [];
  const lines = text.split("\n");
  for (const r of RULES) {
    if (r.scope === "script") continue;
    for (let i = 0; i < lines.length; i++) {
      if (r.re.test(lines[i] ?? "")) {
        out.push({
          severity: r.severity,
          rule: r.rule,
          file: name,
          line: i + 1,
          text: `${r.hint}: ${(lines[i] ?? "").trim().slice(0, 140)}`,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Command policy: every shell command an agent wants to run is classified before it runs.
 *  - deny:  destructive or system-level (wipe drives, registry, encoded PowerShell, curl | sh …)
 *  - ask:   installs, network, git history changes, deletes, servers, anything unknown
 *  - allow: tests, builds, linters, type checkers, read-only inspection
 * Commands are split on && || ; | and each part is judged; the strictest verdict wins.
 */

export type Decision = "allow" | "ask" | "deny";
export type CommandCategory =
  | "test"
  | "install"
  | "build"
  | "lint"
  | "git"
  | "inspect"
  | "network"
  | "server"
  | "other";

export interface PolicyVerdict {
  decision: Decision;
  category: CommandCategory;
  reason: string;
}

const DENY: [RegExp, string][] = [
  [
    /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\/\*|[a-z]:[\\/]?)(\s|$)/i,
    "deletes a whole drive or home folder",
  ],
  [/\b(rd|rmdir)\s+\/s\b.*\s[a-z]:\\?(\s|$)/i, "deletes a whole drive"],
  [/\bdel\s+.*\/s.*\s[a-z]:\\?\*?(\s|$)/i, "deletes files across a drive"],
  [/\bformat(\.com)?\s+[a-z]:/i, "formats a drive"],
  [/\b(mkfs(\.\w+)?|diskpart|bcdedit|fdisk|vssadmin|cipher\s+\/w)\b/i, "changes disks or boot settings"],
  [/\bdd\s+.*\bof=\/dev\//i, "writes to a raw device"],
  [/\b(shutdown|reboot|halt|poweroff)\b|\bRestart-Computer\b|\bStop-Computer\b/i, "shuts down the computer"],
  [
    /\breg(\.exe)?\s+(add|delete|import)\b|\b(Set|New|Remove)-ItemProperty\s+.*HK(LM|CU)/i,
    "edits the Windows registry",
  ],
  [/\b(powershell|pwsh)(\.exe)?\b.*\s[-/](e|ec|en|enc|enco\w*)(\s|$)/i, "runs encoded PowerShell"],
  [
    /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python\d?|node|pwsh|powershell)\b/i,
    "pipes a download straight into a shell",
  ],
  [/\bSet-ExecutionPolicy\b|\btakeown\b|\bicacls\b.*\/grant/i, "changes system security settings"],
  [
    /\bnet\s+(user|localgroup)\b|\bsc(\.exe)?\s+(delete|create|config)\b|\bschtasks\b.*\/create/i,
    "changes users, services or scheduled tasks",
  ],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [
    /\bchmod\s+(-R\s+)?777\s+\/(\s|$)|\bchown\s+-R\s+.*\s\/(\s|$)/i,
    "changes permissions on the whole system",
  ],
  [/\bsudo\b|\brunas\b/i, "asks for administrator rights"],
];

/** First word of a command → [decision, category]. Subcommand rules refine some of them. */
const ALLOW_TOOLS: Record<string, CommandCategory> = {
  pytest: "test",
  "py.test": "test",
  tox: "test",
  nox: "test",
  jest: "test",
  vitest: "test",
  mocha: "test",
  ruff: "lint",
  black: "lint",
  flake8: "lint",
  pylint: "lint",
  mypy: "lint",
  pyright: "lint",
  isort: "lint",
  eslint: "lint",
  prettier: "lint",
  biome: "lint",
  tsc: "build",
  ls: "inspect",
  dir: "inspect",
  cat: "inspect",
  type: "inspect",
  head: "inspect",
  tail: "inspect",
  wc: "inspect",
  pwd: "inspect",
  echo: "inspect",
  where: "inspect",
  which: "inspect",
  tree: "inspect",
  grep: "inspect",
  rg: "inspect",
  findstr: "inspect",
  sort: "inspect",
  diff: "inspect",
  mkdir: "other",
  md: "other",
  touch: "other",
  cd: "inspect",
};

const INSTALLERS =
  /^(pip|pip3|uv|poetry|pipenv|conda|npm|pnpm|yarn|bun|cargo|go|gem|composer|dotnet|choco|winget|scoop|apt|apt-get|brew|nuget)$/i;
const NETWORK =
  /^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer)$/i;
const SERVERS = /^(uvicorn|gunicorn|hypercorn|flask|fastapi|http-server|serve|live-server|nodemon)$/i;

export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    // `2>&1` and `&>` are redirects, not command separators.
    if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
      cur += c;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function tokenize(part: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(part);
  while (m) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
    m = re.exec(part);
  }
  return out;
}

function exeName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/** Judge one simple command (no && || ; |). */
function judgePart(part: string, projectRoot: string | null): PolicyVerdict {
  let tokens = tokenize(part);
  // Leading VAR=value assignments (POSIX) and `set X=1` (cmd) do not change what runs.
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  const word = tokens[0];
  if (!word) return { decision: "allow", category: "other", reason: "empty" };
  const exe = exeName(word);
  const args = tokens.slice(1);
  const a0 = (args[0] ?? "").toLowerCase();
  const a1 = (args[1] ?? "").toLowerCase();

  if (exe === "set" || exe === "export")
    return { decision: "allow", category: "other", reason: "sets a variable" };

  // Absolute paths outside the project need a human to look.
  if (projectRoot) {
    const outside = args.find((t) => isAbsoluteOutside(t, projectRoot));
    if (outside) {
      return { decision: "ask", category: "other", reason: `uses a path outside the project: ${outside}` };
    }
  }

  if (exe === "python" || exe === "python3" || exe === "py") {
    if (a0 === "-m") {
      const mod = a1;
      if (["pytest", "unittest", "doctest", "tox", "nox"].includes(mod)) return allow("test", `runs ${mod}`);
      if (
        [
          "mypy",
          "ruff",
          "black",
          "flake8",
          "pylint",
          "isort",
          "pyright",
          "compileall",
          "py_compile",
        ].includes(mod)
      )
        return allow("lint", `runs ${mod}`);
      if (mod === "pip" || mod === "pipx") return pipVerdict(args.slice(2));
      if (mod === "venv" || mod === "virtualenv") return allow("build", "creates a virtual environment");
      if (["uvicorn", "flask", "http.server", "gunicorn", "fastapi"].includes(mod))
        return ask("server", "starts a long-running server");
      if (mod === "json.tool") return allow("inspect", "formats JSON");
    }
    if (a0 === "--version" || a0 === "-v" || a0 === "-V") return allow("inspect", "prints the version");
    return ask("other", "runs a Python script");
  }
  if (exe === "pip" || exe === "pip3") return pipVerdict(args);
  if (exe === "uv") {
    if (a0 === "run" && ["pytest", "python"].includes(a1))
      return judgePart(args.slice(1).join(" "), projectRoot);
    if (a0 === "pip") return pipVerdict(args.slice(1));
    if (["add", "sync", "lock", "install", "remove"].includes(a0))
      return ask("install", "changes dependencies");
    if (a0 === "venv") return allow("build", "creates a virtual environment");
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    if (
      a0 === "test" ||
      a0 === "t" ||
      (a0 === "run" && /^(test|lint|build|typecheck|check|format)(:|$)/.test(a1))
    )
      return allow(
        /test/.test(a0 + a1) ? "test" : a1.startsWith("lint") ? "lint" : "build",
        `runs ${exe} ${a0} ${a1}`.trim(),
      );
    if (exe === "bun" && a0 === "test") return allow("test", "runs bun test");
    if (["install", "i", "add", "ci", "remove", "uninstall", "update", "upgrade"].includes(a0))
      return ask("install", "changes dependencies");
    if (a0 === "run" && /^(dev|start|serve|preview)/.test(a1))
      return ask("server", "starts a long-running server");
    if (["--version", "-v", "list", "ls", "outdated", "why"].includes(a0))
      return allow("inspect", "inspects packages");
    return ask("other", `runs ${exe} ${a0}`.trim());
  }
  if (exe === "npx" || exe === "bunx" || exe === "pnpx") {
    const tool = exeName(a0);
    if (tool && ALLOW_TOOLS[tool]) return allow(ALLOW_TOOLS[tool] as CommandCategory, `runs ${tool}`);
    return ask("install", `downloads and runs ${a0 || "a package"}`);
  }
  if (exe === "cargo") {
    if (["build", "check", "test", "clippy", "fmt", "doc", "bench"].includes(a0))
      return allow(
        a0 === "test" || a0 === "bench" ? "test" : a0 === "clippy" || a0 === "fmt" ? "lint" : "build",
        `runs cargo ${a0}`,
      );
    if (a0 === "run") return ask("other", "runs the program");
    return ask("install", `runs cargo ${a0}`);
  }
  if (exe === "go") {
    if (["build", "test", "vet", "fmt"].includes(a0))
      return allow(a0 === "test" ? "test" : "build", `runs go ${a0}`);
    return ask(a0 === "get" || a0 === "install" ? "install" : "other", `runs go ${a0}`);
  }
  if (exe === "dotnet") {
    if (["build", "test", "format"].includes(a0))
      return allow(a0 === "test" ? "test" : "build", `runs dotnet ${a0}`);
    return ask(a0 === "add" || a0 === "restore" ? "install" : "other", `runs dotnet ${a0}`);
  }
  if (exe === "git") return gitVerdict(a0, args);
  if (exe === "node" || exe === "deno") {
    if (a0 === "--version" || a0 === "-v") return allow("inspect", "prints the version");
    return ask("other", `runs a ${exe} script`);
  }
  if (exe === "find") {
    if (args.some((t) => /^-(delete|exec|execdir|ok)$/.test(t)))
      return ask("other", "find with -delete or -exec");
    return allow("inspect", "lists files");
  }
  if (["rm", "del", "erase", "rd", "rmdir", "remove-item", "ri"].includes(exe))
    return ask("other", "deletes files");
  if (
    ["mv", "move", "move-item", "cp", "copy", "xcopy", "robocopy", "copy-item", "ren", "rename"].includes(exe)
  )
    return ask("other", "moves or copies files");
  if (exe === "make") {
    if (/^(test|check|lint|build|all)?$/.test(a0))
      return allow(a0 === "test" || a0 === "check" ? "test" : "build", "runs make");
    return ask("other", `runs make ${a0}`);
  }
  if (INSTALLERS.test(exe)) return ask("install", `runs ${exe}`);
  if (NETWORK.test(exe)) return ask("network", "uses the network");
  if (SERVERS.test(exe)) return ask("server", "starts a long-running server");
  if (exe === "docker" || exe === "podman" || exe === "kubectl") return ask("other", `runs ${exe}`);
  if (exe === "powershell" || exe === "pwsh" || exe === "cmd" || exe === "bash" || exe === "sh")
    return ask("other", "starts another shell");
  const known = ALLOW_TOOLS[exe];
  if (known) return allow(known, `runs ${exe}`);
  return ask("other", `${exe} is not on the list of known safe commands`);
}

function pipVerdict(args: string[]): PolicyVerdict {
  const sub = (args[0] ?? "").toLowerCase();
  if (["list", "show", "freeze", "check", "--version", "-v"].includes(sub))
    return allow("inspect", "inspects packages");
  return ask("install", `pip ${sub || ""} changes installed packages`.replace("  ", " "));
}

function gitVerdict(sub: string, args: string[]): PolicyVerdict {
  const s = sub.toLowerCase();
  if (
    [
      "status",
      "diff",
      "log",
      "show",
      "branch",
      "rev-parse",
      "ls-files",
      "blame",
      "describe",
      "shortlog",
      "grep",
    ].includes(s)
  ) {
    if (s === "branch" && args.some((a) => /^-(d|D|m|M|-delete|-move)$/.test(a)))
      return ask("git", "changes branches");
    return allow("git", `git ${s} is read-only`);
  }
  if (["add", "stash", "checkout", "switch", "restore", "commit", "tag", "init"].includes(s))
    return ask("git", `git ${s} changes the repository`);
  if (["push", "pull", "fetch", "clone", "remote", "submodule"].includes(s))
    return ask("network", `git ${s} uses the network`);
  if (s === "reset" || s === "clean" || s === "rebase" || s === "filter-branch")
    return ask("git", `git ${s} can lose work`);
  return ask("git", `git ${s}`);
}

function allow(category: CommandCategory, reason: string): PolicyVerdict {
  return { decision: "allow", category, reason };
}
function ask(category: CommandCategory, reason: string): PolicyVerdict {
  return { decision: "ask", category, reason };
}

function isAbsoluteOutside(token: string, root: string): boolean {
  const t = token.replace(/^--?[\w-]+=/, "");
  const isAbs =
    /^[a-zA-Z]:[\\/]/.test(t) ||
    t.startsWith("\\\\") ||
    (t.startsWith("/") && t.length > 1 && !/^\/[a-zA-Z?]$/.test(t));
  if (!isAbs) return false;
  // cmd switches like /s /q /b are not paths
  if (/^\/[a-zA-Z?]{1,3}(:.*)?$/.test(t)) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  const n = norm(t);
  return !(n === r || n.startsWith(`${r}/`));
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function classifyCommand(command: string, projectRoot: string | null = null): PolicyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { decision: "deny", category: "other", reason: "empty command" };
  if (trimmed.length > 4000) return { decision: "deny", category: "other", reason: "command is too long" };
  for (const [re, reason] of DENY)
    if (re.test(trimmed)) return { decision: "deny", category: "other", reason };
  if (/[`]|\$\(/.test(trimmed)) return ask("other", "uses command substitution");
  if (/(^|[^<>])>{1,2}\s*[a-zA-Z]:[\\/]|>{1,2}\s*\/(?!dev\/null)/.test(trimmed))
    return ask("other", "writes output to a path outside the project");
  let worst: PolicyVerdict = allow("other", "no command");
  let category: CommandCategory | null = null;
  for (const part of splitCommand(trimmed)) {
    const v = judgePart(part, projectRoot);
    if (category === null || (category === "inspect" && v.category !== "inspect") || v.category === "test")
      category = v.category;
    if (RANK[v.decision] > RANK[worst.decision] || worst.reason === "no command") worst = v;
  }
  return { ...worst, category: worst.decision === "allow" ? (category ?? worst.category) : worst.category };
}

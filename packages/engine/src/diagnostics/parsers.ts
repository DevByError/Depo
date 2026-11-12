import path from "node:path";
import type { Problem, ProblemSeverity } from "@depo/shared";

/**
 * Parsers for compiler and linter output. Each takes the tool's output and the folder it ran in
 * and returns problems with files relative to the project root (forward slashes). They are
 * forgiving: lines they do not understand are skipped.
 */

export interface ParseContext {
  /** The project root (or the task's copy). */
  root: string;
  /** The folder the tool ran in. */
  cwd: string;
}

const MAX_MESSAGE = 1500;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE)} …` : t;
}

/** A file from tool output, relative to the root with forward slashes. */
export function normalizeFile(file: string, ctx: ParseContext): string {
  let f = file.trim().replace(/^file:\/\/\/?/, "");
  if (/^\/[A-Za-z]:\//.test(f)) f = f.slice(1);
  // Windows paths are handled the same on every OS (tests read Windows output on Linux too).
  const winRoot = /^[A-Za-z]:[\\/]/.test(ctx.root) || ctx.root.startsWith("\\\\");
  const P = winRoot ? path.win32 : path;
  const isAbs = /^[A-Za-z]:[\\/]/.test(f) || f.startsWith("\\\\") || (!winRoot && path.isAbsolute(f));
  const abs = P.normalize(isAbs ? f : P.join(ctx.cwd, f));
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(P.normalize(ctx.root));
  const n = norm(abs);
  const insensitive = process.platform === "win32" || winRoot;
  const same = (a: string, b: string) => (insensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(n.slice(0, r.length), r) && n[r.length] === "/") return n.slice(r.length + 1);
  return n;
}

function problem(
  tool: string,
  severity: ProblemSeverity,
  message: string,
  file: string | null,
  line: number | null,
  column: number | null,
  code: string | null,
): Problem {
  return { tool, severity, message: clip(message), file, line, column, code };
}

// ---- TypeScript: `src/a.ts(1,7): error TS2322: Type 'string' is not assignable ...` --------

export function parseTsc(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  let last: Problem | null = null;
  for (const raw of out.split("\n")) {
    const l = raw.replace(/\r$/, "");
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/.exec(l);
    if (m) {
      const sev: ProblemSeverity = m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "info";
      last = problem(
        "tsc",
        sev,
        m[6] as string,
        normalizeFile(m[1] as string, ctx),
        Number(m[2]),
        Number(m[3]),
        m[5] as string,
      );
      res.push(last);
      continue;
    }
    const g = /^(error|warning) (TS\d+): (.*)$/.exec(l);
    if (g) {
      last = problem(
        "tsc",
        g[1] === "error" ? "error" : "warning",
        g[3] as string,
        null,
        null,
        null,
        g[2] as string,
      );
      res.push(last);
      continue;
    }
    // Continuation lines of a long message are indented.
    if (last && /^ {2,}\S/.test(l) && last.message.length < MAX_MESSAGE)
      last.message = clip(`${last.message}\n${l.trim()}`);
    else last = null;
  }
  return res;
}

// ---- GitHub annotations (Biome --reporter=github) ----------------------------------------------

function unescapeAnnotation(s: string): string {
  return s
    .replace(/%0D/gi, "\r")
    .replace(/%0A/gi, "\n")
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",")
    .replace(/%25/g, "%");
}

export function parseGithubAnnotations(out: string, ctx: ParseContext, tool: string): Problem[] {
  const res: Problem[] = [];
  for (const l of out.split("\n")) {
    const m = /^::(error|warning|notice)\s+(.*?)::(.*)$/.exec(l.replace(/\r$/, ""));
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const part of (m[2] as string).split(",")) {
      const i = part.indexOf("=");
      if (i > 0) props[part.slice(0, i).trim()] = unescapeAnnotation(part.slice(i + 1));
    }
    const sev: ProblemSeverity = m[1] === "error" ? "error" : m[1] === "warning" ? "warning" : "info";
    res.push(
      problem(
        tool,
        sev,
        unescapeAnnotation(m[3] as string),
        props.file ? normalizeFile(props.file, ctx) : null,
        props.line ? Number(props.line) : null,
        props.col ? Number(props.col) : null,
        props.title ?? null,
      ),
    );
  }
  return res;
}

// ---- ESLint (stylish, the default formatter in every version) ---------------------------------

export function parseEslintStylish(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  let file: string | null = null;
  for (const raw of out.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (!l.trim()) continue;
    if (/^\S/.test(l) && !/^✖|^\d+ problems?/.test(l)) {
      file = normalizeFile(l.trim(), ctx);
      continue;
    }
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w][\w@/.-]*))?\s*$/.exec(l);
    if (!m || !file) continue;
    res.push(
      problem(
        "eslint",
        m[3] === "error" ? "error" : "warning",
        m[4] as string,
        file,
        Number(m[1]),
        Number(m[2]),
        m[5] ?? null,
      ),
    );
  }
  return res;
}

// ---- Ruff (--output-format=json) ---------------------------------------------------------------

interface RuffItem {
  code?: string | null;
  message?: string;
  filename?: string;
  location?: { row?: number; column?: number };
}

/** Syntax errors and names that do not exist break the program; the other rules are warnings. */
export function ruffSeverity(code: string | null, message: string): ProblemSeverity {
  if (!code || code === "invalid-syntax" || code.startsWith("E9") || /^SyntaxError/.test(message))
    return "error";
  if (/^F(82[123]|63\d|7\d\d)$/.test(code)) return "error";
  return "warning";
}

export function parseRuffJson(out: string, ctx: ParseContext): Problem[] | null {
  const start = out.indexOf("[");
  if (start < 0) return null;
  let items: RuffItem[];
  try {
    items = JSON.parse(out.slice(start, out.lastIndexOf("]") + 1)) as RuffItem[];
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  return items.map((it) => {
    const code = it.code ?? null;
    const message = it.message ?? "";
    return problem(
      "ruff",
      ruffSeverity(code, message),
      message,
      it.filename ? normalizeFile(it.filename, ctx) : null,
      it.location?.row ?? null,
      it.location?.column ?? null,
      code,
    );
  });
}

// ---- python -m compileall -q -------------------------------------------------------------------

export function parseCompileall(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const h = /^\*\*\* Error compiling '(.+?)'\.\.\./.exec(lines[i] as string);
    if (!h) continue;
    let line: number | null = null;
    let message = "";
    for (let j = i + 1; j < lines.length && !/^\*\*\* /.test(lines[j] as string); j++) {
      const l = lines[j] as string;
      const f = /^\s*File ".*?", line (\d+)/.exec(l);
      if (f) line = Number(f[1]);
      const e = /^(?:Sorry: )?(\w*(?:Error|Exception|Warning)\b.*)$/.exec(l.trim());
      if (e) message = e[1] as string;
    }
    res.push(
      problem(
        "compileall",
        "error",
        message || "Python could not compile this file",
        normalizeFile(h[1] as string, ctx),
        line,
        null,
        message.split(":")[0] || null,
      ),
    );
  }
  return res;
}

// ---- mypy: `app/x.py:2:12: error: Incompatible return value type  [return-value]` -----------

export function parseMypy(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  for (const raw of out.split("\n")) {
    const m = /^(.+?):(\d+):(?:(\d+):)? (error|warning): (.*?)(?:\s+\[([\w-]+)\])?$/.exec(
      raw.replace(/\r$/, ""),
    );
    if (!m) continue;
    res.push(
      problem(
        "mypy",
        m[4] === "error" ? "error" : "warning",
        m[5] as string,
        normalizeFile(m[1] as string, ctx),
        Number(m[2]),
        m[3] ? Number(m[3]) : null,
        m[6] ?? null,
      ),
    );
  }
  return res;
}

// ---- Pyright (--outputjson) --------------------------------------------------------------------

interface PyrightItem {
  file?: string;
  severity?: string;
  message?: string;
  rule?: string;
  range?: { start?: { line?: number; character?: number } };
}

export function parsePyrightJson(out: string, ctx: ParseContext): Problem[] | null {
  const start = out.indexOf("{");
  if (start < 0) return null;
  let data: { generalDiagnostics?: PyrightItem[] };
  try {
    data = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as { generalDiagnostics?: PyrightItem[] };
  } catch {
    return null;
  }
  return (data.generalDiagnostics ?? []).map((d) =>
    problem(
      "pyright",
      d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      d.message ?? "",
      d.file ? normalizeFile(d.file, ctx) : null,
      typeof d.range?.start?.line === "number" ? d.range.start.line + 1 : null,
      typeof d.range?.start?.character === "number" ? d.range.start.character + 1 : null,
      d.rule ?? null,
    ),
  );
}

// ---- go vet ------------------------------------------------------------------------------------

const GO_COMPILE =
  /syntax error|undefined:|cannot use|declared and not used|imported and not used|missing return|not enough arguments|too many arguments|redeclared|is not used|cannot find package|no required module/;

/** Colour codes some environments force on (CARGO_TERM_COLOR=always on CI). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is the point
const ANSI = /\u001b\[[0-9;]*m/g;

export function parseGoVet(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  for (const raw of out.replace(ANSI, "").split("\n")) {
    // Windows prints "vet.exe: file.go:4:9: ..." where other systems print "vet: ...".
    const m = /^(vet(?:\.exe)?: )?(\S.*?\.go):(\d+):(?:(\d+):)? (.*)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    // "vet: " marks type-check errors (the package does not compile); the rest are vet findings.
    const message = m[5] as string;
    const sev: ProblemSeverity = m[1] || GO_COMPILE.test(message) ? "error" : "warning";
    res.push(
      problem(
        "go vet",
        sev,
        message,
        normalizeFile(m[2] as string, ctx),
        Number(m[3]),
        m[4] ? Number(m[4]) : null,
        null,
      ),
    );
  }
  return res;
}

// ---- cargo check --message-format=short --------------------------------------------------------

export function parseCargoShort(out: string, ctx: ParseContext): Problem[] {
  const res: Problem[] = [];
  for (const raw of out.replace(ANSI, "").split("\n")) {
    const m = /^(.+?):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    res.push(
      problem(
        "cargo check",
        m[4] === "error" ? "error" : "warning",
        m[6] as string,
        normalizeFile(m[1] as string, ctx),
        Number(m[2]),
        Number(m[3]),
        m[5] ?? null,
      ),
    );
  }
  return res;
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Worst first, then by file and line; identical problems once. */
export function sortProblems<T extends Problem>(problems: T[]): T[] {
  const seen = new Set<string>();
  return problems
    .filter((p) => {
      const k = `${p.tool}|${p.file}|${p.line}|${p.column}|${p.code}|${p.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.file ?? "~").localeCompare(b.file ?? "~") ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.column ?? 0) - (b.column ?? 0),
    );
}

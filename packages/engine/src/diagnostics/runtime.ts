import type { PageCheck, PreviewInfo, PreviewLogLine, RuntimeProblem } from "@depo/shared";
import { STACK_FRAME } from "../terminal/test-parsers";
import { normalizeFile } from "./parsers";

/**
 * Runtime problems: crashes in a running app's log (Python tracebacks, JavaScript error stacks,
 * an app that exited with an error) and console errors from the newest page check. Files are
 * the innermost stack frame inside the project, relative to its root.
 */

const MAX_EXCERPT_LINES = 40;
const MAX_PROBLEMS = 20;

interface Crash {
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  excerpt: string[];
}

function inProject(file: string, root: string): string | null {
  const rel = normalizeFile(file, { root, cwd: root });
  if (/^[A-Za-z]:\/|^\//.test(rel)) return null;
  if (/(^|\/)(node_modules|site-packages|\.venv|venv|env|lib\/python[\d.]*)\//.test(rel)) return null;
  return rel;
}

const PY_EXCEPTION =
  /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Failure)|[A-Z]\w+Error)(?::\s*(.*))?$/;
const JS_ERROR = /^(?:Uncaught\s+)?(?:\[?\w+\]?\s+)?((?:[A-Z]\w*)?Error)(?:\s*\[[\w_]+\])?:\s*(.+)$/;
const JS_FRAME = STACK_FRAME;

/** Crashes in log lines: Python tracebacks and JavaScript errors followed by a stack. */
export function crashesFromLog(lines: string[], root: string): Crash[] {
  const out: Crash[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^\s*Traceback \(most recent call last\):\s*$/.test(l)) {
      const excerpt = [l];
      let file: string | null = null;
      let line: number | null = null;
      let message = "";
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j] as string;
        excerpt.push(t);
        const f = /^\s*File "(.+?)", line (\d+)/.exec(t);
        if (f) {
          const rel = inProject(f[1] as string, root);
          if (rel) {
            file = rel;
            line = Number(f[2]);
          }
          continue;
        }
        const indent = /^\s/.test(t);
        const ex = PY_EXCEPTION.exec(t.trim());
        if (!indent && ex) {
          message = t.trim();
          break;
        }
        if (!indent && t.trim() && !/^\s*\^+\s*$/.test(t)) {
          message = t.trim();
          break;
        }
      }
      out.push({
        message: message || "Python traceback",
        file,
        line,
        column: null,
        excerpt: excerpt.slice(-MAX_EXCERPT_LINES),
      });
      i = j;
      continue;
    }
    const js = JS_ERROR.exec(l.trim());
    if (js && JS_FRAME.test(lines[i + 1] ?? "")) {
      const excerpt = [l];
      let file: string | null = null;
      let line: number | null = null;
      let column: number | null = null;
      let j = i + 1;
      for (; j < lines.length && JS_FRAME.test(lines[j] as string); j++) {
        const t = lines[j] as string;
        excerpt.push(t);
        const f = JS_FRAME.exec(t);
        if (f && file === null && !/^node:/.test(f[1] as string)) {
          const rel = inProject(f[1] as string, root);
          if (rel) {
            file = rel;
            line = Number(f[2]);
            column = Number(f[3]);
          }
        }
      }
      out.push({
        message: `${js[1]}: ${js[2]}`,
        file,
        line,
        column,
        excerpt: excerpt.slice(0, MAX_EXCERPT_LINES),
      });
      i = j - 1;
    }
  }
  return out;
}

/** Problems from running previews: crashes in their logs, and apps that stopped with an error. */
export function previewProblems(
  previews: { info: PreviewInfo; lines: PreviewLogLine[] }[],
  root: string,
): RuntimeProblem[] {
  const out: RuntimeProblem[] = [];
  for (const { info, lines } of previews) {
    const texts = lines.filter((l) => l.stream !== "depo").map((l) => l.text);
    for (const c of crashesFromLog(texts, root))
      out.push({
        tool: "preview",
        source: "preview",
        severity: "error",
        code: null,
        message: c.message,
        file: c.file,
        line: c.line,
        column: c.column,
        excerpt: c.excerpt.join("\n"),
        at: info.startedAt,
        ref: info.id,
        count: 1,
      });
    if (info.state === "failed" && (info.exitCode ?? 0) !== 0)
      out.push({
        tool: "preview",
        source: "preview",
        severity: "error",
        code: info.exitCode !== null ? `exit ${info.exitCode}` : null,
        message:
          info.error ?? `The app stopped${info.exitCode !== null ? ` with exit code ${info.exitCode}` : ""}.`,
        file: null,
        line: null,
        column: null,
        excerpt: texts.slice(-20).join("\n"),
        at: info.stoppedAt ?? info.startedAt,
        ref: info.id,
        count: 1,
      });
  }
  return out;
}

/** A script URL from the browser (`http://127.0.0.1:5173/src/App.tsx:12:5`) as a project file. */
function sourceFile(
  source: string | null,
  exists: (rel: string) => boolean,
): { file: string; line: number | null } | null {
  if (!source) return null;
  const m = /^(?:https?:\/\/[^/]+)?\/?([^?#]+?)(?:\?[^:]*)?(?::(\d+))?(?::\d+)?$/.exec(source.trim());
  if (!m) return null;
  let rel = m[1] as string;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // keep it as it is
  }
  rel = rel.replace(/^\/+/, "");
  for (const candidate of [rel, `public/${rel}`])
    if (rel && !rel.includes("..") && exists(candidate))
      return { file: candidate, line: m[2] ? Number(m[2]) : null };
  return null;
}

/** Console errors from a page check (each once), as runtime problems. */
export function pageCheckProblems(check: PageCheck, exists: (rel: string) => boolean): RuntimeProblem[] {
  const seen = new Map<string, RuntimeProblem>();
  for (const v of check.views) {
    for (const c of v.consoleErrors) {
      const hit = seen.get(c.text);
      if (hit) {
        hit.count++;
        continue;
      }
      const src = sourceFile(c.source, exists);
      seen.set(c.text, {
        tool: "page check",
        source: "page check",
        severity: "error",
        code: c.kind,
        message: c.text,
        file: src?.file ?? null,
        line: src?.line ?? null,
        column: null,
        excerpt: [`Page: ${check.url} (${v.width})`, c.source ? `Source: ${c.source}` : ""]
          .filter(Boolean)
          .join("\n"),
        at: check.at,
        ref: check.id,
        count: 1,
      });
    }
  }
  return [...seen.values()];
}

/** Same message at the same place once, with a count; newest first; at most 20. */
export function mergeRuntime(problems: RuntimeProblem[]): RuntimeProblem[] {
  const map = new Map<string, RuntimeProblem>();
  for (const p of problems) {
    const k = `${p.source}|${p.file}|${p.line}|${p.message}`;
    const hit = map.get(k);
    if (hit) hit.count += p.count;
    else map.set(k, { ...p });
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_PROBLEMS);
}

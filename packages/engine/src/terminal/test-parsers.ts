import path from "node:path";
import type { TestFailure } from "@depo/shared";
import { summarizeTests } from "../tools/index";
import { stripAnsi } from "./ring";

/**
 * Read per-test failures from test runner output: pytest, unittest, jest, vitest, bun test,
 * go test and cargo test. Each parser is small and forgiving; output it does not recognise falls
 * back to the pass/fail summary (summarizeTests) or nothing.
 */

export interface ParsedTests {
  format: "pytest" | "unittest" | "jest" | "vitest" | "bun" | "go" | "cargo" | null;
  passed: number | null;
  failed: number | null;
  summary: string | null;
  failures: TestFailure[];
}

const MAX_FAILURES = 50;
const MAX_MESSAGE = 1500;

function clip(s: string, max = MAX_MESSAGE): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

/** A path from the output, relative to `root` with forward slashes when it is inside it. */
export function relFile(file: string, root?: string): string {
  let f = file.trim().replace(/^file:\/\/\/?/, "");
  if (/^\/[A-Za-z]:\//.test(f)) f = f.slice(1);
  const abs = path.isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f);
  if (abs && root) {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const r = norm(root);
    const n = norm(f);
    const cmp =
      process.platform === "win32" || /^[A-Za-z]:/.test(n)
        ? (s: string) => s.toLowerCase()
        : (s: string) => s;
    if (cmp(n).startsWith(`${cmp(r)}/`)) return n.slice(r.length + 1);
  }
  return f.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseTestOutput(raw: string, root?: string): ParsedTests {
  const out = stripAnsi(raw).replace(/\r\n/g, "\n");
  const parsers = [parsePytest, parseUnittest, parseVitest, parseJest, parseBun, parseGo, parseCargo];
  for (const p of parsers) {
    const r = p(out, root);
    if (r) return { ...r, failures: r.failures.slice(0, MAX_FAILURES) };
  }
  const s = summarizeTests(out);
  return {
    format: null,
    passed: s?.passed ?? null,
    failed: s?.failed ?? null,
    summary: s?.text ?? null,
    failures: [],
  };
}

type Parser = (out: string, root?: string) => ParsedTests | null;

// ---- pytest ------------------------------------------------------------------------------------

export const parsePytest: Parser = (out, root) => {
  const lines = out.split("\n");
  const summaryLine = [...lines].reverse().find((l) => /\d+ (passed|failed|errors?)\b.* in [\d.]+s/.test(l));
  const hasMarkers =
    /^=+ (FAILURES|ERRORS|short test summary info) =+$/m.test(out) || /^FAILED \S+::/m.test(out);
  if (!summaryLine && !hasMarkers) return null;
  // Blocks under "= FAILURES =" / "= ERRORS =": "____ name ____", code, "E   ..." lines, "file:line: Type".
  const blocks = new Map<string, { file: string | null; line: number | null; message: string }>();
  let inSection = false;
  let current: { name: string; e: string[]; file: string | null; line: number | null } | null = null;
  const close = () => {
    if (current)
      blocks.set(current.name, { file: current.file, line: current.line, message: current.e.join("\n") });
    current = null;
  };
  for (const l of lines) {
    if (/^=+ (FAILURES|ERRORS) =+$/.test(l)) {
      inSection = true;
      continue;
    }
    if (/^=+ .* =+$/.test(l) && inSection) {
      close();
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const h = /^_{3,} (.+?) _{3,}$/.exec(l);
    if (h) {
      close();
      current = {
        name: (h[1] as string).replace(/^(ERROR at \w+ of|ERROR collecting) /, ""),
        e: [],
        file: null,
        line: null,
      };
      continue;
    }
    if (!current) continue;
    const e = /^E {2,}(.*)$/.exec(l);
    if (e) current.e.push(e[1] as string);
    const loc = /^([^\s:][^:]*\.py):(\d+): \w/.exec(l);
    if (loc) {
      current.file = relFile(loc[1] as string, root);
      current.line = Number(loc[2]);
    }
  }
  close();
  const failures: TestFailure[] = [];
  const used = new Set<string>();
  for (const l of lines) {
    const m = /^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/.exec(l);
    if (!m) continue;
    const file = m[2] as string;
    const test = m[3] ?? null;
    const name = test ? test.replace(/::/g, ".") : file;
    const block =
      blocks.get(name) ?? [...blocks.entries()].find(([k]) => name.endsWith(k) || k.endsWith(name))?.[1];
    if (block) used.add(name);
    failures.push({
      name: test ? `${file}::${test}` : file,
      file: relFile(block?.file ?? file.split("::")[0] ?? file, root),
      line: block?.line ?? null,
      message: clip(block?.message || m[4] || (m[1] === "ERROR" ? "Error" : "Failed")),
    });
  }
  if (failures.length === 0)
    for (const [name, b] of blocks)
      failures.push({ name, file: b.file, line: b.line, message: clip(b.message || "Failed") });
  const passed = summaryLine ? Number(summaryLine.match(/(\d+) passed/)?.[1] ?? 0) : null;
  const failed = summaryLine
    ? Number(summaryLine.match(/(\d+) failed/)?.[1] ?? 0) +
      Number(summaryLine.match(/(\d+) errors?/)?.[1] ?? 0)
    : failures.length;
  return {
    format: "pytest",
    passed,
    failed,
    summary: summaryLine ? summaryLine.replace(/=+/g, "").trim() : null,
    failures,
  };
};

// ---- unittest ----------------------------------------------------------------------------------

export const parseUnittest: Parser = (out, root) => {
  const ran = /^Ran (\d+) tests? in [\d.]+s$/m.exec(out);
  if (!ran && !/^(FAIL|ERROR): \w+ \(/m.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(FAIL|ERROR): (\w+) \(([\w.]+)\)/.exec(lines[i] as string);
    if (!h) continue;
    let file: string | null = null;
    let line: number | null = null;
    let message = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] as string;
      if (/^(=|-){20,}$/.test(l) && j > i + 1) break;
      const f = /^\s*File "(.+?)", line (\d+)/.exec(l);
      if (f && !/[\\/](site-packages|lib[\\/]python[\d.]*|unittest)[\\/]/.test(f[1] as string)) {
        file = relFile(f[1] as string, root);
        line = Number(f[2]);
      }
      if (/^[A-Za-z_][\w.]*(Error|Exception|Failure)\b|^AssertionError|^[A-Z]\w+: /.test(l)) message = l;
    }
    const cls = (h[3] as string).split(".");
    failures.push({
      name: `${cls.slice(-1)[0] === h[2] ? cls.slice(0, -1).join(".") : h[3]}.${h[2]}`,
      file,
      line,
      message: clip(message || (h[1] === "ERROR" ? "Error" : "Failed")),
    });
  }
  const total = ran ? Number(ran[1]) : null;
  const res = /^FAILED \(([^)]*)\)$/m.exec(out);
  const count = (k: string) => Number(res?.[1]?.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? 0);
  const failed = res ? count("failures") + count("errors") : failures.length;
  const skipped = count("skipped");
  return {
    format: "unittest",
    passed: total !== null ? Math.max(0, total - failed - skipped) : null,
    failed,
    summary: ran
      ? `${ran[0].replace(/ in [\d.]+s$/, "")}${res ? `, ${res[0]}` : /^OK\b/m.test(out) ? ", OK" : ""}`
      : null,
    failures,
  };
};

// ---- vitest ------------------------------------------------------------------------------------

export const parseVitest: Parser = (out, root) => {
  const summary = /^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(?:(\d+) passed)?.*\((\d+)\)/m.exec(out);
  const headers = [...out.matchAll(/^\s*FAIL\s+(\S+)\s+>\s+(.+)$/gm)];
  if (!summary && headers.length === 0) return null;
  if (!summary && !/⎯|❯/.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*FAIL\s+(\S+)\s+>\s+(.+)$/.exec(lines[i] as string);
    if (!h) continue;
    const msg: string[] = [];
    let file: string | null = relFile(h[1] as string, root);
    let line: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] as string;
      if (/^\s*FAIL\s+\S+\s+>/.test(l) || /^⎯{3,}/.test(l.trim())) break;
      const loc = /^\s*❯\s+(.+?):(\d+):(\d+)/.exec(l);
      if (loc && line === null) {
        file = relFile(loc[1] as string, root);
        line = Number(loc[2]);
        continue;
      }
      if (line === null && l.trim() && msg.length < 12) msg.push(l.trimEnd());
    }
    failures.push({ name: `${h[1]} > ${h[2]}`, file, line, message: clip(msg.join("\n") || "Failed") });
  }
  return {
    format: "vitest",
    passed: summary?.[2] ? Number(summary[2]) : summary ? 0 : null,
    failed: summary?.[1] ? Number(summary[1]) : failures.length,
    summary: summary ? summary[0].trim().replace(/\s+/g, " ") : null,
    failures,
  };
};

// ---- jest --------------------------------------------------------------------------------------

export const parseJest: Parser = (out, root) => {
  const summary = /^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?(\d+) total/m.exec(out);
  if (!summary && !/^\s*● .+ › /m.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*● (.+)$/.exec(lines[i] as string);
    if (!h) continue;
    const title = (h[1] as string).trim();
    if (title === "Console") continue;
    if (title === "Test suite failed to run") {
      const msg = lines.slice(i + 1, i + 12).filter((l) => l.trim());
      failures.push({ name: title, file: null, line: null, message: clip(msg.join("\n") || title) });
      continue;
    }
    const msg: string[] = [];
    let file: string | null = null;
    let line: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] as string;
      if (/^\s*● /.test(l) || /^(PASS|FAIL) /.test(l) || /^Tests?:/.test(l)) break;
      const at = /^\s*at .*?\(?((?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)\)?\s*$/.exec(l);
      if (at) {
        if (file === null && !/node_modules|node:internal/.test(at[1] as string)) {
          file = relFile(at[1] as string, root);
          line = Number(at[2]);
        }
        continue;
      }
      if (/^\s*>?\s*\d+ \|/.test(l) || /^\s+\|/.test(l)) continue;
      if (l.trim() && msg.length < 12) msg.push(l.trim());
    }
    failures.push({ name: title, file, line, message: clip(msg.join("\n") || "Failed") });
  }
  return {
    format: "jest",
    passed: summary ? Number(summary[2] ?? 0) : null,
    failed: summary ? Number(summary[1] ?? 0) : failures.length,
    summary: summary ? summary[0].replace(/\s+/g, " ").trim() : null,
    failures,
  };
};

// ---- bun test ----------------------------------------------------------------------------------

export const parseBun: Parser = (out, root) => {
  const counts = /^\s*(\d+) pass\s*\n\s*(\d+) fail/m.exec(out);
  if (!counts && !/^\(fail\) /m.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^\(pass\) |^\(skip\) |^\S.*\.(test|spec)\.[cm]?[jt]sx?:$/.test(l)) {
      start = i + 1;
      continue;
    }
    const f = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l);
    if (!f) continue;
    const block = lines.slice(start, i);
    const errAt = block.findIndex((b) => /^(error|\w*Error):/.test(b));
    const msg =
      errAt >= 0
        ? block
            .slice(errAt)
            .filter((b) => b.trim() && !/^\s+at /.test(b))
            .slice(0, 12)
        : [];
    let file: string | null = null;
    let line: number | null = null;
    for (const b of block) {
      const at = /^\s*at .*?\(?((?:[A-Za-z]:)?[^\s():]+):(\d+):(\d+)\)?\s*$/.exec(b);
      if (at && !/node_modules/.test(at[1] as string)) {
        file = relFile(at[1] as string, root);
        line = Number(at[2]);
        break;
      }
    }
    failures.push({ name: f[1] as string, file, line, message: clip(msg.join("\n") || "Failed") });
    start = i + 1;
  }
  return {
    format: "bun",
    passed: counts ? Number(counts[1]) : null,
    failed: counts ? Number(counts[2]) : failures.length,
    summary: counts ? `${counts[1]} pass, ${counts[2]} fail` : null,
    failures,
  };
};

// ---- go test -----------------------------------------------------------------------------------

export const parseGo: Parser = (out, root) => {
  if (!/^--- (FAIL|PASS): \S+ \(/m.test(out) && !/^(ok|FAIL)\s+\S+\s+[\d.]+s/m.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  const runStart = new Map<string, number>();
  let passed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    const run = /^=== RUN\s+(\S+)/.exec(l);
    if (run) runStart.set(run[1] as string, i);
    if (/^\s*--- PASS: /.test(l)) passed++;
    const h = /^(\s*)--- FAIL: (\S+) \(/.exec(l);
    if (!h) continue;
    const indent = (h[1] as string).length;
    let detail: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const d = lines[j] as string;
      if (!d.startsWith(" ".repeat(indent + 4)) || /^\s*--- (FAIL|PASS)/.test(d)) break;
      detail.push(d.trim());
    }
    if (detail.length === 0) {
      const s = runStart.get(h[2] as string);
      if (s !== undefined)
        detail = lines
          .slice(s + 1, i)
          .filter((d) => /^\s+\S/.test(d) && !/^\s*(=== |--- )/.test(d))
          .map((d) => d.trim());
    }
    const loc = detail.map((d) => /^([\w./\\-]+\.go):(\d+): ?(.*)$/.exec(d)).find(Boolean);
    failures.push({
      name: h[2] as string,
      file: loc ? relFile(loc[1] as string, root) : null,
      line: loc ? Number(loc[2]) : null,
      message: clip(detail.map((d) => d.replace(/^[\w./\\-]+\.go:\d+: ?/, "")).join("\n") || "Failed"),
    });
  }
  // Parent tests fail when a subtest fails: keep the most specific ones.
  const names = failures.map((f) => f.name);
  const leaves = failures.filter((f) => !names.some((n) => n !== f.name && n.startsWith(`${f.name}/`)));
  const pkgFail = (out.match(/^FAIL\s+\S+\s+[\d.]+s/gm) ?? []).length;
  const pkgOk = (out.match(/^ok\s+\S+/gm) ?? []).length;
  return {
    format: "go",
    passed: passed > 0 ? passed : null,
    failed: leaves.length,
    summary: `${pkgOk} package${pkgOk === 1 ? "" : "s"} ok, ${pkgFail} failed`,
    failures: leaves,
  };
};

// ---- cargo test --------------------------------------------------------------------------------

export const parseCargo: Parser = (out, root) => {
  const results = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (results.length === 0 && !/^---- \S+ stdout ----$/m.test(out)) return null;
  const lines = out.split("\n");
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^---- (\S+) stdout ----$/.exec(lines[i] as string);
    if (!h) continue;
    let file: string | null = null;
    let line: number | null = null;
    const msg: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] as string;
      if (/^---- \S+ stdout ----$/.test(l) || /^(stack backtrace:|note: |failures:$)/.test(l)) break;
      const p = /panicked at (.+?):(\d+):(\d+):?\s*(.*)$/.exec(l);
      if (p) {
        file = relFile(p[1] as string, root);
        line = Number(p[2]);
        if (p[4]) msg.push(p[4] as string);
        continue;
      }
      if (l.trim() && msg.length < 12) msg.push(l.trimEnd());
    }
    failures.push({ name: h[1] as string, file, line, message: clip(msg.join("\n") || "Failed") });
  }
  const passed = results.reduce((s, r) => s + Number(r[1]), 0);
  const failed = results.reduce((s, r) => s + Number(r[2]), 0);
  return {
    format: "cargo",
    passed: results.length ? passed : null,
    failed: results.length ? failed : failures.length,
    summary: results.length ? `${passed} passed; ${failed} failed` : null,
    failures,
  };
};

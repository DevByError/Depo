import path from "node:path";

/**
 * Does a JavaScript or TypeScript file still compile? Checked with Bun's own parser (the engine
 * runs on Bun), so "createApp has already been declared" or a missing "}" is found the moment a
 * change makes it, not minutes later when the tests run. Small models often append a copy of
 * code that is already in the file.
 */

type Loader = "ts" | "tsx" | "js" | "jsx";

const LOADERS: Record<string, Loader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
  // Plain .js files may hold JSX (React projects), and the JSX parser reads plain JS too.
  ".js": "jsx",
  ".mjs": "js",
  ".cjs": "js",
};

export interface CompileProblem {
  message: string;
  line: number;
  lineText: string;
  /** Where the clashing name was first declared, when the parser says. */
  noteLine: number | null;
}

interface Transpiler {
  transformSync(code: string): string;
}
const transpilers = new Map<Loader, Transpiler>();

function transpiler(loader: Loader): Transpiler | null {
  const B = (globalThis as { Bun?: { Transpiler: new (o: { loader: Loader }) => Transpiler } }).Bun;
  if (!B?.Transpiler) return null;
  let t = transpilers.get(loader);
  if (!t) {
    t = new B.Transpiler({ loader });
    transpilers.set(loader, t);
  }
  return t;
}

/** Can Depo check this file? */
export function checkable(rel: string): boolean {
  return !/\.d\.[cm]?ts$/i.test(rel) && path.extname(rel).toLowerCase() in LOADERS;
}

/** Why `text` does not compile as the file `rel`, or null (also when Depo cannot check it). */
export function compileProblem(rel: string, text: string): CompileProblem | null {
  if (!checkable(rel)) return null;
  const t = transpiler(LOADERS[path.extname(rel).toLowerCase()] ?? "ts");
  if (!t) return null;
  try {
    t.transformSync(text);
    return null;
  } catch (err) {
    const e = err as {
      message?: string;
      position?: { line?: number; lineText?: string } | null;
      notes?: { position?: { line?: number } | null }[];
    };
    return {
      message: String(e.message ?? err),
      line: e.position?.line ?? 0,
      lineText: e.position?.lineText ?? "",
      noteLine: e.notes?.[0]?.position?.line ?? null,
    };
  }
}

/** Numbered lines around `line` (1-based), the line itself marked. */
export function codeFrame(text: string, line: number, radius = 3): string {
  const lines = text.split(/\r?\n/);
  if (line < 1 || line > lines.length) return "";
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++)
    out.push(`${n === line ? ">" : " "}${String(n).padStart(width)}│ ${lines[n - 1] ?? ""}`);
  return out.join("\n");
}

/** The compile error in words, with the lines around it. */
export function describeCompileProblem(rel: string, text: string, p: CompileProblem): string {
  const where = p.line ? ` at line ${p.line}` : "";
  const first =
    p.noteLine && /already been declared/i.test(p.message)
      ? ` (it is already declared at line ${p.noteLine}: do not import or declare it a second time)`
      : "";
  const frame = p.line ? codeFrame(text, p.line) : "";
  return `${rel} does not compile${where}: ${p.message}${first}${frame ? `\n${frame}` : ""}`;
}

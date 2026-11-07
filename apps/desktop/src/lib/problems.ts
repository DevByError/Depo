import type { Problem, ProblemCounts, ProblemSeverity } from "@depo/shared";
import { plural } from "./step-summary";

/** Grouping and filtering for the Problems tab. */

export interface ProblemFilters {
  errors: boolean;
  warnings: boolean;
  runtime: boolean;
}

export interface FileGroup {
  /** null for problems that are not about one file. */
  file: string | null;
  problems: Problem[];
  counts: ProblemCounts;
}

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Errors pass with the Errors filter; warnings and notes with the Warnings filter. */
export function severityShown(severity: ProblemSeverity, f: ProblemFilters): boolean {
  return severity === "error" ? f.errors : f.warnings;
}

export function countProblems(problems: Pick<Problem, "severity">[]): ProblemCounts {
  const counts: ProblemCounts = { error: 0, warning: 0, info: 0 };
  for (const p of problems) counts[p.severity]++;
  return counts;
}

/** Problems by file: files with errors first, then the most problems, then by name. */
export function groupByFile(problems: Problem[]): FileGroup[] {
  const map = new Map<string | null, Problem[]>();
  for (const p of problems) {
    const list = map.get(p.file);
    if (list) list.push(p);
    else map.set(p.file, [p]);
  }
  const groups = [...map.entries()].map(([file, list]) => ({
    file,
    problems: [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0)),
    counts: countProblems(list),
  }));
  const worst = (g: FileGroup) => (g.counts.error > 0 ? 0 : g.counts.warning > 0 ? 1 : 2);
  return groups.sort(
    (a, b) =>
      worst(a) - worst(b) ||
      b.counts.error - a.counts.error ||
      b.problems.length - a.problems.length ||
      (a.file ?? "￿").localeCompare(b.file ?? "￿"),
  );
}

/** "2 errors, 1 warning, 3 notes". */
export function countsLabel(c: ProblemCounts): string {
  const parts: string[] = [];
  if (c.error) parts.push(plural(c.error, "error"));
  if (c.warning) parts.push(plural(c.warning, "warning"));
  if (c.info) parts.push(plural(c.info, "note"));
  return parts.join(", ") || "No problems";
}

/** "tsc, ruff and go vet". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function position(p: Pick<Problem, "line" | "column">): string {
  if (p.line === null) return "";
  return p.column === null ? `${p.line}` : `${p.line}:${p.column}`;
}

/** Stable React keys for items that may repeat: the same key gets a counter after the first. */
export function uniqueKeys<T>(items: T[], key: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const k = key(item);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return [n === 0 ? k : `${k}#${n}`, item];
  });
}

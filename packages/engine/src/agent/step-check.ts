import fs from "node:fs";
import path from "node:path";
import { findSchemaFiles } from "../tools/schema-files";
import { createTables, foreignKeyProblems, longIdentifiers } from "../tools/sqlcheck";
import { checkable, compileProblem, describeCompileProblem } from "../tools/syntax";
import type { PlannedStep } from "./plan";
import { appDirs, hasPage, routeIn, sourceCode } from "./request-check";

/**
 * Depo's check of one step of its plan (ADR-0086), in code rather than the model's word: the
 * table is in the schema with the columns the request lists, the route is in the code, the page
 * file exists, the tests were written, and every file the step changed compiles. Returns the
 * problems as sentences for the model; none means the step is done.
 */

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;

export interface StepCheckOptions {
  /** Files changed since the step started (relative, forward slashes). */
  changed: string[];
  /** The model said, after being told nothing changed, that the step was already in the code. */
  acceptUnchanged?: boolean;
}

/** The schema file a table step adds to: the file the request names, else the main schema file. */
export function schemaFileFor(root: string, overview = ""): string | null {
  const named = /([\w./-]*schema[\w.-]*\.sql)\b/i.exec(overview)?.[1];
  if (named && fs.existsSync(path.join(root, named))) return named.replace(/\\/g, "/");
  return findSchemaFiles(root)[0] ?? null;
}

function read(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** Compile problems in the changed files, with the lines around each. */
export function compileProblems(root: string, changed: string[]): string[] {
  const out: string[] = [];
  for (const rel of changed) {
    if (!checkable(rel)) continue;
    const text = read(root, rel);
    if (text === null) continue;
    const p = compileProblem(rel, text);
    if (p) out.push(describeCompileProblem(rel, text, p));
  }
  return out;
}

function tableProblems(step: PlannedStep, root: string, overview: string): string[] {
  const t = step.table;
  if (!t) return [];
  const files = findSchemaFiles(root);
  const preferred = schemaFileFor(root, overview);
  const ordered = preferred ? [preferred, ...files.filter((f) => f !== preferred)] : files;
  for (const rel of ordered) {
    const sql = read(root, rel);
    if (sql === null) continue;
    const found = createTables(sql).find((c) => c.name === t.name);
    if (!found) continue;
    const problems: string[] = [];
    if (!found.complete)
      problems.push(`The CREATE TABLE for ${t.name} in ${rel} is not finished (it has no ";" at its end).`);
    const missing = t.columns.filter((c) => !new RegExp(`(^|[\\s(,\`"])${c}[\`"]?\\s`, "i").test(found.text));
    if (missing.length)
      problems.push(
        `The ${t.name} table in ${rel} is missing the column${missing.length === 1 ? "" : "s"} ${missing.join(", ")} (the request lists ${missing.length === 1 ? "it" : "them"}). Add ${missing.length === 1 ? "it" : "them"} to its CREATE TABLE with an edit.`,
      );
    const mine = (p: string) => new RegExp(`\\b${t.name}\\b`, "i").test(p);
    problems.push(...foreignKeyProblems(sql).filter((p) => p.startsWith(`${t.name}.`)));
    problems.push(...longIdentifiers(found.text).filter(mine));
    return problems;
  }
  const where = preferred ?? "the schema file";
  return [
    `There is no CREATE TABLE for ${t.name} in ${where} yet. Append it at the end of ${where} with append_file: CREATE TABLE IF NOT EXISTS ${t.name} (...) with the columns ${t.columns.join(", ")}.`,
  ];
}

/** What is still wrong with the step; an empty list means it is done. */
export function checkStep(
  step: PlannedStep,
  root: string,
  o: StepCheckOptions & { overview?: string },
): string[] {
  const problems: string[] = [];
  switch (step.kind) {
    case "table":
      problems.push(...tableProblems(step, root, o.overview ?? ""));
      break;
    case "route":
      if (step.route && !routeIn(sourceCode(root), step.route.path))
        problems.push(
          `The route ${step.route.method} ${step.route.path} is not in the code yet. Add it where the other routes are, with its handler.`,
        );
      break;
    case "page":
      if (step.page) {
        const dirs = appDirs(root);
        if (dirs.length && !hasPage(dirs, step.page)) {
          const rel = path.relative(root, dirs[0] ?? root).replace(/\\/g, "/");
          problems.push(
            `The page ${step.page} does not exist yet: write ${rel}${step.page === "/" ? "" : step.page}/page.tsx (its default export is the page component).`,
          );
        }
      }
      break;
    case "tests":
      if (!o.changed.some((f) => TEST_FILE.test(f)))
        problems.push(
          "No test file was written in this step. Write the tests in a test file next to the existing tests (for example be/src/<area>.test.ts for bun test).",
        );
      break;
    case "build":
    case "fix":
      if (!o.changed.length && !o.acceptUnchanged)
        problems.push(
          step.kind === "fix"
            ? "Nothing changed, so the problem is still there. Change the file the error points to."
            : "Nothing changed in this step.",
        );
      break;
    case "check":
      break;
  }
  problems.push(...compileProblems(root, o.changed));
  return problems;
}

/** Can Depo tell whether this step is done before the model touches it (a table, route or page)? */
export function checkableBefore(step: PlannedStep): boolean {
  return step.kind === "table" || step.kind === "route" || step.kind === "page";
}

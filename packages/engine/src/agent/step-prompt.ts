import fs from "node:fs";
import path from "node:path";
import { indexFor, snippetsText } from "./codeindex-lite";
import type { PlannedStep, RequestPlan } from "./plan";
import { appDirs } from "./request-check";
import { relevantParts } from "./retrieve";
import { schemaFileFor } from "./step-check";

/**
 * What the model reads for one step of Depo's plan (ADR-0086): the step and its part of the
 * request, the project's rules, what is done and what comes later, and the files the step works
 * on, already read. A small model gets a short, concrete job instead of the whole request.
 */

const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  ".data",
  "dist",
  "build",
  "out",
  ".depo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|cs|sql|css)$/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Source files of the copy, relative with forward slashes (up to a limit). */
export function codeFiles(root: string, limit = 3000): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(r, depth + 1);
      } else if (CODE.test(e.name)) out.push(r);
    }
  };
  walk("", 0);
  return out.sort();
}

function read(root: string, rel: string, max = 200_000): string | null {
  try {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > max) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** The file that holds the API's route table (the most "/api/" routes), or null. */
export function routeFile(root: string, files = codeFiles(root)): string | null {
  let best: { rel: string; n: number } | null = null;
  for (const rel of files) {
    if (
      !/\.(ts|js|mjs|py|go|rb|php)$/i.test(rel) ||
      /\.(test|spec)\./i.test(rel) ||
      /(^|\/)app\/api\//.test(rel)
    )
      continue;
    const text = read(root, rel, 120_000);
    if (!text) continue;
    const n = count(
      text,
      /["'`](?:GET|POST|PUT|PATCH|DELETE)\s+\/api\/|\.(?:get|post|put|patch|delete)\(\s*["'`]\/api\//gi,
    );
    if (n > 0 && (!best || n > best.n)) best = { rel, n };
  }
  return best?.rel ?? null;
}

/** The Store interface and the stores that implement it (the starting project's data layer). */
export function storeFiles(root: string, files = codeFiles(root)): string[] {
  const found: { rel: string; rank: number }[] = [];
  for (const rel of files) {
    if (!/\.(ts|js)$/i.test(rel) || /\.(test|spec)\./i.test(rel)) continue;
    const text = read(root, rel, 120_000);
    if (!text) continue;
    if (/\binterface\s+Store\b|\btype\s+Store\s*=/.test(text)) found.push({ rel, rank: 0 });
    else if (/\bimplements\s+Store\b|:\s*Store\s*=\s*\{|\):\s*Store\b/.test(text))
      found.push({ rel, rank: 1 });
  }
  return found.sort((a, b) => a.rank - b.rank || (a.rel < b.rel ? -1 : 1)).map((f) => f.rel);
}

/** Paths the text names that exist in the copy ("be/src/app.ts", "fe/app/globals.css"). */
export function namedFiles(root: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s(`'"])((?:[\w.@-]+\/)+[\w.@[\]-]+\.\w{1,5})\b/g)) {
    const rel = (m[1] ?? "").replace(/^\.\//, "");
    if (out.includes(rel)) continue;
    try {
      if (fs.statSync(path.join(root, rel)).isFile()) out.push(rel);
    } catch {
      // not a file of the copy
    }
  }
  return out;
}

/** The files a step works on, most important first. */
export function filesForStep(step: PlannedStep, plan: RequestPlan, root: string): string[] {
  const files = codeFiles(root);
  const out: string[] = [];
  const add = (...rels: (string | null | undefined)[]) => {
    for (const r of rels) if (r && !out.includes(r)) out.push(r);
  };
  const text = `${step.spec}\n${step.notes}`;
  switch (step.kind) {
    case "table":
      add(schemaFileFor(root, plan.overview));
      break;
    case "route":
      add(routeFile(root, files), ...storeFiles(root, files).slice(0, 3));
      break;
    case "page": {
      const dir = appDirs(root)[0];
      if (dir) {
        const rel = path.relative(root, dir).replace(/\\/g, "/");
        add(
          ...["page.tsx", "page.jsx", "layout.tsx", "layout.jsx"]
            .map((f) => `${rel}/${f}`)
            .filter((f) => files.includes(f)),
        );
      }
      break;
    }
    case "tests": {
      const tests = files.filter((f) => /\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$/.test(f));
      add(tests[0]);
      break;
    }
    case "fix":
      break;
    default:
      if (/\bstore\b/i.test(text)) add(...storeFiles(root, files).slice(0, 3));
      if (/\bseed\b/i.test(text)) add(files.find((f) => /(^|\/)seed\.[jt]s$/.test(f)));
      if (/\b(header|layout|every page|all pages)\b/i.test(text)) {
        const dir = appDirs(root)[0];
        if (dir) {
          const rel = path.relative(root, dir).replace(/\\/g, "/");
          add(...["layout.tsx", "layout.jsx"].map((f) => `${rel}/${f}`).filter((f) => files.includes(f)));
        }
      }
  }
  add(...namedFiles(root, text));
  return out;
}

function fence(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return (
    { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", sql: "sql", css: "css", py: "python", json: "json" }[ext] ??
    ""
  );
}

/** The files shown in the step prompt (whole, or the end of a long schema), within `budget` characters. */
export function shownFiles(
  root: string,
  rels: string[],
  budget: number,
  /** The step's words: a file too big to show whole is cut to the parts that match them. */
  query = "",
): { text: string; shown: string[] } {
  const parts: string[] = [];
  const shown: string[] = [];
  let left = budget;
  for (const rel of rels) {
    const body = read(root, rel);
    if (body === null) continue;
    let text = body;
    let note = "";
    if (text.length > left) {
      // A long schema: its end (where new tables go) is what matters.
      if (/\.sql$/i.test(rel) && left > 1500) {
        text = text.slice(text.length - (left - 200));
        text = text.slice(text.indexOf("\n") + 1);
        note = " (its last lines; read_file for the start)";
      } else {
        // Too big to show whole: the parts of it that match the step (retrieval, see retrieve.ts).
        const part = left > 1500 && query ? relevantParts(body, query, left - 300) : null;
        if (!part) continue;
        text = part.text;
        note = ` (the parts that match this step, of ${part.totalLines} lines; line numbers are in the markers; read_file for the rest)`;
      }
    }
    parts.push(`${rel}${note}\n\`\`\`${fence(rel)}\n${text.replace(/\s+$/, "")}\n\`\`\``);
    shown.push(rel);
    left -= text.length + rel.length + 20;
    if (left < 800) break;
  }
  return { text: parts.join("\n\n"), shown };
}

function howTo(step: PlannedStep, plan: RequestPlan, root: string, blocks: boolean, files: string[]): string {
  const edit = blocks ? "a SEARCH/REPLACE block" : "edit_file";
  switch (step.kind) {
    case "table": {
      const schema = schemaFileFor(root, plan.overview) ?? "the schema file";
      const t = step.table;
      return [
        `How: add only the ${t?.name} table. Append one CREATE TABLE IF NOT EXISTS ${t?.name} (...) statement to the end of ${schema} (with append_file${blocks ? ", or a block with nothing between SEARCH and =======" : ""}).`,
        `Its columns: ${t?.columns.join(", ")}. Give each the type the request asks for; a column that points to another table's id gets exactly that id's type (see the tables in the file below).`,
        "Add no other table and no ALTER statement. Names stay short (MySQL allows 64 characters).",
      ].join("\n");
    }
    case "route": {
      const routes = routeFile(root);
      return `How: add the route ${step.route?.method} ${step.route?.path} where the other routes are${routes ? ` (${routes})` : ""}, the same way they are written, with its handler in the folder of its area. If it needs data, add the method to the Store interface and to every store. Do not create a new server or a new route file.`;
    }
    case "page": {
      const dir = appDirs(root)[0];
      const rel = dir ? path.relative(root, dir).replace(/\\/g, "/") : "app";
      return `How: write the page as ${rel}${step.page === "/" ? "" : step.page}/page.tsx (its default export is the page component). Use the project's existing components, styles and theme tokens.`;
    }
    case "tests":
      return `How: write these tests in a test file next to the existing tests${files[0] ? ` (like ${files[0]})` : ""}. If the code they test does not exist yet, write it too. No network in tests.`;
    case "fix":
      return `How: read the error and the lines it points to, fix the cause with ${edit}, and change nothing else.`;
    default:
      return "How: build it in the files where it belongs, the way the project already does things.";
  }
}

export interface StepPromptInput {
  step: PlannedStep;
  plan: RequestPlan;
  root: string;
  /** Titles of the steps done before this one. */
  done: string[];
  /** Titles of the steps that come after it. */
  later: string[];
  /** Position and count, for "Step 3 of 14". */
  index: number;
  total: number;
  /** What earlier tries of this step ran into. */
  earlier: string[];
  /** The model writes file blocks (small models). */
  blocks: boolean;
  /** Characters of file content the prompt may hold. */
  budget: number;
  /** The owner's design references (pictures and links), as the brief every agent reads. */
  design?: string;
  /** False leaves out the related-code section (tests that check the exact prompt). */
  related?: boolean;
}

/** What a finished step looks like, so the model tests for it instead of claiming it. */
const KNOWN_BY: Partial<Record<PlannedStep["kind"], string>> = {
  table:
    "the CREATE TABLE is in the schema file and its foreign keys have the same type as the keys they point to.",
  route: "a request to the route (http_check, or a test) answers with the right status and body.",
  page: "check_page opens the page without errors and shows what the request describes.",
  tests: "the tests run and pass (run them once with run_command and read the first failure).",
};

/** Steps that make something the owner sees, so the design references apply to them. */
const LOOKS = new Set(["page", "build", "fix"]);

/** The step prompt, and the files it shows (they count as read). */
export function stepPrompt(o: StepPromptInput): { text: string; shown: string[] } {
  const { step, plan } = o;
  const files = filesForStep(step, plan, o.root);
  const shown = shownFiles(o.root, files, o.budget, `${step.title} ${step.spec} ${step.notes}`);
  const lines = [
    `Depo split the owner's request into ${o.total} steps and checks each one when it is done. Do step ${o.index} now, and only this step.`,
    "",
    `Step ${o.index} of ${o.total}: ${step.title}`,
    "What it needs (from the request):",
    clip(step.spec, 3000),
  ];
  if (step.notes.trim()) lines.push("", "Notes for this part of the request:", clip(step.notes, 1500));
  if (plan.overview.trim())
    lines.push("", "About the whole project (from the request):", clip(plan.overview, 1800));
  const design = o.design?.trim() ?? "";
  if (design && LOOKS.has(step.kind))
    lines.push(
      "",
      "The owner's design references (make what this step builds look like this):",
      clip(design, 2500),
    );
  lines.push(
    "",
    `Done before this step: ${o.done.length ? o.done.join("; ") : "nothing yet"}.`,
    ...(o.later.length
      ? [`Later steps (not now): ${o.later.slice(0, 6).join("; ")}${o.later.length > 6 ? "; …" : ""}.`]
      : []),
    "",
    howTo(step, plan, o.root, o.blocks, files),
  );
  if (shown.text)
    lines.push(
      "",
      "These files are already read for you; this is their exact text now (copy lines from here for SEARCH, without changing them):",
      shown.text,
    );
  // Related code from the whole project (retrieval): how the project already does the same kind of
  // thing, so the new code matches its names and style instead of inventing its own.
  if (o.related !== false) {
    const found = indexFor(o.root).search(
      `${step.title} ${step.spec} ${step.notes} ${o.earlier.map((e) => e.split("\n")[0]).join(" ")}`,
      { k: 4, budget: Math.min(2400, Math.round(o.budget * 0.25)), exclude: new Set(shown.shown) },
    );
    if (found.length)
      lines.push(
        "",
        "Related code already in this project (match its names and style; it is not a list of things to change):",
        snippetsText(found),
      );
  }
  if (o.earlier.length)
    lines.push(
      "",
      `Earlier tries of this step did not work: ${o.earlier.map((e) => clip(e.split("\n")[0] ?? e, 300)).join(" / ")}. The files are as shown above now: do it differently.`,
    );
  const proof = KNOWN_BY[step.kind];
  if (proof) lines.push("", `You know the step works when: ${proof}`);
  lines.push("", "When the step is done, stop and say in one line what you did. Depo then checks it.");
  return { text: lines.join("\n"), shown: shown.shown };
}

import type { PlanStepKind } from "@depo/shared";

/**
 * Depo's step plan for a request (ADR-0086): the request's own sections and bullets, turned into
 * small steps a small model can do one at a time. Built from the text alone (no model), so it is
 * instant and the same every time; the owner sees it before any model starts.
 *
 * - The text before the first heading is the overview: what the whole thing is and the project's
 *   rules. Every step sees it.
 * - In a section, bullets that name a route ("GET /api/x"), a page ("/skills/[id] : …") or, under
 *   a database heading, a table ("favorites: user_id, skill_id, …") become one step each; the
 *   section's other sentences are notes for those steps.
 * - A Tests section becomes one step per kind of test it lists.
 * - Any other section is one step. "Done means: …" goes to the final check.
 * - The last step is always Depo's own check: tests, migrations, the app and its pages.
 */

export interface PlannedStep {
  id: string;
  title: string;
  kind: PlanStepKind;
  /** What this step builds, in the request's words. */
  spec: string;
  /** Other sentences of the step's section that apply to it. */
  notes: string;
  /** The section heading the step comes from ("" for the request's top level). */
  section: string;
  table?: { name: string; columns: string[] };
  route?: { method: string; path: string };
  page?: string;
}

export interface RequestPlan {
  /** The request's opening text (what is built, the project's structure and rules). */
  overview: string;
  /** "Done means: …" from the request, for the final check. */
  doneMeans: string;
  /** The steps, the final check last. */
  steps: PlannedStep[];
}

/** More steps than this are folded into one last build step. */
export const MAX_PLAN_STEPS = 40;

interface Block {
  kind: "bullet" | "para";
  text: string;
}

interface Section {
  heading: string;
  blocks: Block[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s{0,3}\*\*([^*]{2,80})\*\*:?\s*$/;
const BULLET = /^\s*(?:[-*•+]|\d{1,2}[.)])\s+(.*)$/;
const DONE = /^(?:done means|done when|definition of done|it is done when|acceptance(?: criteria)?)\b[:\s]/i;
const ROUTE_ITEM = /^`?(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s?`'"),;]*)/;
const PAGE_ITEM = /^`?(\/[\w\-[\]/.]*)`?\s+[:–—-]\s/;
const TABLE_ITEM = /^`?([A-Za-z_][\w]{0,63})`?\s*(?:\([^)]{0,60}\))?\s*:\s*(.+)$/s;
const DATA_SECTION = /\b(database|tables?|schema|data ?model|models?|migrations?)\b/i;
const TEST_SECTION = /\btests?\b|\btesting\b/i;
const VERB =
  /^(add|build|create|write|make|implement|put|set up|seed|update|change|fix|use|show|render|keep|give|store|save|move|rename|remove|delete|replace|wire|connect|expose)\b/i;
const NOT_COLUMN = /^(primary|unique|foreign|fulltext|index|key|both|constraint|check|on|and|with)$/i;

/** Splits text on commas and semicolons that are not inside brackets or quotes. */
function topLevelParts(text: string, seps = ",;"): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && seps.includes(ch)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The text up to its first sentence end that is not inside brackets ("…, updated_at. Unique key …"). */
function firstClause(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ";" || (ch === "." && /^\s+[A-Z]|^\s*$/.test(text.slice(i + 1, i + 4)))))
      return text.slice(0, i);
  }
  return text;
}

/** The column names a table bullet lists ("id, source ('demo' or 'github'), repo (…), …"). */
export function columnsOf(text: string): string[] {
  const cols: string[] = [];
  for (const part of topLevelParts(firstClause(text), ",")) {
    const m = /^`?([A-Za-z_][\w]*)`?/.exec(part.replace(/^and\s+/i, ""));
    const n = m?.[1] ?? "";
    if (!n || NOT_COLUMN.test(n) || n.length > 64) continue;
    if (!cols.includes(n.toLowerCase())) cols.push(n.toLowerCase());
  }
  return cols;
}

function sections(request: string): { overview: Block[]; sections: Section[]; doneMeans: string } {
  const lines = request.replace(/\r\n?/g, "\n").split("\n");
  const overview: Block[] = [];
  const out: Section[] = [];
  let doneMeans = "";
  let current: Section | null = null;
  let block: Block | null = null;
  let inCode = false;
  const target = () => (current ? current.blocks : overview);
  const close = () => {
    if (!block) return;
    const text = block.text.trim();
    if (text) {
      if (block.kind === "para" && DONE.test(text)) doneMeans = text.replace(DONE, "").trim();
      else target().push({ kind: block.kind, text });
    }
    block = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (!inCode) {
      const h = HEADING.exec(line) ?? BOLD_HEADING.exec(line);
      if (h) {
        close();
        current = { heading: (h[1] ?? "").trim(), blocks: [] };
        out.push(current);
        continue;
      }
      if (!line.trim()) {
        close();
        continue;
      }
      const b = BULLET.exec(line);
      if (b && !/^\s{4,}/.test(line)) {
        close();
        block = { kind: "bullet", text: b[1] ?? "" };
        continue;
      }
    }
    // A bullet goes on over indented lines, or lines that continue its sentence; a line after a
    // finished sentence starts a paragraph of its own ("…created_at.\nAdd the methods you need…").
    const cur = block as Block | null;
    const continues =
      !!cur && (cur.kind === "para" || /^\s{2,}/.test(line) || !/[.!?:)]$/.test(cur.text.trimEnd()));
    if (cur && continues) cur.text += `\n${line.trim()}`;
    else {
      close();
      block = { kind: "para", text: line.trim() };
    }
  }
  close();
  return { overview, sections: out, doneMeans };
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** "Demo skills (bun run db:seed)" → "Build the demo skills (bun run db:seed)". */
function sectionTitle(heading: string): string {
  const h = heading.replace(/[:.]+$/, "").trim();
  if (VERB.test(h)) return clip(h, 90);
  const lower = /^[A-Z][a-z]/.test(h) ? h[0]?.toLowerCase() + h.slice(1) : h;
  return clip(`Build the ${lower}`, 90);
}

/** A sentence that tells what to do ("Add the methods you need to the Store interface …"). */
function sentenceTitle(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return clip(first.replace(/[.!?]+$/, ""), 90);
}

/** Splits a Tests paragraph into the kinds of test it lists ("A (x, y), B, and C"). */
function testParts(text: string): string[] {
  const body = text.replace(/^[^:]{0,60}:\s*/, "");
  const parts = topLevelParts(firstClause(body) || body, ",;")
    .map((p) =>
      p
        .replace(/^(and|or)\s+/i, "")
        .replace(/(?<!\.)\.$/, "")
        .trim(),
    )
    .filter((p) => p.length >= 3);
  return parts.length >= 2 ? parts : [];
}

function notesOf(blocks: Block[], except: Set<Block>): string {
  return blocks
    .filter((b) => !except.has(b))
    .map((b) => (b.kind === "bullet" ? `- ${b.text}` : b.text))
    .join("\n");
}

function routesIn(text: string): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s?`'"),;]*)/g)) {
    const p = (m[2] ?? "").replace(/[.:]+$/, "");
    if (p.length < 2) continue;
    seen.set(`${m[1]} ${p}`, { method: m[1] ?? "GET", path: p });
  }
  return [...seen.values()];
}

type Draft = Omit<PlannedStep, "id">;

function planSection(sec: Section): Draft[] {
  const { heading, blocks } = sec;
  const all = blocks.map((b) => (b.kind === "bullet" ? `- ${b.text}` : b.text)).join("\n");
  const dataSection = DATA_SECTION.test(heading);
  const items: { block: Block; draft: Draft }[] = [];
  for (const b of blocks) {
    if (b.kind !== "bullet") continue;
    const r = ROUTE_ITEM.exec(b.text);
    if (r) {
      const p = (r[2] ?? "").replace(/[.:]+$/, "");
      items.push({
        block: b,
        draft: {
          title: `Build ${r[1]} ${p}`,
          kind: "route",
          spec: b.text,
          notes: "",
          section: heading,
          route: { method: r[1] ?? "GET", path: p },
        },
      });
      continue;
    }
    const pg = PAGE_ITEM.exec(b.text);
    if (pg && !/^\/api(\/|$)/.test(pg[1] ?? "")) {
      const p = (pg[1] ?? "/").length > 1 ? (pg[1] ?? "").replace(/\/+$/, "") : "/";
      items.push({
        block: b,
        draft: {
          title: `Build the page ${p}`,
          kind: "page",
          spec: b.text,
          notes: "",
          section: heading,
          page: p,
        },
      });
      continue;
    }
    if (dataSection) {
      const t = TABLE_ITEM.exec(b.text);
      const cols = t ? columnsOf(t[2] ?? "") : [];
      if (t && cols.length >= 2) {
        const name = (t[1] ?? "").toLowerCase();
        items.push({
          block: b,
          draft: {
            title: `Add the ${name} table`,
            kind: "table",
            spec: b.text,
            notes: "",
            section: heading,
            table: { name, columns: cols },
          },
        });
      }
    }
  }

  if (items.length) {
    const used = new Set(items.map((i) => i.block));
    const firstItem = blocks.indexOf(items[0]?.block as Block);
    const lastItem = blocks.indexOf(items.at(-1)?.block as Block);
    const before: Draft[] = [];
    const after: Draft[] = [];
    // A page section's opening paragraph describes what every page shares (a header, a layout).
    const pages = items.some((i) => i.draft.kind === "page");
    blocks.forEach((b, i) => {
      if (used.has(b) || b.kind !== "para") return;
      if (pages && i < firstItem && b.text.length >= 60) {
        used.add(b);
        before.push({
          title: /every page|all pages|each page|layout|header|navigation|nav bar/i.test(b.text)
            ? "Build what every page shares"
            : sentenceTitle(b.text),
          kind: "build",
          spec: b.text,
          notes: "",
          section: heading,
        });
      } else if (i > lastItem && VERB.test(b.text)) {
        used.add(b);
        after.push({
          title: sentenceTitle(b.text),
          kind: "build",
          spec: b.text,
          notes: "",
          section: heading,
        });
      }
    });
    const notes = notesOf(blocks, used);
    return [...before, ...items.map((i) => i.draft), ...after].map((d) => ({ ...d, notes }));
  }

  if (TEST_SECTION.test(heading)) {
    const bullets = blocks.filter((b) => b.kind === "bullet");
    const paras = blocks.filter((b) => b.kind === "para");
    const kinds = bullets.length >= 2 ? bullets.map((b) => b.text) : testParts(paras[0]?.text ?? "");
    if (kinds.length) {
      const used = new Set(bullets.length >= 2 ? bullets : paras.slice(0, 1));
      const notes = [`The tests the request asks for: ${clip(all, 600)}`, notesOf(blocks, used)]
        .filter(Boolean)
        .join("\n");
      return kinds.map((k) => ({
        title: clip(`Write tests: ${k}`, 90),
        kind: "tests" as const,
        spec: k,
        notes,
        section: heading,
      }));
    }
    return [{ title: "Write the tests", kind: "tests", spec: all, notes: "", section: heading }];
  }

  const routes = routesIn(all);
  if (routes.length)
    return routes.map((r) => ({
      title: `Build ${r.method} ${r.path}`,
      kind: "route" as const,
      spec: all,
      notes: "",
      section: heading,
      route: r,
    }));

  if (!all.trim()) return [];
  return [{ title: sectionTitle(heading), kind: "build", spec: all, notes: "", section: heading }];
}

/** Depo's plan for a request: build steps from its text, then the final check. */
export function buildPlan(request: string): RequestPlan {
  const parsed = sections(request);
  const overviewText = parsed.overview
    .map((b) => (b.kind === "bullet" ? `- ${b.text}` : b.text))
    .join("\n\n");
  let drafts: Draft[] = [];
  let overview = overviewText;
  if (parsed.sections.length) {
    for (const sec of parsed.sections) drafts.push(...planSection(sec));
  } else {
    // No headings: top-level items (routes, pages, numbered steps), else one step for all of it.
    const top = planSection({ heading: "", blocks: parsed.overview });
    const numbered = /^\s*\d{1,2}[.)]\s/m.test(request)
      ? parsed.overview.filter((b) => b.kind === "bullet")
      : [];
    if (top.length > 1 || top.some((d) => d.kind !== "build")) {
      drafts = top;
    } else if (numbered.length >= 2) {
      const notes = notesOf(parsed.overview, new Set(numbered));
      drafts = numbered.map((b) => ({
        title: sentenceTitle(b.text),
        kind: "build" as const,
        spec: b.text,
        notes,
        section: "",
      }));
    } else {
      const first = request.trim().split(/\n/)[0] ?? request;
      drafts = [{ title: sentenceTitle(first), kind: "build", spec: request.trim(), notes: "", section: "" }];
      overview = "";
    }
  }
  if (!drafts.length)
    drafts = [
      { title: sentenceTitle(request.trim()), kind: "build", spec: request.trim(), notes: "", section: "" },
    ];
  if (drafts.length > MAX_PLAN_STEPS - 1) {
    const rest = drafts.slice(MAX_PLAN_STEPS - 2);
    drafts = [
      ...drafts.slice(0, MAX_PLAN_STEPS - 2),
      {
        title: `Build the rest of the request (${rest.length} parts)`,
        kind: "build",
        spec: rest.map((d) => `- ${d.title}: ${d.spec}`).join("\n"),
        notes: "",
        section: "",
      },
    ];
  }
  drafts.push({
    title: "Run the app and check it",
    kind: "check",
    spec: parsed.doneMeans || "The tests pass and the app starts and works.",
    notes: "",
    section: "",
  });
  return {
    overview,
    doneMeans: parsed.doneMeans,
    steps: drafts.map((d, i) => ({ ...d, id: `s${i + 1}` })),
  };
}

/** A follow-up that only says to go on ("go on", "continue", "fix it"): the last plan continues. */
export function isGoOn(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  return /^(?:(?:ok|okay|yes|please)[,!.\s]+)?(?:please\s+)?(?:go on|continue|keep going|carry on|resume|proceed|go ahead|do the rest|finish(?: it| the rest| the work)?|fix(?: it| this| that| them| the (?:errors?|problems?|rest))?|try again|again|retry)\b(?:\s+please)?[\s.!]*$/i.test(
    t,
  );
}

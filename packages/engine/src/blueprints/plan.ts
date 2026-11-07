import type { WorkMode } from "@depo/shared";
import { isNewWork } from "../playbooks";
import { findBlueprint, isBlankProject } from "./index";
import type { Blueprint } from "./types";

/**
 * Blueprints in plans: when the owner asks for a new system and the project is empty, the first
 * build step starts from the closest blueprint and every other step extends it. Never when the
 * project already has code, and never when the request names a stack the blueprint does not use.
 */

/** The id of the plan step that starts from a blueprint. */
export const BLUEPRINT_STEP = "blueprint";

/** Who runs the blueprint step in each team mode (an agent that has use_blueprint). */
const OWNER: Partial<Record<WorkMode, string>> = {
  full: "integration",
  backend: "backend",
  frontend: "frontend",
  ai: "backend",
};

/** Work the blueprints do not fit: other kinds of programs. */
const NOT_WEB =
  /\b(cli|command[- ]line|terminal app|library|sdk|npm package|pip package|mobile|ios|android|react native|flutter|expo|desktop app|electron|tauri|game|unity|godot|browser extension|chrome extension|vs ?code extension|plugin|bot|scraper|crawler|notebook|jupyter|spreadsheet|embedded|firmware|arduino|smart contract|blockchain)\b/i;
/** Server stacks other than FastAPI. */
const OTHER_SERVER =
  /\b(node(?:\.?js)?|bun|express|nest\.?js|fastify|koa|hono|deno|django|flask|rails|ruby|laravel|php|spring|java|kotlin|dotnet|asp\.net|golang|go api|rust|actix|axum|elixir|phoenix|supabase|firebase)\b|(?:^|[\s(,])(?:\.net|c#)(?=$|[\s),.])/i;
/** Web stacks other than React with Vite. */
const OTHER_WEB =
  /\b(next\.?js|nuxt|remix|gatsby|astro|vue|svelte|sveltekit|angular|solid\.?js|qwik|htmx|jquery|wordpress|blazor)\b/i;
/** Hints that the work needs a server (accounts, data that is kept, an API). */
const SERVER =
  /\b(api|apis|backend|back-end|server|endpoints?|database|db|users?|accounts?|log ?in|sign[ -]?(?:in|up)|admins?|roles?|auth\w*)\b/i;
/** Small pages that need no project around them. */
const SMALL =
  /\b(landing page|static (?:site|page)|html (?:page|file)|one[- ]page|single[- ]page html|mock-?up|wireframe|prototype)\b/i;
const WEB =
  /\b(ui|ux|pages?|screens?|dashboards?|frontend|front-end|web ?app|website|site|portal|forms?|app|react|vite|spa)\b/i;

/** Next.js named as the web stack ("next" alone is a common word, so it needs company). */
const NEXT =
  /\bnext\.?js\b|\b(?:use|using|with|in)\s+next\b|\bnext\s+(?:for|as|on)\s+(?:the\s+)?(?:front|web|ui|client|pages)/i;
/** A Bun or TypeScript server. */
const BUN_SERVER =
  /\bbun\b|\b(?:type ?script|ts)\b.{0,40}\b(?:back[ -]?end|server|api)\b|\b(?:back[ -]?end|server|api)\b.{0,40}\b(?:type ?script|ts)\b/i;
/** Server stacks that are not Bun, and databases or data layers other than MySQL / MariaDB. */
const NOT_BUN_MYSQL =
  /\b(express|nest\.?js|fastify|koa|hono|deno|django|flask|fastapi|python|rails|ruby|laravel|php|spring|java|kotlin|dotnet|asp\.net|golang|go api|rust|actix|axum|elixir|phoenix|postgres\w*|psql|mongo\w*|sqlite|redis|dynamo\w*|cassandra|mssql|sql server|oracle|supabase|firebase|prisma|drizzle|typeorm|sequelize)\b/i;

/** A Next.js front end with a Bun / TypeScript back end (MySQL or no database named). */
export function wantsNextBun(text: string): boolean {
  return NEXT.test(text) && BUN_SERVER.test(text) && !NOT_BUN_MYSQL.test(text);
}

/** The blueprint that fits this kind of work, or null when none does (before the folder check). */
export function blueprintFor(mode: WorkMode, text: string): Blueprint | null {
  if (NOT_WEB.test(text)) return null;
  if ((mode === "single" || mode === "full") && wantsNextBun(text))
    return findBlueprint("next-bun-mysql") ?? null;
  const otherServer = OTHER_SERVER.test(text);
  const otherWeb = OTHER_WEB.test(text);
  const pick = (id: string) => findBlueprint(id) ?? null;
  switch (mode) {
    case "full":
      return otherServer || otherWeb ? null : pick("fullstack");
    case "backend":
    case "ai":
      return otherServer ? null : pick("fastapi-service");
    case "frontend":
      return otherWeb || SMALL.test(text) ? null : pick("react-web-app");
    case "single": {
      if (SMALL.test(text)) return null;
      const server = SERVER.test(text) && !otherServer;
      const web = WEB.test(text) && !otherWeb;
      if (server && web) return pick("fullstack");
      if (otherServer || otherWeb) return null;
      if (server) return pick("fastapi-service");
      if (web) return pick("react-web-app");
      return null;
    }
    default:
      return null;
  }
}

/**
 * The blueprint to start from: new work, in an empty project, of a kind a blueprint fits.
 * `root` is the task's private copy.
 */
export function pickBlueprint(mode: WorkMode, text: string, root: string): Blueprint | null {
  if (!isNewWork(text, mode) || !isBlankProject(root)) return null;
  return blueprintFor(mode, text);
}

export function blueprintOwner(mode: WorkMode): string {
  return OWNER[mode] ?? "backend";
}

/** One paragraph for the Manager's planning prompt. */
export function blueprintPlanGuide(bp: Blueprint, owner: string): string {
  return [
    `This project is empty, so the first build task starts from Depo's ${bp.title} blueprint: id "${BLUEPRINT_STEP}", owner ${owner}, criteria "use_blueprint ${bp.id}" and its tests pass.`,
    `It gives: ${bp.summary} Every other build task extends it (depends on "${BLUEPRINT_STEP}") instead of starting from a blank page. Name the blueprint in the summary.`,
  ].join(" ");
}

export function isBlueprintStep(node: { id: string; title: string }): boolean {
  return node.id === BLUEPRINT_STEP || /\bblueprint\b/i.test(node.title);
}

/** Owners whose tasks change code, so they must run after the blueprint is in place. */
const WRITERS = new Set([
  "database",
  "backend",
  "frontend",
  "integration",
  "ai-integration",
  "testing",
  "enhancement",
  "devops-docs",
]);

function blueprintCriteria(bp: Blueprint): string[] {
  return [
    `use_blueprint ${bp.id} wrote the starting project`,
    `its tests pass as written: ${bp.testCommand}`,
  ];
}

/** Every id that `id` depends on, directly or through others. */
function ancestors<T extends { id: string; deps?: string[] }>(nodes: T[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.deps ?? [])];
  while (stack.length) {
    const d = stack.pop() as string;
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(byId.get(d)?.deps ?? []));
  }
  return seen;
}

/**
 * Put the blueprint step in a build plan: keep the Manager's own blueprint step when it wrote one
 * (with Depo's criteria), otherwise add one before the first build task. Every task that changes
 * code then waits for it. The result never has a loop.
 */
export function withBlueprint<
  T extends { id: string; title: string; owner: string; deps?: string[]; criteria?: string[] },
>(nodes: T[], bp: Blueprint, owner: string): T[] {
  const writerIds = new Set(nodes.filter((n) => WRITERS.has(n.owner)).map((n) => n.id));
  let out: T[] = nodes.map((n) => ({ ...n }));
  let step = out.find(isBlueprintStep);
  if (step) {
    // The blueprint goes first: it may not wait for anything that writes code.
    step.deps = (step.deps ?? []).filter((d) => !writerIds.has(d));
    step.criteria = blueprintCriteria(bp);
    if (!step.title.toLowerCase().includes(bp.title.toLowerCase()))
      step.title = `Start from the ${bp.title} blueprint`;
  } else {
    let id = BLUEPRINT_STEP;
    while (out.some((n) => n.id === id)) id = `${id}-2`;
    step = {
      id,
      title: `Start from the ${bp.title} blueprint`,
      owner,
      deps: [],
      criteria: blueprintCriteria(bp),
    } as unknown as T;
    const at = out.findIndex((n) => WRITERS.has(n.owner));
    out = at < 0 ? [...out, step] : [...out.slice(0, at), step, ...out.slice(at)];
  }
  const first = step;
  const before = ancestors(out, first.id);
  for (const n of out) {
    if (n === first || !WRITERS.has(n.owner) || before.has(n.id)) continue;
    const deps = n.deps ?? [];
    if (!deps.includes(first.id)) n.deps = [...deps, first.id];
  }
  return out;
}

/** The plan summary, naming the blueprint when it does not already. */
export function summaryWithBlueprint(summary: string, bp: Blueprint): string {
  const s = summary.trim();
  if (s.toLowerCase().includes(bp.title.toLowerCase()) || s.includes(bp.id)) return s;
  return `${s}${s && !/[.!?]$/.test(s) ? "." : ""}${s ? " " : ""}Starts from the ${bp.title} blueprint (${bp.id}).`;
}

/** One line for the single coder's prompt, or "" when no blueprint fits. */
export function blueprintHint(text: string, root: string): string {
  const bp = pickBlueprint("single", text, root);
  if (!bp) return "";
  return `This project is empty: start from the ${bp.title} blueprint (use_blueprint ${bp.id}; list_blueprints shows the others), run its tests, then build the request on top of it.`;
}

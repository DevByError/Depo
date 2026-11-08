import fs from "node:fs";
import path from "node:path";

/**
 * What the owner's request names that is not in the code yet: API routes ("GET /api/skills/search")
 * and, in a Next.js app, pages ("- /skills/[id] : …"). Small models stop after the first part of a
 * long request (the tables) and say they are done; Depo lists what is still missing and asks them
 * to go on. A route counts as there when its path appears in a source file; a page when its
 * page file exists.
 */

const SKIP_DIRS = new Set([
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
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|cs)$/i;
const MAX_FILES = 3000;

export interface RequestedParts {
  routes: { method: string; path: string }[];
  pages: string[];
}

/** The routes and pages a request names. */
export function requestedParts(request: string): RequestedParts {
  const routes = new Map<string, { method: string; path: string }>();
  for (const m of request.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s?`'"),;]*)/g)) {
    const p = (m[2] ?? "").replace(/[.:]+$/, "");
    if (p.length < 2) continue;
    routes.set(`${m[1]} ${p}`, { method: m[1] ?? "GET", path: p });
  }
  const pages = new Set<string>();
  // A list item that starts with a page path followed by " : " or " - " ("- /skills/[id] : name, …").
  for (const m of request.matchAll(/^[ \t]*[-*][ \t]+`?(\/[\w\-[\]/.]*)`?[ \t]+[:–—-][ \t]/gm)) {
    const p = m[1] ?? "";
    if (/^\/api(\/|$)/.test(p)) continue;
    pages.add(p.length > 1 ? p.replace(/\/+$/, "") : p);
  }
  return { routes: [...routes.values()], pages: [...pages] };
}

/** Source files of the copy (not dependencies, builds or Depo's data), up to a limit. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (SOURCE.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/** Next.js app router folders (`app` with a layout or page), relative to the root. */
export function appDirs(root: string): string[] {
  const found: string[] = [];
  for (const rel of [
    "app",
    "src/app",
    "fe/app",
    "fe/src/app",
    "frontend/app",
    "frontend/src/app",
    "web/app",
    "web/src/app",
    "client/app",
  ]) {
    const dir = path.join(root, rel);
    if (
      ["layout", "page"].some((f) =>
        [".tsx", ".jsx", ".ts", ".js"].some((x) => fs.existsSync(path.join(dir, f + x))),
      )
    )
      found.push(dir);
  }
  return found;
}

/** Does a page file for `route` exist under one of the app folders (route groups like (shop) allowed)? */
export function hasPage(dirs: string[], route: string): boolean {
  const parts = route.split("/").filter(Boolean);
  const matchDir = (dir: string, i: number): boolean => {
    if (i === parts.length)
      return [".tsx", ".jsx", ".ts", ".js", ".mdx"].some((x) => fs.existsSync(path.join(dir, `page${x}`)));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const want = (parts[i] ?? "").toLowerCase();
    // [id] in the request matches any dynamic folder ([id], [slug]).
    const dynamic = /^\[.+\]$/.test(want);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const n = e.name.toLowerCase();
      if (/^\(.+\)$/.test(n) && matchDir(path.join(dir, e.name), i)) return true;
      if (n === want || (dynamic && /^\[.+\]$/.test(n))) {
        if (matchDir(path.join(dir, e.name), i + 1)) return true;
      }
    }
    return false;
  };
  return dirs.some((d) => matchDir(d, 0));
}

/** The copy's source code, joined (files over 512 KB left out). */
export function sourceCode(root: string): string {
  let code = "";
  for (const f of sourceFiles(root)) {
    try {
      const st = fs.statSync(f);
      if (st.size <= 512 * 1024) code += `${fs.readFileSync(f, "utf8")}\n`;
    } catch {
      // unreadable: skip
    }
  }
  return code;
}

/**
 * Is the route's path in the code? The fixed start of the path counts: "/api/users/:id" is there
 * when "/api/users/" is. A path with no parameters must appear whole ("/api/skill" is not
 * "/api/skills/search").
 */
export function routeIn(code: string, routePath: string): boolean {
  const fixed = routePath.split(/[:{[*]/)[0] ?? routePath;
  const exact = fixed === routePath;
  const re = new RegExp(`${fixed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${exact ? "(?![\\w/-])" : ""}`);
  return re.test(code);
}

/** The parts of the request that are not in the code yet, as short lines for the model. */
export function missingParts(request: string, root: string): string[] {
  return requestStatus(request, root)
    .filter((p) => !p.ok)
    .map((p) => p.text);
}

/** Each route and page the request names that Depo can check, and whether the code has it. */
export function requestStatus(request: string, root: string): { text: string; ok: boolean }[] {
  const { routes, pages } = requestedParts(request);
  if (!routes.length && !pages.length) return [];
  const status: { text: string; ok: boolean }[] = [];
  if (routes.length) {
    const code = sourceCode(root);
    for (const r of routes)
      status.push({ text: `the route ${r.method} ${r.path}`, ok: routeIn(code, r.path) });
  }
  const dirs = appDirs(root);
  if (dirs.length)
    for (const p of pages) {
      const rel = path.relative(root, dirs[0] ?? root).replace(/\\/g, "/");
      status.push({ text: `the page ${p} (${rel}${p === "/" ? "" : p}/page.tsx)`, ok: hasPage(dirs, p) });
    }
  return status;
}

/**
 * The note that asks the model to go on with what is missing; with `first`, to build only the
 * first part (a larger model that takes over for one part).
 */
export function notDoneNote(missing: string[], blocks: boolean, first = false): string {
  const how = `read the files it touches, then ${blocks ? "write the code as file blocks" : "write and edit the files"}`;
  if (first)
    return [
      "Not done yet. The request asks for these, and they are not in the code:",
      ...missing.slice(0, 12).map((m) => `- ${m}`),
      `Build ${missing[0]} now (${how}). When it exists, say briefly what you built.`,
    ].join("\n");
  const list = missing.slice(0, 12).map((m) => `- ${m}`);
  if (missing.length > 12) list.push(`- and ${missing.length - 12} more`);
  return [
    "Not done yet. The request asks for these, and they are not in the code:",
    ...list,
    `Build the first one now (${how}), then the next. Finish only when all of them exist, and say briefly what you built.`,
  ].join("\n");
}

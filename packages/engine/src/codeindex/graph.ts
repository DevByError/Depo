import type {
  CodeArea,
  CodeEntryPoint,
  CodeHotSpot,
  CodeMap,
  CodeMapEdge,
  CodeMapNode,
  CodeMapSummary,
} from "@depo/shared";

/**
 * The code map's graph work, free of the database so it is easy to test: folders grouped into a
 * readable number of modules, module and file edges, import cycles (Tarjan), entry points, hot
 * spots, a Mermaid diagram and the compact text the `code_map` tool gives agents.
 */

export interface MapFile {
  path: string;
  lang: string | null;
  lines: number;
  symbols: number;
  branches: number;
  /** Why the file itself looks like an entry point, from its content. */
  entry: string | null;
}

export interface MapImport {
  from: string;
  to: string | null;
  library: string | null;
  /** A TypeScript type-only import: a dependency, but erased at runtime (never part of a cycle). */
  typeOnly?: boolean;
}

export interface Graph {
  files: Map<string, MapFile>;
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
  /** Imports that exist at runtime (type-only imports left out): what cycles are made of. */
  runtimeOut: Map<string, Set<string>>;
  edges: number;
  libraries: Map<string, number>;
  /** File-level runtime import cycles, largest first. */
  cycles: string[][];
  cycleOf: Map<string, number>;
  entries: CodeEntryPoint[];
  churn: Map<string, number>;
}

/** Code, styles and markup count; docs, data and lock files do not. */
const CODE_EXTRA = /\.(vue|svelte|astro|css|scss|sass|less|html?|sql|sh|ps1|bat|cmd)$/i;
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isCodeFile(path: string, lang: string | null): boolean {
  return lang !== null || CODE_EXTRA.test(path);
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function depthOf(dir: string): number {
  return dir ? dir.split("/").length : 0;
}

export function buildGraph(input: {
  files: MapFile[];
  imports: MapImport[];
  entries?: CodeEntryPoint[];
  churn?: Map<string, number>;
}): Graph {
  const files = new Map(input.files.map((f) => [f.path, f]));
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const runtimeOut = new Map<string, Set<string>>();
  const libraries = new Map<string, number>();
  let edges = 0;
  for (const imp of input.imports) {
    if (imp.to && imp.to !== imp.from && files.has(imp.from) && files.has(imp.to)) {
      if (!imp.typeOnly)
        runtimeOut.set(imp.from, (runtimeOut.get(imp.from) ?? new Set<string>()).add(imp.to));
      const set = out.get(imp.from) ?? new Set<string>();
      if (!set.has(imp.to)) {
        set.add(imp.to);
        edges++;
        out.set(imp.from, set);
        const back = inn.get(imp.to) ?? new Set<string>();
        back.add(imp.from);
        inn.set(imp.to, back);
      }
    } else if (!imp.to && imp.library) {
      libraries.set(imp.library, (libraries.get(imp.library) ?? 0) + 1);
    }
  }
  const cycles = stronglyConnected([...files.keys()], runtimeOut);
  const cycleOf = new Map<string, number>();
  cycles.forEach((c, i) => {
    for (const f of c) cycleOf.set(f, i);
  });
  const graph: Graph = {
    files,
    out,
    in: inn,
    runtimeOut,
    edges,
    libraries,
    cycles,
    cycleOf,
    entries: [],
    churn: input.churn ?? new Map(),
  };
  graph.entries = entryPoints(graph, input.entries ?? []);
  return graph;
}

/**
 * Strongly connected components with more than one member (import cycles), largest first.
 * Iterative Tarjan, so deep import chains cannot overflow the stack.
 */
export function stronglyConnected(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { v: string; it: Iterator<string> }[] = [];
    const open = (v: string) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: (adj.get(v) ?? new Set<string>()).values() });
    };
    open(start);
    while (work.length) {
      const top = work[work.length - 1] as { v: string; it: Iterator<string> };
      const step = top.it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v) ?? 0, index.get(w) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) ?? 0, low.get(top.v) ?? 0));
      if (low.get(top.v) === index.get(top.v)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop() as string;
          onStack.delete(w);
          comp.push(w);
          if (w === top.v) break;
        }
        if (comp.length > 1) out.push(comp.sort());
      }
    }
  }
  return out.sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/**
 * Folders as modules, merged bottom-up (smallest of the deepest first) until at most `max` remain,
 * so a big project still reads at a glance while big folders keep their own node.
 * Returns file → module (a folder path, "" for the top level).
 */
export function groupModules(paths: string[], max: number, root = ""): Map<string, string> {
  const counts = new Map<string, number>();
  const own = new Map<string, string>();
  for (const p of paths) {
    const d = dirOf(p);
    own.set(p, d);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const parentOf = new Map<string, string>();
  const rootDepth = depthOf(root);
  while (counts.size > Math.max(1, max)) {
    const deepest = Math.max(...[...counts.keys()].map(depthOf));
    if (deepest <= rootDepth) break;
    const level = [...counts.entries()]
      .filter(([d]) => depthOf(d) === deepest)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (const [d, n] of level) {
      if (counts.size <= max) break;
      const up = dirOf(d);
      parentOf.set(d, up);
      counts.delete(d);
      counts.set(up, (counts.get(up) ?? 0) + n);
    }
  }
  const resolve = (d: string): string => {
    let cur = d;
    for (let i = 0; i < 64 && parentOf.has(cur); i++) cur = parentOf.get(cur) as string;
    return cur;
  };
  const out = new Map<string, string>();
  for (const [p, d] of own) out.set(p, resolve(d));
  return out;
}

// ---- areas ---------------------------------------------------------------------------------

const AREA_SEGMENTS: [RegExp, CodeArea][] = [
  [/^(tests?|__tests__|spec|specs|e2e|cypress|playwright|fixtures)$/i, "tests"],
  [/^(docs?|documentation|guides?)$/i, "docs"],
  [/^(scripts?|\..+|ci|infra|deploy|deployment|docker|bin|config|configs|tooling)$/i, "tooling"],
  [
    /^(db|database|models?|schemas?|migrations?|entities|repositories|repos?|prisma|drizzle|sql|data|dao|orm|seeds?)$/i,
    "data",
  ],
  [
    /^(api|apis|routes?|routers?|controllers?|handlers?|server|endpoints?|services?|middlewares?|resolvers|graphql|backend|rpc|engine|gateway|workers?|jobs)$/i,
    "server",
  ],
  [/^(components?|screens?|ui|widgets|styles|frontend|hooks|store|stores)$/i, "ui"],
  // Also server words in Python, PHP or Ruby (views, templates): UI only when the folder holds UI files.
  [/^(pages|views?|layouts?|templates|public|assets|desktop|web|client)$/i, "ui"],
  [/^(lib|libs|utils?|helpers?|shared|common|core|types?|internal|pkg)$/i, "core"],
];
const AMBIGUOUS_UI = AREA_SEGMENTS.length - 2;
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html?)$/i;

/** What a module is mostly for, from its folder names (deepest first) and its files. */
export function areaOf(module: string, files: string[]): CodeArea {
  if (files.length > 0) {
    if (files.filter(isTestFile).length * 2 > files.length) return "tests";
    if (files.filter((f) => UI_FILE.test(f)).length * 2 > files.length) return "ui";
  }
  const uiFiles = files.length === 0 || files.some((f) => UI_FILE.test(f));
  const segs = module.split("/").filter(Boolean).reverse();
  for (const s of segs)
    for (const [i, [re, area]] of AREA_SEGMENTS.entries())
      if (re.test(s) && (i !== AMBIGUOUS_UI || uiFiles)) return area;
  return "other";
}

// ---- entry points ----------------------------------------------------------------------------

const ENTRY_NAMES: [RegExp, string][] = [
  [/(^|\/)manage\.py$/, "Django manage.py"],
  [/(^|\/)(wsgi|asgi)\.py$/, "server entry"],
  [/(^|\/)__main__\.py$/, "package main"],
  [/(^|\/)(main|app|server|wsgi)\.py$/, "main file"],
  [/(^|\/)(app|pages)\/(layout|page|_app)\.[jt]sx?$/, "Next.js app"],
  [/(^|\/)(main|index|server|app|cli)\.(m|c)?[jt]sx?$/, "main file"],
  [/(^|\/)cmd\/[^/]+\/main\.go$/, "command"],
  [/(^|\/)main\.go$/, "main package"],
  [/(^|\/)src\/(main|lib)\.rs$/, "crate root"],
  [/(^|\/)Program\.cs$/, "program"],
  [/(^|\/)lib\/main\.dart$/, "app entry"],
  [/(^|\/)index\.html?$/, "web page"],
];

/** Content hints that also fit library code (a helper that starts a test server): kept only when nothing imports the file. */
const WEAK_HINTS = new Set(["starts a server", "command line tool"]);
const BUILD_SCRIPT = /(^|\/)build\.rs$/;

/**
 * Declared entries first (package.json, pyproject), then content hints (a `__main__` block, an app
 * object, a React mount, a main function), then well-known names, then weak hints and build scripts.
 */
export function entryPoints(g: Graph, declared: CodeEntryPoint[]): CodeEntryPoint[] {
  const out = new Map<string, string>();
  const importedByCode = (p: string) => [...(g.in.get(p) ?? [])].filter((s) => !isTestFile(s)).length;
  for (const e of declared) if (g.files.has(e.path) && !out.has(e.path)) out.set(e.path, e.reason);
  const later: [string, string][] = [];
  for (const f of g.files.values()) {
    if (!f.entry || isTestFile(f.path) || out.has(f.path)) continue;
    if (WEAK_HINTS.has(f.entry) || BUILD_SCRIPT.test(f.path)) {
      if (importedByCode(f.path) === 0) later.push([f.path, f.entry]);
    } else out.set(f.path, f.entry);
  }
  const named = [...g.files.keys()]
    .filter((p) => !isTestFile(p) && !out.has(p) && depthOf(dirOf(p)) <= 3)
    .map((p) => ({ p, why: ENTRY_NAMES.find(([re]) => re.test(p))?.[1] }))
    .filter((x): x is { p: string; why: string } => !!x.why)
    // A `main.ts` nothing imports is a better guess than an `index.ts` many files import.
    .sort((a, b) => (g.in.get(a.p)?.size ?? 0) - (g.in.get(b.p)?.size ?? 0) || a.p.length - b.p.length);
  for (const { p, why } of named) {
    if ((g.in.get(p)?.size ?? 0) > 2) continue;
    out.set(p, why);
  }
  for (const [p, why] of later) if (!out.has(p)) out.set(p, why);
  return [...out.entries()].slice(0, 10).map(([path, reason]) => ({ path, reason }));
}

// ---- views ---------------------------------------------------------------------------------

export interface ViewOptions {
  projectId: string;
  level: "module" | "file";
  focus: string | null;
  /** Most modules (module level) or files (file level) to show. */
  max?: number;
  /** File level: exactly the files of this module (as the unfocused module level groups them). */
  module?: string | null;
  indexing: boolean;
  updatedAt: string | null;
}

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  c_sharp: "C#",
  kotlin: "Kotlin",
  php: "PHP",
  dart: "Dart",
  ruby: "Ruby",
  c: "C",
};
const EXTRA_LANGUAGES: [RegExp, string][] = [
  [/\.(css|scss|sass|less)$/i, "CSS"],
  [/\.html?$/i, "HTML"],
  [/\.vue$/i, "Vue"],
  [/\.svelte$/i, "Svelte"],
  [/\.astro$/i, "Astro"],
  [/\.sql$/i, "SQL"],
  [/\.(sh|ps1|bat|cmd)$/i, "Shell"],
];

export function languageName(path: string, lang: string | null): string {
  if (lang) return LANGUAGE_NAMES[lang] ?? lang;
  return EXTRA_LANGUAGES.find(([re]) => re.test(path))?.[1] ?? "Other";
}

function under(path: string, folder: string): boolean {
  return !folder || path.startsWith(`${folder}/`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;
}

function hotSpots(g: Graph, paths: string[]): CodeMap["hotSpots"] {
  const files = paths.map((p) => g.files.get(p)).filter((f): f is MapFile => !!f);
  const top = <T>(list: T[], key: (t: T) => number) =>
    list
      .filter((t) => key(t) > 0)
      .sort((a, b) => key(b) - key(a))
      .slice(0, 8);
  return {
    dependedOn: top(paths, (p) => g.in.get(p)?.size ?? 0).map((p) => {
      const n = g.in.get(p)?.size ?? 0;
      return { path: p, value: n, detail: `${plural(n, "file")} import it` };
    }),
    largest: top(files, (f) => f.lines).map((f) => ({
      path: f.path,
      value: f.lines,
      detail: `${plural(f.lines, "line")}, ${plural(f.symbols, "symbol")}`,
    })),
    complex: top(files, (f) => f.branches).map((f) => ({
      path: f.path,
      value: f.branches,
      detail: `${plural(f.branches, "branch")} in ${plural(f.lines, "line")}`,
    })),
    churn: top(paths, (p) => g.churn.get(p) ?? 0).map((p) => {
      const n = g.churn.get(p) ?? 0;
      return { path: p, value: n, detail: `changed in ${plural(n, "commit")}` };
    }),
  };
}

function summaryOf(g: Graph, paths: string[], modules: number): CodeMapSummary {
  const langs = new Map<string, { files: number; lines: number }>();
  let lines = 0;
  let symbols = 0;
  for (const p of paths) {
    const f = g.files.get(p);
    if (!f) continue;
    lines += f.lines;
    symbols += f.symbols;
    const name = languageName(f.path, f.lang);
    const l = langs.get(name) ?? { files: 0, lines: 0 };
    l.files++;
    l.lines += f.lines;
    langs.set(name, l);
  }
  const inside = new Set(paths);
  let edges = 0;
  for (const p of paths) for (const t of g.out.get(p) ?? []) if (inside.has(t)) edges++;
  return {
    files: paths.length,
    lines,
    symbols,
    edges,
    modules,
    languages: [...langs.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 8),
    libraries: [...g.libraries.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 12),
  };
}

function labelFor(id: string, focus: string | null): string {
  if (!id) return "(top level)";
  if (focus && id === focus) return `${id.split("/").pop() ?? id} (own files)`;
  if (focus && id.startsWith(`${focus}/`)) return id.slice(focus.length + 1);
  return id;
}

/** The module or file view the UI draws, and the base of the diagram and the agent text. */
export function buildView(g: Graph, o: ViewOptions): CodeMap {
  const focus = o.focus?.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "") || null;
  const all = [...g.files.keys()].sort();
  const globalModules = groupModules(all, 40);
  if (o.level === "file") return fileView(g, o, focus, all, globalModules);
  const max = o.max ?? 40;
  const selected = focus ? all.filter((p) => under(p, focus)) : all;
  const assign = groupModules(selected, max, focus ?? "");
  const inside = new Set(selected);
  const members = new Map<string, string[]>();
  for (const [p, m] of assign) members.set(m, [...(members.get(m) ?? []), p]);
  const entrySet = new Set(g.entries.map((e) => e.path));

  const weights = new Map<string, number>();
  const bump = (a: string, b: string) => {
    if (a === b) return;
    const k = `${a}\u0000${b}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
  };
  const outsideIds = new Set<string>();
  for (const p of selected) {
    const m = assign.get(p) as string;
    for (const t of g.out.get(p) ?? []) {
      if (inside.has(t)) bump(m, assign.get(t) as string);
      else {
        const om = globalModules.get(t) ?? dirOf(t);
        outsideIds.add(om);
        bump(m, `out:${om}`);
      }
    }
    if (focus)
      for (const s of g.in.get(p) ?? []) {
        if (inside.has(s)) continue;
        const om = globalModules.get(s) ?? dirOf(s);
        outsideIds.add(om);
        bump(`out:${om}`, m);
      }
  }
  const moduleIds = [...members.keys()];
  // Cycles are real runtime file cycles, lifted to the modules they touch. (A folder that holds both
  // a composition root and small helpers would otherwise look like one big module cycle.)
  const fileCycles = g.cycles.filter((c) => c.some((p) => inside.has(p)));
  const cycleModules = new Set<string>();
  const cycleEdges = new Set<string>();
  for (const c of fileCycles) {
    const ring = new Set(c);
    for (const p of c) {
      const a = assign.get(p);
      if (a === undefined) continue;
      cycleModules.add(a);
      for (const t of g.runtimeOut.get(p) ?? []) {
        const b = assign.get(t);
        if (ring.has(t) && b !== undefined && b !== a) cycleEdges.add(`${a}\u0000${b}`);
      }
    }
  }

  const nodeId = (k: string) => (k.startsWith("out:") ? k.slice(4) : k);
  const edges: CodeMapEdge[] = [...weights.entries()].map(([k, weight]) => {
    const [a, b] = k.split("\u0000") as [string, string];
    return { from: nodeId(a), to: nodeId(b), weight, cycle: cycleEdges.has(k) };
  });
  const degree = (id: string, dir: "from" | "to") =>
    new Set(edges.filter((e) => e[dir] === id).map((e) => (dir === "from" ? e.to : e.from))).size;
  const nodes: CodeMapNode[] = moduleIds.map((id) => {
    const fs = members.get(id) ?? [];
    let lines = 0;
    let symbols = 0;
    let branches = 0;
    for (const p of fs) {
      const f = g.files.get(p);
      lines += f?.lines ?? 0;
      symbols += f?.symbols ?? 0;
      branches += f?.branches ?? 0;
    }
    return {
      id,
      label: labelFor(id, focus),
      kind: "module",
      area: areaOf(id, fs),
      files: fs.length,
      lines,
      symbols,
      branches,
      importsOut: degree(id, "from"),
      importedBy: degree(id, "to"),
      inCycle: cycleModules.has(id),
      entry: fs.some((p) => entrySet.has(p)),
      module: null,
      outside: false,
    };
  });
  // Outside neighbours (when zoomed in): one node per module, for context only.
  for (const id of outsideIds) {
    if (members.has(id)) continue;
    const fs = all.filter((p) => globalModules.get(p) === id);
    nodes.push({
      id,
      label: labelFor(id, null),
      kind: "module",
      area: areaOf(id, fs),
      files: fs.length,
      lines: 0,
      symbols: 0,
      branches: 0,
      importsOut: degree(id, "from"),
      importedBy: degree(id, "to"),
      inCycle: false,
      entry: false,
      module: null,
      outside: true,
    });
  }
  nodes.sort((a, b) => Number(a.outside) - Number(b.outside) || a.id.localeCompare(b.id));
  return {
    projectId: o.projectId,
    level: "module",
    focus,
    summary: summaryOf(g, selected, moduleIds.length),
    nodes,
    edges: edges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from)),
    cycles: fileCycles.slice(0, 10),
    entryPoints: g.entries.filter((e) => under(e.path, focus ?? "")),
    hotSpots: hotSpots(g, selected),
    truncated: false,
    indexing: o.indexing,
    updatedAt: o.updatedAt,
  };
}

function fileView(
  g: Graph,
  o: ViewOptions,
  focus: string | null,
  all: string[],
  globalModules: Map<string, string>,
): CodeMap {
  const max = o.max ?? 60;
  const degree = (p: string) => (g.in.get(p)?.size ?? 0) + (g.out.get(p)?.size ?? 0);
  let core: string[];
  let context: string[] = [];
  let truncated = false;
  const module = o.module ?? null;
  if (module !== null) {
    const pool = all.filter((p) => globalModules.get(p) === module);
    truncated = pool.length > max;
    core = [...pool].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b)).slice(0, max);
    const inside = new Set(pool);
    const near = new Set<string>();
    for (const p of core) {
      for (const t of g.out.get(p) ?? []) if (!inside.has(t)) near.add(t);
      for (const s of g.in.get(p) ?? []) if (!inside.has(s)) near.add(s);
    }
    context = [...near].sort((a, b) => degree(b) - degree(a)).slice(0, 20);
  } else if (focus && g.files.has(focus)) {
    core = [focus];
    const near = [...(g.out.get(focus) ?? []), ...(g.in.get(focus) ?? [])];
    context = [...new Set(near)].sort((a, b) => degree(b) - degree(a));
    truncated = context.length > max - 1;
    context = context.slice(0, max - 1);
  } else {
    const pool = focus ? all.filter((p) => under(p, focus)) : all;
    const ranked = [...pool].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
    truncated = ranked.length > max;
    core = ranked.slice(0, max);
    if (focus) {
      const inside = new Set(pool);
      const near = new Set<string>();
      for (const p of core) {
        for (const t of g.out.get(p) ?? []) if (!inside.has(t)) near.add(t);
        for (const s of g.in.get(p) ?? []) if (!inside.has(s)) near.add(s);
      }
      context = [...near].sort((a, b) => degree(b) - degree(a)).slice(0, 20);
    }
  }
  const shown = new Set([...core, ...context]);
  const coreSet = new Set(core);
  const entrySet = new Set(g.entries.map((e) => e.path));
  const edges: CodeMapEdge[] = [];
  for (const p of shown)
    for (const t of g.out.get(p) ?? []) {
      if (!shown.has(t)) continue;
      // Context nodes only link to the focus, not to each other.
      if (!coreSet.has(p) && !coreSet.has(t)) continue;
      const cp = g.cycleOf.get(p);
      const runtime = g.runtimeOut.get(p)?.has(t) === true;
      edges.push({
        from: p,
        to: t,
        weight: 1,
        cycle: runtime && cp !== undefined && cp === g.cycleOf.get(t),
      });
    }
  const folder = module !== null ? module || null : focus && !g.files.has(focus) ? focus : null;
  const nodes: CodeMapNode[] = [...shown].map((p) => {
    const f = g.files.get(p);
    const mod = globalModules.get(p) ?? dirOf(p);
    return {
      id: p,
      label: folder && p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : p,
      kind: "file",
      area: areaOf(mod, [p]),
      files: 1,
      lines: f?.lines ?? 0,
      symbols: f?.symbols ?? 0,
      branches: f?.branches ?? 0,
      importsOut: g.out.get(p)?.size ?? 0,
      importedBy: g.in.get(p)?.size ?? 0,
      inCycle: g.cycleOf.has(p),
      entry: entrySet.has(p),
      module: mod,
      outside: !coreSet.has(p),
    };
  });
  nodes.sort((a, b) => Number(a.outside) - Number(b.outside) || a.id.localeCompare(b.id));
  const scope =
    module !== null
      ? all.filter((p) => globalModules.get(p) === module)
      : folder
        ? all.filter((p) => under(p, folder))
        : core.length === 1 && focus
          ? core
          : all;
  return {
    projectId: o.projectId,
    level: "file",
    focus,
    summary: summaryOf(g, scope, new Set(scope.map((p) => globalModules.get(p))).size),
    nodes,
    edges,
    cycles: g.cycles.filter((c) => c.some((p) => shown.has(p))).slice(0, 10),
    entryPoints: g.entries.filter((e) => !folder || under(e.path, folder)),
    hotSpots: hotSpots(g, scope),
    truncated,
    indexing: o.indexing,
    updatedAt: o.updatedAt,
  };
}

// ---- Mermaid -------------------------------------------------------------------------------

const DIAGRAM_MAX_NODES = 24;
const DIAGRAM_MAX_EDGES = 60;

function mermaidLabel(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/[<>]/g, "").slice(0, 60);
}

/**
 * A Mermaid flowchart of modules and their imports: clustered by top folder, at most 24 modules
 * (the busiest), cycles drawn in red. Arrows point from the importer to what it imports.
 */
export function mermaidFromView(view: CodeMap, projectName: string): string {
  const inside = view.nodes.filter((n) => !n.outside && n.kind === "module");
  const busy = (n: CodeMapNode) => n.importedBy * 3 + n.importsOut * 2 + Math.log2(1 + n.files);
  const keep = [...inside]
    .sort((a, b) => busy(b) - busy(a) || a.id.localeCompare(b.id))
    .slice(0, DIAGRAM_MAX_NODES);
  const ids = new Map(keep.map((n, i) => [n.id, `m${i}`]));
  const edges = view.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .sort((a, b) => Number(b.cycle) - Number(a.cycle) || b.weight - a.weight)
    .slice(0, DIAGRAM_MAX_EDGES);
  const lines = [
    "flowchart LR",
    `  %% ${mermaidLabel(projectName)}: modules and their imports, drawn by Depo from the code. It updates when the code changes.`,
  ];
  const clusterOf = (id: string) => (id.includes("/") ? (id.split("/")[0] ?? "") : "");
  const clusters = new Map<string, CodeMapNode[]>();
  for (const n of keep) {
    const c = clusterOf(n.id);
    clusters.set(c, [...(clusters.get(c) ?? []), n]);
  }
  const nodeLine = (n: CodeMapNode, indent: string) =>
    `${indent}${ids.get(n.id)}["${mermaidLabel(n.id ? n.label : "(top level)")}<br/>${n.files} file${n.files === 1 ? "" : "s"}"]`;
  let c = 0;
  for (const [name, members] of [...clusters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!name || members.length < 2) {
      for (const n of members) lines.push(nodeLine(n, "  "));
      continue;
    }
    lines.push(`  subgraph c${c++}["${mermaidLabel(name)}"]`);
    for (const n of members) lines.push(nodeLine(n, "    "));
    lines.push("  end");
  }
  const red: number[] = [];
  edges.forEach((e, i) => {
    const arrow = e.weight >= 5 ? "==>" : "-->";
    lines.push(`  ${ids.get(e.from)} ${arrow} ${ids.get(e.to)}`);
    if (e.cycle) red.push(i);
  });
  const cycleNodes = keep.filter((n) => n.inCycle).map((n) => ids.get(n.id));
  if (cycleNodes.length) {
    lines.push("  classDef cycle stroke:#e5534b,stroke-width:2px");
    lines.push(`  class ${cycleNodes.join(",")} cycle`);
  }
  if (red.length) lines.push(`  linkStyle ${red.join(",")} stroke:#e5534b,stroke-width:2px`);
  if (keep.length === 0) lines.push('  empty["No source files indexed yet"]');
  return `${lines.join("\n")}\n`;
}

// ---- agent text ----------------------------------------------------------------------------

function short(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Add lines until the budget is used; say what was left out. */
function fit(lines: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget - 40) {
      out.push("(more left out; ask code_map about a folder or a file)");
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

/** The module overview for agents: short, plain, budgeted for small models. */
export function overviewText(view: CodeMap, budget = 1800): string {
  const s = view.summary;
  if (s.files === 0)
    return "The code index has no source files yet (still indexing, or an empty project). Use list_dir.";
  const langs = s.languages
    .slice(0, 4)
    .map((l) => `${l.name} ${Math.round((l.lines / Math.max(1, s.lines)) * 100)}%`)
    .join(", ");
  const inside = view.nodes.filter((n) => !n.outside);
  const lines = [
    `Code map${view.focus ? ` of ${view.focus}` : ""}: ${s.files} files, ${short(s.lines)} lines (${langs}); ${inside.length} modules, ${s.edges} imports between files.`,
  ];
  if (s.libraries.length)
    lines.push(
      `Uses: ${s.libraries
        .slice(0, 8)
        .map((l) => l.name)
        .join(", ")}.`,
    );
  if (view.entryPoints.length)
    lines.push(
      `Entry points: ${view.entryPoints
        .slice(0, 5)
        .map((e) => `${e.path} (${e.reason})`)
        .join("; ")}.`,
    );
  lines.push("Modules (files, lines; -> what it imports):");
  const ranked = [...inside].sort(
    (a, b) => b.importedBy + b.importsOut - (a.importedBy + a.importsOut) || b.files - a.files,
  );
  for (const n of ranked.slice(0, 14)) {
    const to = view.edges
      .filter((e) => e.from === n.id)
      .slice(0, 4)
      .map((e) => (e.to ? e.to.split("/").slice(-2).join("/") : "(top)"));
    lines.push(
      `- ${n.id || "(top level)"} (${n.files}, ${short(n.lines)})${to.length ? ` -> ${to.join(", ")}` : ""}${n.inCycle ? " [cycle]" : ""}`,
    );
  }
  if (view.cycles.length)
    lines.push(
      `Import cycles: ${view.cycles
        .slice(0, 3)
        .map((c) => `${c.slice(0, 4).join(" <-> ")}${c.length > 4 ? ` (+${c.length - 4})` : ""}`)
        .join("; ")}.`,
    );
  const hs = view.hotSpots;
  const list = (h: CodeHotSpot[], n = 4) =>
    h
      .slice(0, n)
      .map((x) => `${x.path} (${x.value})`)
      .join(", ");
  if (hs.dependedOn.length) lines.push(`Most imported: ${list(hs.dependedOn)}.`);
  if (hs.largest.length) lines.push(`Largest (lines): ${list(hs.largest, 3)}.`);
  if (hs.complex.length) lines.push(`Most branches: ${list(hs.complex, 3)}.`);
  if (hs.churn.length) lines.push(`Changed most: ${list(hs.churn, 3)}.`);
  lines.push('Call code_map with path="<file>" for its imports and importers, or folder="<dir>" to zoom in.');
  return fit(lines, budget);
}

/** One file's neighbours for agents. */
export function fileText(
  info: {
    path: string;
    module: string;
    lines: number;
    branches: number;
    entry: string | null;
    inCycle: boolean;
    imports: { spec: string; target: string | null; library: string | null }[];
    importedBy: { path: string }[];
    symbols: { name: string; kind: string; startLine: number }[];
  },
  budget = 1800,
): string {
  const local = info.imports.filter((i) => i.target).map((i) => i.target as string);
  const libs = [...new Set(info.imports.map((i) => i.library).filter((l): l is string => !!l))];
  const lines = [
    `${info.path} (${info.lines} lines, ${info.symbols.length} symbols, ${info.branches} branches; module ${info.module || "(top level)"})${info.entry ? `; entry point: ${info.entry}` : ""}${info.inCycle ? "; part of an import cycle" : ""}`,
    `Imports ${local.length} project file${local.length === 1 ? "" : "s"}: ${[...new Set(local)].slice(0, 15).join(", ") || "none"}`,
  ];
  if (libs.length) lines.push(`Libraries: ${libs.slice(0, 10).join(", ")}`);
  lines.push(
    `Imported by ${info.importedBy.length} file${info.importedBy.length === 1 ? "" : "s"}: ${
      info.importedBy
        .slice(0, 15)
        .map((i) => i.path)
        .join(", ") || "none"
    }`,
  );
  if (info.symbols.length)
    lines.push(
      `Symbols: ${info.symbols
        .slice(0, 20)
        .map((s) => `${s.kind} ${s.name} (${s.startLine})`)
        .join(", ")}`,
    );
  return fit(lines, budget);
}

import fs from "node:fs";
import path from "node:path";
import type { CodeEntryPoint, CodeFileInfo, CodeMap, CodeMapLevel, RepoInfo } from "@depo/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { detectStack, stackSummary } from "../agent/stack";
import type { AppDb } from "../db";
import { codeFiles, codeImports, codeSymbols, projects } from "../db/schema";
import type { Logger } from "../logger";
import { git, gitFileChurn, gitLog, gitSummary, isGitRepo } from "../tools/git";
import {
  areaOf,
  buildGraph,
  buildView,
  dirOf,
  fileText,
  type Graph,
  groupModules,
  isCodeFile,
  type MapImport,
  mermaidFromView,
  overviewText,
} from "./graph";
import { type ImportRef, ImportResolver, parseJsonc } from "./resolve";

/** Where the auto diagram is listed in the Diagrams tab (it lives in Depo's data folder, never the project). */
export const AUTO_DIAGRAM_PATH = ".depo/code-map.mmd";
const DIAGRAM_DEBOUNCE_MS = 4000;
const CHURN_TTL_MS = 10 * 60_000;
/** How long a code map request waits for git history before answering without it. */
const CHURN_WAIT_MS = 3000;
const CONFIG_FILE =
  /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|package\.json|go\.mod|pubspec\.yaml|Cargo\.toml|pyproject\.toml)$/;
const MAX_CONFIG_BYTES = 256 * 1024;

interface Cached {
  graph: Graph;
  modules: Map<string, string>;
  updatedAt: string | null;
}

interface Churn {
  at: number;
  head: string;
  counts: Map<string, number>;
}

export interface CodeMapOptions {
  db: AppDb;
  logger: Logger;
  /** `<data>/projects`: the auto diagram goes to `<mapDir>/<projectId>/code-map.mmd`. */
  mapDir?: string;
  indexing(projectId: string): boolean;
}

/**
 * The code map of each project, built from the code index tables: imports between files resolved
 * to project files, modules, cycles, entry points and hot spots (with git history when the project
 * is a repository). Results are cached until the next index pass. Also keeps the auto architecture
 * diagram fresh (debounced) for the Diagrams tab.
 */
export class CodeMapService {
  private readonly cache = new Map<string, Cached>();
  private readonly churns = new Map<string, Churn | null>();
  private readonly churnRuns = new Map<string, Promise<Map<string, number>>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped on every index change; the diagram is rewritten when it falls behind. */
  private readonly generation = new Map<string, number>();
  private readonly drawn = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly o: CodeMapOptions) {
    this.log = o.logger.child({ component: "index" });
  }

  // ---- maintenance (called by the indexer) ----------------------------------------------------

  /**
   * Point imports at project files. `only` limits the work to the imports of those files; a full
   * pass (null) is needed when files were added or removed or a config file (tsconfig, package.json,
   * go.mod...) changed, because then any import may resolve differently.
   */
  resolveImports(projectId: string, root: string, only: string[] | null): number {
    const files = this.o.db
      .select({ path: codeFiles.path })
      .from(codeFiles)
      .where(eq(codeFiles.projectId, projectId))
      .all()
      .map((r) => r.path);
    const resolver = new ImportResolver({ files, read: (rel) => readSmall(root, rel) });
    const select = this.o.db
      .select({
        id: codeImports.id,
        path: codeImports.path,
        spec: codeImports.spec,
        name: codeImports.name,
        kind: codeImports.kind,
        target: codeImports.target,
      })
      .from(codeImports);
    const rows: {
      id: number;
      path: string;
      spec: string;
      name: string;
      kind: string;
      target: string | null;
    }[] = [];
    if (only === null) rows.push(...select.where(eq(codeImports.projectId, projectId)).all());
    else
      for (let i = 0; i < only.length; i += 200)
        rows.push(
          ...select
            .where(
              and(eq(codeImports.projectId, projectId), inArray(codeImports.path, only.slice(i, i + 200))),
            )
            .all(),
        );
    const updates: { id: number; target: string | null }[] = [];
    for (const r of rows) {
      const target = resolver.resolve(r.path, r);
      if (target !== r.target) updates.push({ id: r.id, target });
    }
    if (updates.length)
      this.o.db.transaction((tx) => {
        for (const u of updates)
          tx.update(codeImports).set({ target: u.target }).where(eq(codeImports.id, u.id)).run();
      });
    return updates.length;
  }

  /** Does a change to this file mean every import must be resolved again? */
  static isConfigFile(rel: string): boolean {
    return CONFIG_FILE.test(rel);
  }

  /** The index changed: drop the cached map and redraw the diagram a little later. */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
    this.generation.set(projectId, (this.generation.get(projectId) ?? 0) + 1);
    if (!this.o.mapDir) return;
    const old = this.timers.get(projectId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(projectId);
      try {
        this.drawDiagram(projectId);
      } catch (err) {
        this.log.warn("could not draw the code map diagram", { projectId, err });
      }
    }, DIAGRAM_DEBOUNCE_MS);
    t.unref?.();
    this.timers.set(projectId, t);
  }

  forget(projectId: string): void {
    this.stopTimers(projectId);
    this.cache.delete(projectId);
    this.churns.delete(projectId);
    this.generation.delete(projectId);
    this.drawn.delete(projectId);
  }

  stopTimers(projectId?: string): void {
    for (const [id, t] of this.timers) {
      if (projectId && id !== projectId) continue;
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  // ---- queries -------------------------------------------------------------------------------

  async get(projectId: string, level: CodeMapLevel, focus?: string): Promise<CodeMap> {
    const root = this.rootOf(projectId);
    await this.withChurn(projectId, root);
    const c = this.cached(projectId);
    return buildView(c.graph, {
      projectId,
      level,
      focus: focus ?? null,
      indexing: this.o.indexing(projectId),
      updatedAt: c.updatedAt,
    });
  }

  async file(projectId: string, rawPath: string): Promise<CodeFileInfo> {
    const root = this.rootOf(projectId);
    const rel = cleanPath(rawPath);
    const row = this.o.db
      .select()
      .from(codeFiles)
      .where(and(eq(codeFiles.projectId, projectId), eq(codeFiles.path, rel)))
      .get();
    if (!row) throw new Error("This file is not in the code index.");
    const churn = await this.withChurn(projectId, root);
    const c = this.cached(projectId);
    const resolver = this.resolverFor(projectId, root);
    const seen = new Set<string>();
    const imports = this.o.db
      .select()
      .from(codeImports)
      .where(and(eq(codeImports.projectId, projectId), eq(codeImports.path, rel)))
      .orderBy(asc(codeImports.line))
      .all()
      .map((i) => ({
        spec: i.name ? (i.spec.endsWith(".") ? `${i.spec}${i.name}` : `${i.spec}.${i.name}`) : i.spec,
        line: i.line,
        kind: i.kind,
        target: i.target,
        library: i.target ? null : resolver.external(rel, i),
      }))
      .filter((i) => {
        const key = `${i.spec}\u0000${i.target ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const by = new Map<string, number>();
    for (const r of this.o.db
      .select({ path: codeImports.path, line: codeImports.line })
      .from(codeImports)
      .where(and(eq(codeImports.projectId, projectId), eq(codeImports.target, rel)))
      .orderBy(asc(codeImports.path), asc(codeImports.line))
      .all())
      if (!by.has(r.path) && r.path !== rel) by.set(r.path, r.line);
    const symbols = this.o.db
      .select({
        name: codeSymbols.name,
        kind: codeSymbols.kind,
        parent: codeSymbols.parent,
        startLine: codeSymbols.startLine,
        endLine: codeSymbols.endLine,
        signature: codeSymbols.signature,
      })
      .from(codeSymbols)
      .where(and(eq(codeSymbols.projectId, projectId), eq(codeSymbols.path, rel)))
      .orderBy(asc(codeSymbols.startLine))
      .limit(200)
      .all();
    const module = c.modules.get(rel) ?? dirOf(rel);
    return {
      path: rel,
      module,
      area: areaOf(module, [rel]),
      lang: row.lang,
      lines: row.lines,
      branches: row.branches,
      entry: row.entry ?? c.graph.entries.find((e) => e.path === rel)?.reason ?? null,
      inCycle: c.graph.cycleOf.has(rel),
      churn: churn ? (churn.get(rel) ?? 0) : null,
      imports,
      importedBy: [...by.entries()].map(([p, line]) => ({ path: p, line })),
      symbols,
    };
  }

  async repo(projectId: string): Promise<RepoInfo> {
    const root = this.rootOf(projectId);
    const exists = fs.existsSync(root);
    const stack = exists ? detectStack(root) : null;
    let git: RepoInfo["git"] = null;
    if (exists && (await isGitRepo(root))) {
      const [summary, log] = await Promise.all([gitSummary(root), gitLog(root, 1)]);
      git = {
        branch: summary?.branch ?? null,
        changed: summary?.changed ?? 0,
        ahead: summary?.ahead ?? 0,
        behind: summary?.behind ?? 0,
        lastCommit: log[0] ?? null,
      };
    }
    return {
      stack: {
        summary: stack ? stackSummary(stack) : "",
        languages: stack?.languages ?? [],
        frameworks: stack?.frameworks ?? [],
        databases: stack?.databases ?? [],
        tools: stack?.tools ?? [],
        packageManager: stack?.packageManager ?? null,
        testCommand: stack?.testCommand ?? null,
        runCommand: stack?.runCommand ?? null,
      },
      git,
    };
  }

  /**
   * The `code_map` tool's answer: the module overview, a folder zoomed in, or one file's
   * neighbours. Short on purpose (small local models): about `budget` characters.
   */
  async text(projectId: string, a: { path?: string; folder?: string }, budget = 1800): Promise<string> {
    const wanted = a.path?.trim();
    if (wanted) {
      const rel = this.findFile(projectId, wanted);
      if (!rel)
        return `No indexed file matches "${wanted}". Use find_files to look for it, or code_map with no path for the overview.`;
      return fileText(await this.file(projectId, rel), budget);
    }
    const folder = a.folder ? cleanPath(a.folder) : "";
    const view = await this.get(projectId, "module", folder || undefined);
    if (folder && view.summary.files === 0)
      return `No indexed source files under "${folder}". Call code_map with no folder for the overview.`;
    return overviewText(view, budget);
  }

  /** The auto architecture diagram for the Diagrams tab (redrawn first when the index moved on). */
  diagrams(projectId: string): { path: string; content: string; source: "auto" }[] {
    if (!this.o.mapDir) return [];
    try {
      if (
        (this.drawn.get(projectId) ?? -1) < (this.generation.get(projectId) ?? 0) ||
        !fs.existsSync(this.diagramFile(projectId))
      )
        this.drawDiagram(projectId);
      const file = this.diagramFile(projectId);
      if (!fs.existsSync(file)) return [];
      return [{ path: AUTO_DIAGRAM_PATH, content: fs.readFileSync(file, "utf8"), source: "auto" }];
    } catch (err) {
      this.log.warn("could not read the code map diagram", { projectId, err });
      return [];
    }
  }

  /** Write the diagram when there is something to draw and it changed. Returns the Mermaid text. */
  drawDiagram(projectId: string): string | null {
    if (!this.o.mapDir) return null;
    const c = this.cached(projectId);
    this.drawn.set(projectId, this.generation.get(projectId) ?? 0);
    if (c.graph.files.size === 0) return null;
    const name =
      this.o.db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get()
        ?.name ?? "Project";
    const view = buildView(c.graph, {
      projectId,
      level: "module",
      focus: null,
      max: 24,
      indexing: false,
      updatedAt: c.updatedAt,
    });
    const text = mermaidFromView(view, name);
    const file = this.diagramFile(projectId);
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (old !== text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return text;
  }

  // ---- internals -----------------------------------------------------------------------------

  private diagramFile(projectId: string): string {
    return path.join(this.o.mapDir ?? "", projectId, "code-map.mmd");
  }

  private rootOf(projectId: string): string {
    const root = this.o.db
      .select({ root: projects.rootPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()?.root;
    if (!root) throw new Error(`Unknown project: ${projectId}`);
    return root;
  }

  private resolverFor(projectId: string, root: string): ImportResolver {
    const files = this.o.db
      .select({ path: codeFiles.path })
      .from(codeFiles)
      .where(eq(codeFiles.projectId, projectId))
      .all()
      .map((r) => r.path);
    return new ImportResolver({ files, read: (rel) => readSmall(root, rel) });
  }

  private findFile(projectId: string, wanted: string): string | null {
    const rel = cleanPath(wanted);
    const exact = this.o.db
      .select({ path: codeFiles.path })
      .from(codeFiles)
      .where(and(eq(codeFiles.projectId, projectId), eq(codeFiles.path, rel)))
      .get();
    if (exact) return exact.path;
    const like = this.o.db
      .select({ path: codeFiles.path })
      .from(codeFiles)
      .where(
        and(
          eq(codeFiles.projectId, projectId),
          sql`${codeFiles.path} LIKE ${`%${rel.replace(/[\\%_]/g, "\\$&")}`} ESCAPE '\\'`,
        ),
      )
      .limit(5)
      .all()
      .filter((r) => r.path === rel || r.path.endsWith(`/${rel}`));
    return like.length === 1 ? (like[0]?.path ?? null) : null;
  }

  /** The graph from the index tables, cached until the next index change. */
  private cached(projectId: string): Cached {
    const hit = this.cache.get(projectId);
    if (hit) return hit;
    const root = this.rootOf(projectId);
    const fileRows = this.o.db
      .select({
        path: codeFiles.path,
        lang: codeFiles.lang,
        lines: codeFiles.lines,
        branches: codeFiles.branches,
        entry: codeFiles.entry,
        updatedAt: codeFiles.updatedAt,
      })
      .from(codeFiles)
      .where(eq(codeFiles.projectId, projectId))
      .all();
    const symbolCounts = new Map(
      this.o.db
        .select({ path: codeSymbols.path, n: sql<number>`count(*)` })
        .from(codeSymbols)
        .where(eq(codeSymbols.projectId, projectId))
        .groupBy(codeSymbols.path)
        .all()
        .map((r) => [r.path, r.n]),
    );
    const allPaths = fileRows.map((f) => f.path);
    const resolver = new ImportResolver({ files: allPaths, read: (rel) => readSmall(root, rel) });
    const imports: MapImport[] = this.o.db
      .select({
        path: codeImports.path,
        spec: codeImports.spec,
        name: codeImports.name,
        kind: codeImports.kind,
        target: codeImports.target,
      })
      .from(codeImports)
      .where(eq(codeImports.projectId, projectId))
      .all()
      .map((r) => ({
        from: r.path,
        to: r.target,
        library: r.target ? null : resolver.external(r.path, r),
        typeOnly: r.kind === "type",
      }));
    const code = fileRows.filter((f) => isCodeFile(f.path, f.lang));
    const churn = this.churns.get(projectId)?.counts;
    const graph = buildGraph({
      files: code.map((f) => ({
        path: f.path,
        lang: f.lang,
        lines: f.lines,
        symbols: symbolCounts.get(f.path) ?? 0,
        branches: f.branches,
        entry: f.entry,
      })),
      imports,
      entries: declaredEntries(allPaths, resolver, (rel) => readSmall(root, rel)),
      ...(churn ? { churn } : {}),
    });
    let updatedAt: string | null = null;
    for (const f of fileRows) if (!updatedAt || f.updatedAt > updatedAt) updatedAt = f.updatedAt;
    const out: Cached = { graph, modules: groupModules([...graph.files.keys()], 40), updatedAt };
    this.cache.set(projectId, out);
    return out;
  }

  /**
   * Git history (commits per file) for the hot spots, cached for ten minutes or until HEAD moves.
   * Waits at most a few seconds; a slow repository answers next time. Null when not a repository.
   */
  private async withChurn(projectId: string, root: string): Promise<Map<string, number> | null> {
    const known = this.churns.get(projectId);
    if (known === null) return null;
    if (known && Date.now() - known.at < CHURN_TTL_MS) return known.counts;
    let run = this.churnRuns.get(projectId);
    if (!run) {
      run = (async () => {
        if (!fs.existsSync(root) || !(await isGitRepo(root))) {
          this.churns.set(projectId, null);
          return new Map<string, number>();
        }
        const head = (await git(root, ["rev-parse", "HEAD"], 5000).catch(() => null))?.stdout.trim() ?? "";
        if (known && known.head === head) {
          known.at = Date.now();
          return known.counts;
        }
        const counts = await gitFileChurn(root);
        this.churns.set(projectId, { at: Date.now(), head, counts });
        this.cache.delete(projectId);
        return counts;
      })().finally(() => this.churnRuns.delete(projectId));
      this.churnRuns.set(projectId, run);
    }
    const timeout = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), CHURN_WAIT_MS);
      t.unref?.();
    });
    const counts = await Promise.race([run, timeout]);
    if (this.churns.get(projectId) === null) return null;
    return counts ?? known?.counts ?? new Map();
  }
}

function cleanPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
}

/** A small text file of the project (configs), or null. */
function readSmall(root: string, rel: string): string | null {
  try {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

const SCRIPT_FILE =
  /(?:^|[\s&;])(?:node|bun(?:\s+run)?|tsx|ts-node|nodemon|deno\s+run)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*["']?([\w./\\-]+\.[cm]?[jt]sx?)/;

/** Entry points the project declares: package.json main/bin/start scripts, pyproject scripts. */
export function declaredEntries(
  files: string[],
  resolver: ImportResolver,
  read: (rel: string) => string | null,
): CodeEntryPoint[] {
  const out: CodeEntryPoint[] = [];
  const add = (dir: string, spec: string, lang: "js" | "py", reason: string, name = "") => {
    const importer = `${dir ? `${dir}/` : ""}__entry__.${lang === "js" ? "js" : "py"}`;
    const ref: ImportRef = { spec, name, kind: "import" };
    const target = resolver.resolve(importer, ref);
    if (target && !out.some((e) => e.path === target)) out.push({ path: target, reason });
  };
  for (const f of files) {
    if (f === "package.json" || f.endsWith("/package.json")) {
      const json = parseJsonc(read(f)) as {
        main?: unknown;
        module?: unknown;
        bin?: unknown;
        scripts?: Record<string, unknown>;
      } | null;
      if (!json || typeof json !== "object") continue;
      const dir = dirOf(f);
      const rel = (s: string) => (s.startsWith(".") ? s : `./${s.replace(/\\/g, "/")}`);
      for (const key of ["start", "dev", "serve"]) {
        const script = json.scripts?.[key];
        const m = typeof script === "string" ? SCRIPT_FILE.exec(script) : null;
        if (m?.[1]) add(dir, rel(m[1]), "js", `npm ${key === "start" ? "start" : `run ${key}`}`);
      }
      const bins =
        typeof json.bin === "string"
          ? [json.bin]
          : json.bin && typeof json.bin === "object"
            ? Object.values(json.bin)
            : [];
      for (const b of bins)
        if (typeof b === "string") add(dir, rel(b), "js", "command line tool (package.json bin)");
      for (const k of ["main", "module"] as const) {
        const v = json[k];
        if (typeof v === "string") add(dir, rel(v), "js", `package.json ${k}`);
      }
    } else if (f === "pyproject.toml" || f.endsWith("/pyproject.toml")) {
      const text = read(f) ?? "";
      const section =
        /^\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1] ??
        "";
      for (const m of section.matchAll(/^\s*([\w.-]+)\s*=\s*["']([\w.]+)(?::[\w.]+)?["']/gm))
        if (m[2]) add(dirOf(f), m[2], "py", `script ${m[1]}`);
    }
  }
  return out;
}

import fs from "node:fs";
import path from "node:path";
import type { ModelProvider } from "@depo/model-gateway";
import type { IndexStatus, SearchHit } from "@depo/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db";
import { codeFiles, codeSymbols, embeddings, projects } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import type { ModelScheduler } from "../scheduler/scheduler";
import { DEFAULT_IGNORES, isBinary } from "../tools/fs-tools";
import { hashBytes, LINKED_DIRS, walkProject } from "../workspace/snapshot";
import { languageFor } from "./languages";
import { extractSymbols } from "./symbols";

/** Files above this size are not indexed (generated bundles, data dumps). */
const MAX_INDEX_FILE = 1024 * 1024;
const CHUNK_LINES = 60;
const CHUNK_STEP = 50;
const EMBED_BATCH = 16;
const WATCH_DEBOUNCE_MS = 1500;

export interface EmbeddingSource {
  /** The embedding model to use, or null when none is installed. */
  embedder(): Promise<{ provider: ModelProvider; model: string } | null>;
}

export interface CodeIndexerOptions {
  db: AppDb;
  bus: EventBus;
  logger: Logger;
  scheduler: ModelScheduler;
  embeddings: EmbeddingSource;
  enabled: (projectId: string) => boolean;
}

interface State {
  status: IndexStatus;
  watcher: fs.FSWatcher | null;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  again: boolean;
  abort: AbortController | null;
  vectors: { ids: number[]; paths: string[]; starts: number[]; ends: number[]; vecs: Float32Array[] } | null;
}

/**
 * Code index per project: tree-sitter symbols for a repo map and symbol lookup, plus
 * embeddings of ~60-line chunks for semantic search. Updated incrementally from a file watcher;
 * only files whose content hash changed are re-parsed and re-embedded. Embedding calls go
 * through the scheduler at background priority, so they never hold up a task.
 */
export class CodeIndexer {
  private readonly states = new Map<string, State>();
  private readonly log: Logger;

  constructor(private readonly o: CodeIndexerOptions) {
    this.log = o.logger.child({ component: "index" });
  }

  status(projectId: string): IndexStatus {
    const st = this.states.get(projectId);
    if (st) return { ...st.status };
    return this.initialStatus(projectId);
  }

  /** Start watching and bring the index up to date (no-op when already watching). */
  ensure(projectId: string): void {
    if (!this.o.enabled(projectId)) {
      this.stop(projectId);
      this.state(projectId).status.state = "disabled";
      return;
    }
    const st = this.state(projectId);
    if (st.watcher) return;
    const root = this.rootOf(projectId);
    if (!root || !fs.existsSync(root)) return;
    try {
      st.watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const rel = String(file).replace(/\\/g, "/");
        if (rel.split("/").some((seg) => DEFAULT_IGNORES.has(seg) || LINKED_DIRS.has(seg))) return;
        st.pending.add(rel);
        if (st.timer) clearTimeout(st.timer);
        st.timer = setTimeout(() => this.flush(projectId), WATCH_DEBOUNCE_MS);
      });
      st.watcher.on("error", (err) => {
        this.log.warn("file watcher stopped", { projectId, err });
        st.watcher = null;
        st.status.watching = false;
      });
      st.status.watching = true;
    } catch (err) {
      this.log.warn("could not watch project", { projectId, err });
    }
    this.schedule(projectId, null);
  }

  /** Re-index everything (keeps rows for files whose content did not change). */
  rebuild(projectId: string): IndexStatus {
    if (!this.o.enabled(projectId)) throw new Error("Indexing is turned off for this project.");
    this.ensure(projectId);
    this.schedule(projectId, null);
    return this.status(projectId);
  }

  /** Wait for the current indexing run (tests). */
  async idle(projectId: string): Promise<void> {
    for (;;) {
      const st = this.states.get(projectId);
      const run = st?.running;
      if (!run) return;
      await run;
    }
  }

  stop(projectId: string): void {
    const st = this.states.get(projectId);
    if (!st) return;
    st.watcher?.close();
    st.watcher = null;
    st.status.watching = false;
    if (st.timer) clearTimeout(st.timer);
    st.abort?.abort();
  }

  stopAll(): void {
    for (const id of this.states.keys()) this.stop(id);
  }

  forget(projectId: string): void {
    this.stop(projectId);
    this.states.delete(projectId);
  }

  // ---- queries -------------------------------------------------------------------------------

  /** Files with their declarations, shortest first per directory, trimmed to a character budget. */
  repoMap(projectId: string, budgetChars = 4000, prefix = ""): string {
    const files = this.o.db
      .select({ path: codeFiles.path, lines: codeFiles.lines })
      .from(codeFiles)
      .where(eq(codeFiles.projectId, projectId))
      .all()
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) return "";
    const syms = this.o.db.select().from(codeSymbols).where(eq(codeSymbols.projectId, projectId)).all();
    const byFile = new Map<string, typeof syms>();
    for (const s of syms) {
      const list = byFile.get(s.path) ?? [];
      list.push(s);
      byFile.set(s.path, list);
    }
    const out: string[] = [];
    let used = 0;
    let skipped = 0;
    for (const f of files) {
      const list = (byFile.get(f.path) ?? []).sort((a, b) => a.startLine - b.startLine);
      const block = [
        `${f.path} (${f.lines} lines)`,
        ...list.slice(0, 25).map((s) => `  ${s.parent ? "  " : ""}${s.startLine}: ${s.signature}`),
        ...(list.length > 25 ? [`  … ${list.length - 25} more`] : []),
      ].join("\n");
      if (used + block.length > budgetChars) {
        skipped++;
        continue;
      }
      out.push(block);
      used += block.length + 1;
    }
    if (skipped) out.push(`(${skipped} more files not shown; use find_files or search)`);
    return out.join("\n");
  }

  findSymbols(projectId: string, name: string, limit = 20): SearchHit[] {
    const q = name.trim().toLowerCase();
    if (!q) return [];
    const rows = this.o.db
      .select()
      .from(codeSymbols)
      .where(
        and(
          eq(codeSymbols.projectId, projectId),
          sql`lower(${codeSymbols.name}) LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`,
        ),
      )
      .limit(500)
      .all();
    return rows
      .map((r) => {
        const n = r.name.toLowerCase();
        const score = n === q ? 1 : n.startsWith(q) ? 0.8 : 0.6;
        return {
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          score,
          kind: "symbol" as const,
          title: `${r.kind} ${r.parent ? `${r.parent}.` : ""}${r.name}`,
          preview: r.signature,
        };
      })
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  /** Symbols plus semantic matches (when embeddings exist), best first. */
  async search(projectId: string, query: string, limit = 10, signal?: AbortSignal): Promise<SearchHit[]> {
    const hits = new Map<string, SearchHit>();
    for (const term of query
      .split(/\s+/)
      .filter((t) => /^[\w$.]{3,}$/.test(t))
      .slice(0, 5)) {
      for (const h of this.findSymbols(projectId, term.split(".").pop() ?? term, 5))
        hits.set(`${h.path}:${h.startLine}`, h);
    }
    for (const h of await this.semantic(projectId, query, limit, signal)) {
      const key = `${h.path}:${h.startLine}`;
      if (!hits.has(key)) hits.set(key, h);
    }
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async semantic(
    projectId: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const vectors = this.loadVectors(projectId);
    if (!vectors || vectors.vecs.length === 0) return [];
    const emb = await this.o.embeddings.embedder();
    if (!emb) return [];
    const [qv] = await this.o.scheduler.run(
      { projectId, taskId: null, model: emb.model, priority: "chat", label: "search" },
      () => emb.provider.embed(emb.model, [query], signal),
      signal,
    );
    if (!qv) return [];
    const q = normalise(Float32Array.from(qv));
    const scored = vectors.vecs.map((v, i) => ({ i, s: v.length === q.length ? dot(v, q) : -1 }));
    scored.sort((a, b) => b.s - a.s);
    const root = this.rootOf(projectId) ?? "";
    return scored.slice(0, limit).map(({ i, s }) => {
      const p = vectors.paths[i] ?? "";
      const start = vectors.starts[i] ?? 1;
      return {
        path: p,
        startLine: start,
        endLine: vectors.ends[i] ?? start,
        score: s,
        kind: "semantic" as const,
        title: `${p}:${start}`,
        preview: previewLines(path.join(root, p), start, 3),
      };
    });
  }

  // ---- indexing ------------------------------------------------------------------------------

  private state(projectId: string): State {
    let st = this.states.get(projectId);
    if (!st) {
      st = {
        status: this.initialStatus(projectId),
        watcher: null,
        pending: new Set(),
        timer: null,
        running: null,
        again: false,
        abort: null,
        vectors: null,
      };
      this.states.set(projectId, st);
    }
    return st;
  }

  private initialStatus(projectId: string): IndexStatus {
    const count = (table: typeof codeFiles | typeof codeSymbols | typeof embeddings) =>
      this.o.db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.projectId, projectId)).get()
        ?.n ?? 0;
    const model = this.o.db
      .select({ model: embeddings.model })
      .from(embeddings)
      .where(eq(embeddings.projectId, projectId))
      .limit(1)
      .get()?.model;
    const last = this.o.db
      .select({ at: sql<string | null>`max(${codeFiles.updatedAt})` })
      .from(codeFiles)
      .where(eq(codeFiles.projectId, projectId))
      .get()?.at;
    return {
      projectId,
      state: this.o.enabled(projectId) ? "idle" : "disabled",
      files: count(codeFiles),
      symbols: count(codeSymbols),
      chunks: count(embeddings),
      embeddingModel: model ?? null,
      progress: null,
      lastIndexedAt: last ?? null,
      watching: false,
      error: null,
    };
  }

  private flush(projectId: string): void {
    const st = this.state(projectId);
    st.timer = null;
    const paths = [...st.pending];
    st.pending.clear();
    if (paths.length) this.schedule(projectId, paths);
  }

  /** Run an indexing pass; `paths` null = whole project. Passes never overlap per project. */
  private schedule(projectId: string, paths: string[] | null): void {
    const st = this.state(projectId);
    if (st.running) {
      if (paths) for (const p of paths) st.pending.add(p);
      else st.again = true;
      return;
    }
    st.abort = new AbortController();
    const signal = st.abort.signal;
    st.running = this.pass(projectId, paths, signal)
      .catch((err: unknown) => {
        if (signal.aborted) return;
        st.status.state = "error";
        st.status.error = err instanceof Error ? err.message : String(err);
        this.log.warn("indexing failed", { projectId, err });
      })
      .finally(() => {
        st.running = null;
        st.abort = null;
        if (signal.aborted) return;
        if (st.again) {
          st.again = false;
          this.schedule(projectId, null);
        } else if (st.pending.size) {
          const more = [...st.pending];
          st.pending.clear();
          this.schedule(projectId, more);
        }
      });
  }

  private async pass(projectId: string, only: string[] | null, signal: AbortSignal): Promise<void> {
    const root = this.rootOf(projectId);
    if (!root || !fs.existsSync(root)) return;
    const st = this.state(projectId);
    const t0 = performance.now();
    const known = new Map(
      this.o.db
        .select({ path: codeFiles.path, hash: codeFiles.hash })
        .from(codeFiles)
        .where(eq(codeFiles.projectId, projectId))
        .all()
        .map((r) => [r.path, r.hash]),
    );
    const files = only ?? walkProject(root);
    if (!only) {
      // Files that disappeared since the last full pass.
      const present = new Set(files);
      const gone = [...known.keys()].filter((p) => !present.has(p));
      if (gone.length) this.removeFiles(projectId, gone);
    }
    const emb = await this.o.embeddings.embedder().catch(() => null);
    st.status = { ...st.status, state: "indexing", error: null, progress: { done: 0, total: files.length } };
    let changed = 0;
    let done = 0;
    const toEmbed: { path: string; start: number; end: number; text: string; hash: string }[] = [];
    for (const rel of files) {
      if (signal.aborted) return;
      done++;
      if (done % 50 === 0) st.status.progress = { done, total: files.length };
      const abs = path.join(root, rel);
      let buf: Buffer;
      try {
        const s = fs.statSync(abs);
        if (!s.isFile() || s.size > MAX_INDEX_FILE) {
          if (known.has(rel)) this.removeFiles(projectId, [rel]);
          continue;
        }
        buf = fs.readFileSync(abs);
      } catch {
        if (known.has(rel)) this.removeFiles(projectId, [rel]);
        continue;
      }
      if (isBinary(buf)) continue;
      const hash = hashBytes(buf);
      if (known.get(rel) === hash && (!emb || this.hasEmbeddings(projectId, rel, emb.model))) continue;
      changed++;
      const text = buf.toString("utf8");
      const lang = languageFor(rel);
      const symbols = lang ? await extractSymbols(lang, text).catch(() => []) : [];
      const lines = text.split("\n").length;
      const now = new Date().toISOString();
      this.o.db.transaction((tx) => {
        tx.delete(codeSymbols)
          .where(and(eq(codeSymbols.projectId, projectId), eq(codeSymbols.path, rel)))
          .run();
        tx.delete(embeddings)
          .where(and(eq(embeddings.projectId, projectId), eq(embeddings.path, rel)))
          .run();
        tx.insert(codeFiles)
          .values({
            projectId,
            path: rel,
            hash,
            lang,
            size: buf.length,
            lines,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [codeFiles.projectId, codeFiles.path],
            set: { hash, lang, size: buf.length, lines, updatedAt: now },
          })
          .run();
        for (const s of symbols)
          tx.insert(codeSymbols)
            .values({ projectId, path: rel, ...s })
            .run();
      });
      if (emb) for (const c of chunk(rel, text)) toEmbed.push({ ...c, hash });
    }
    if (emb && toEmbed.length) {
      st.status.embeddingModel = emb.model;
      for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
        if (signal.aborted) return;
        const batch = toEmbed.slice(i, i + EMBED_BATCH);
        st.status.progress = { done: i, total: toEmbed.length };
        let vectors: number[][];
        try {
          vectors = await this.o.scheduler.run(
            { projectId, taskId: null, model: emb.model, priority: "background", label: "indexing" },
            () =>
              emb.provider.embed(
                emb.model,
                batch.map((b) => b.text),
                signal,
              ),
            signal,
          );
        } catch (err) {
          if (signal.aborted) return;
          st.status.error = `Embeddings skipped: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        const now = new Date().toISOString();
        this.o.db.transaction((tx) => {
          batch.forEach((b, k) => {
            const v = vectors[k];
            if (!v) return;
            const f = normalise(Float32Array.from(v));
            tx.insert(embeddings)
              .values({
                projectId,
                path: b.path,
                startLine: b.start,
                endLine: b.end,
                textHash: b.hash,
                model: emb.model,
                dim: f.length,
                vector: Buffer.from(f.buffer, f.byteOffset, f.byteLength),
                createdAt: now,
              })
              .run();
          });
        });
      }
    }
    st.vectors = null;
    const fresh = this.initialStatus(projectId);
    st.status = {
      ...fresh,
      state: "idle",
      watching: st.watcher !== null,
      error: st.status.error,
      embeddingModel: fresh.embeddingModel ?? (emb ? emb.model : null),
    };
    if (changed > 0 || !only) {
      this.o.bus.emit({
        projectId,
        agent: "engine",
        type: "indexing",
        text: only
          ? `Index updated: ${changed} file${changed === 1 ? "" : "s"}`
          : `Indexed ${fresh.files} files, ${fresh.symbols} symbols${fresh.chunks ? `, ${fresh.chunks} chunks` : ""}`,
        details: { files: fresh.files, symbols: fresh.symbols, chunks: fresh.chunks, changed },
        durationMs: Math.round(performance.now() - t0),
        status: "succeeded",
      });
    }
  }

  private hasEmbeddings(projectId: string, rel: string, model: string): boolean {
    return (
      this.o.db
        .select({ id: embeddings.id })
        .from(embeddings)
        .where(
          and(eq(embeddings.projectId, projectId), eq(embeddings.path, rel), eq(embeddings.model, model)),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  private removeFiles(projectId: string, paths: string[]): void {
    for (let i = 0; i < paths.length; i += 200) {
      const part = paths.slice(i, i + 200);
      this.o.db.transaction((tx) => {
        tx.delete(codeFiles)
          .where(and(eq(codeFiles.projectId, projectId), inArray(codeFiles.path, part)))
          .run();
        tx.delete(codeSymbols)
          .where(and(eq(codeSymbols.projectId, projectId), inArray(codeSymbols.path, part)))
          .run();
        tx.delete(embeddings)
          .where(and(eq(embeddings.projectId, projectId), inArray(embeddings.path, part)))
          .run();
      });
    }
    const st = this.states.get(projectId);
    if (st) st.vectors = null;
  }

  private loadVectors(projectId: string): State["vectors"] {
    const st = this.state(projectId);
    if (st.vectors) return st.vectors;
    const rows = this.o.db
      .select({
        id: embeddings.id,
        path: embeddings.path,
        start: embeddings.startLine,
        end: embeddings.endLine,
        vector: embeddings.vector,
      })
      .from(embeddings)
      .where(eq(embeddings.projectId, projectId))
      .all();
    st.vectors = {
      ids: rows.map((r) => r.id),
      paths: rows.map((r) => r.path),
      starts: rows.map((r) => r.start),
      ends: rows.map((r) => r.end),
      vecs: rows.map((r) => {
        const b = r.vector as Buffer;
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }),
    };
    return st.vectors;
  }

  private rootOf(projectId: string): string | null {
    return (
      this.o.db.select({ root: projects.rootPath }).from(projects).where(eq(projects.id, projectId)).get()
        ?.root ?? null
    );
  }
}

export function chunk(
  rel: string,
  text: string,
): { path: string; start: number; end: number; text: string }[] {
  const lines = text.split("\n");
  const out: { path: string; start: number; end: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_STEP) {
    const part = lines.slice(i, i + CHUNK_LINES);
    const body = part.join("\n");
    if (body.trim().length < 20) continue;
    out.push({ path: rel, start: i + 1, end: i + part.length, text: `${rel}\n${body}`.slice(0, 3000) });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return out;
}

function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function previewLines(abs: string, start: number, n: number): string {
  try {
    return fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .slice(start - 1, start - 1 + n)
      .join("\n")
      .slice(0, 300);
  } catch {
    return "";
  }
}

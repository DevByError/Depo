import path from "node:path";
import {
  type ApiResult,
  fuzzyMatch,
  type Marks,
  positionsToMarks,
  queryTerms,
  SEARCH_SCOPES,
  type SearchGroup,
  type SearchResult,
  type SearchScope,
  snippetAround,
  textMarks,
} from "@depo/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { CodeIndexer } from "../codeindex/indexer";
import type { AppDb } from "../db";
import { events as eventsTable, tasks as tasksTable } from "../db/schema";
import type { Logger } from "../logger";
import type { LogService } from "../logs/service";
import type { MemoryStore } from "../memory/store";
import { listProjectFiles } from "../tools/search";
import { type ContentHit, contentSearch, smartCase } from "./content";

export interface SearchServiceOptions {
  db: AppDb;
  indexer: Pick<CodeIndexer, "findSymbols" | "status">;
  memory: Pick<MemoryStore, "list">;
  logs: Pick<LogService, "query"> | null;
  logger: Logger;
  projectRoot: (projectId: string) => string | null;
  /** Test hooks. */
  budgets?: Partial<Record<SearchScope, number>>;
  noRipgrep?: boolean;
}

/** Time each scope may take before it answers with what it has. Scopes run in parallel. */
export const SCOPE_BUDGET_MS: Record<SearchScope, number> = {
  files: 500,
  symbols: 300,
  content: 900,
  tasks: 300,
  decisions: 300,
  memory: 250,
  logs: 700,
};

/** How groups compare when ranked against each other (a file name match beats a log line). */
const SCOPE_WEIGHT: Record<SearchScope, number> = {
  files: 1,
  symbols: 0.95,
  tasks: 0.9,
  memory: 0.85,
  decisions: 0.8,
  content: 0.75,
  logs: 0.5,
};

const NEEDS_PROJECT: Record<SearchScope, boolean> = {
  files: true,
  symbols: true,
  content: true,
  tasks: true,
  decisions: true,
  memory: false,
  logs: false,
};

interface ScopeRun {
  projectId: string | null;
  root: string | null;
  query: string;
  limit: number;
  signal: AbortSignal;
  /** Results found so far; kept when the scope runs out of time. */
  partial: SearchResult[];
}

type ScopeAnswer = { results: SearchResult[]; more: boolean; error?: string | null };

const TITLE_MAX = 160;
const FILE_LIST_TTL_MS = 20_000;

/** A one-line title (cut at TITLE_MAX) with every match of the query marked. */
function titleWithMarks(text: string, query: string): { text: string; marks: Marks } {
  const flat = text.replace(/\s+/g, " ").trim();
  const short = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
  return { text: short, marks: textMarks(short, query) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function likeAll(column: ReturnType<typeof sql>, terms: string[]) {
  return terms.map(
    (t) => sql`lower(${column}) LIKE ${`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`,
  );
}

function capitalise(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : s;
}

const TASK_STATUS: Record<string, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting for you",
  review: "Ready for review",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

const MEMORY_KIND: Record<string, string> = {
  fact: "Fact",
  preference: "Preference",
  decision: "Decision",
  lesson: "Lesson",
};

/**
 * Universal search behind Ctrl+K. Every scope runs at the same time with its own time budget;
 * a slow scope answers with what it found so far and never holds up the others.
 */
export class SearchService {
  private readonly fileCache = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(private readonly o: SearchServiceOptions) {}

  async everything(p: {
    projectId?: string | undefined;
    query: string;
    scopes?: SearchScope[] | undefined;
    limit: number;
  }): Promise<ApiResult<"search.everything">> {
    const t0 = performance.now();
    const scopes = p.scopes?.length ? [...new Set(p.scopes)] : [...SEARCH_SCOPES];
    const projectId = p.projectId ?? null;
    const root = projectId ? this.o.projectRoot(projectId) : null;
    const query = p.query.trim();
    if (!query) {
      // An empty query warms the file list so the first real keystroke is quick.
      if (root) void this.files(root).catch(() => {});
      return {
        query: p.query,
        groups: scopes.map((scope) => ({
          scope,
          results: [],
          more: false,
          timedOut: false,
          error: null,
          tookMs: 0,
        })),
        tookMs: 0,
      };
    }
    const groups = await Promise.all(
      scopes.map((scope) => this.runScope(scope, { projectId, root, query, limit: p.limit })),
    );
    const rank = (g: SearchGroup) => (g.results[0]?.score ?? 0) * SCOPE_WEIGHT[g.scope];
    const order = (g: SearchGroup) => SEARCH_SCOPES.indexOf(g.scope);
    groups.sort((a, b) => {
      const ea = a.results.length === 0;
      const eb = b.results.length === 0;
      if (ea !== eb) return ea ? 1 : -1;
      if (ea) return order(a) - order(b);
      return rank(b) - rank(a) || order(a) - order(b);
    });
    return { query: p.query, groups, tookMs: Math.round(performance.now() - t0) };
  }

  private async runScope(
    scope: SearchScope,
    base: { projectId: string | null; root: string | null; query: string; limit: number },
  ): Promise<SearchGroup> {
    const started = performance.now();
    const took = () => Math.round(performance.now() - started);
    if (NEEDS_PROJECT[scope] && !base.projectId)
      return {
        scope,
        results: [],
        more: false,
        timedOut: false,
        error: "Open a project to search it.",
        tookMs: 0,
      };
    if (NEEDS_PROJECT[scope] && (scope === "files" || scope === "content") && !base.root)
      return {
        scope,
        results: [],
        more: false,
        timedOut: false,
        error: "The project folder is missing.",
        tookMs: 0,
      };
    const ctl = new AbortController();
    const run: ScopeRun = { ...base, signal: ctl.signal, partial: [] };
    const budget = this.o.budgets?.[scope] ?? SCOPE_BUDGET_MS[scope];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budget);
    });
    try {
      const answer = await Promise.race([this.scope(scope, run), timeout]);
      if (answer === "timeout") {
        ctl.abort();
        const results = [...run.partial].sort((a, b) => b.score - a.score).slice(0, base.limit);
        return {
          scope,
          results,
          more: run.partial.length > base.limit,
          timedOut: true,
          error: null,
          tookMs: took(),
        };
      }
      return {
        scope,
        results: answer.results.slice(0, base.limit),
        more: answer.more || answer.results.length > base.limit,
        timedOut: false,
        error: answer.error ?? null,
        tookMs: took(),
      };
    } catch (err) {
      this.o.logger.warn("search scope failed", { scope, err: String(err) });
      return {
        scope,
        results: [],
        more: false,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
        tookMs: took(),
      };
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
  }

  private scope(scope: SearchScope, r: ScopeRun): Promise<ScopeAnswer> {
    switch (scope) {
      case "files":
        return this.searchFiles(r);
      case "symbols":
        return Promise.resolve(this.searchSymbols(r));
      case "content":
        return this.searchContent(r);
      case "tasks":
        return Promise.resolve(this.searchTasks(r));
      case "decisions":
        return Promise.resolve(this.searchDecisions(r));
      case "memory":
        return Promise.resolve(this.searchMemory(r));
      case "logs":
        return this.searchLogs(r);
    }
  }

  /** The project's files (git ls-files when it is a repository), cached for a few seconds. */
  files(root: string): Promise<string[]> {
    const hit = this.fileCache.get(root);
    if (hit && Date.now() - hit.at < FILE_LIST_TTL_MS) return hit.files;
    const files = listProjectFiles(root).then((list) => list.map((f) => f.replace(/\\/g, "/")));
    this.fileCache.set(root, { at: Date.now(), files });
    files.catch(() => this.fileCache.delete(root));
    return files;
  }

  private async searchFiles(r: ScopeRun): Promise<ScopeAnswer> {
    const files = await this.files(r.root as string);
    const q = r.query.replace(/\\/g, "/");
    const scored: SearchResult[] = [];
    for (const f of files) {
      const m = fuzzyMatch(q, f);
      if (!m) continue;
      // Contiguous matches score 100+; map to 0..1 so groups can be compared.
      const score = Math.min(1, Math.max(0.05, m.score / (130 + q.length * 4)));
      const dir = path.posix.dirname(f);
      scored.push({
        id: `file:${f}`,
        scope: "files",
        title: f,
        titleMarks: positionsToMarks(m.positions),
        detail: dir === "." ? "Project folder" : dir,
        snippet: null,
        score,
        target: { kind: "file", path: f, line: null },
      });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title),
    );
    return { results: scored.slice(0, r.limit + 1), more: scored.length > r.limit };
  }

  private searchSymbols(r: ScopeRun): ScopeAnswer {
    const projectId = r.projectId as string;
    const term = queryTerms(r.query).find((t) => /^[\w$.]+$/.test(t)) ?? queryTerms(r.query)[0] ?? "";
    const name = term.split(".").pop() ?? term;
    if (!name) return { results: [], more: false };
    const status = this.o.indexer.status(projectId);
    if (status.symbols === 0)
      return {
        results: [],
        more: false,
        error:
          status.state === "disabled"
            ? "The code index is off for this project."
            : "No symbols yet. The code index builds in the background.",
      };
    const hits = this.o.indexer.findSymbols(projectId, name, r.limit * 4);
    const results = hits.map((h): SearchResult => {
      const t = titleWithMarks(h.title, name);
      return {
        id: `symbol:${h.path}:${h.startLine}:${h.title}`,
        scope: "symbols",
        title: t.text,
        titleMarks: t.marks,
        detail: `${h.path}:${h.startLine}`,
        snippet: h.preview
          ? (snippetAround(h.preview, name) ?? { text: h.preview.slice(0, 140), marks: [] })
          : null,
        score: h.score,
        target: { kind: "file", path: h.path, line: h.startLine },
      };
    });
    return { results: results.slice(0, r.limit + 1), more: hits.length > r.limit };
  }

  private async searchContent(r: ScopeRun): Promise<ScopeAnswer> {
    const root = r.root as string;
    const want = Math.max(r.limit * 4, 20);
    const hits: ContentHit[] = [];
    const q = r.query;
    const sensitive = smartCase(q);
    const lowerQ = q.toLowerCase();
    const word = new RegExp(
      `(^|[^\\w])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`,
      sensitive ? "" : "i",
    );
    const toResult = (h: ContentHit): SearchResult => {
      let score = 0.45;
      if (h.text.includes(q)) score += 0.1;
      if (word.test(h.text)) score += 0.15;
      if (h.path.toLowerCase().includes(lowerQ)) score += 0.1;
      if (
        /^\s*(export\s+)?(async\s+)?(def|class|function|interface|type|const|let|struct|fn|func|public|private)\b/.test(
          h.text,
        )
      )
        score += 0.1;
      if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(h.path)) score -= 0.05;
      const snip = snippetAround(h.text, q) ?? { text: h.text.slice(0, 140), marks: [] };
      return {
        id: `content:${h.path}:${h.line}`,
        scope: "content",
        title: h.path,
        titleMarks: textMarks(h.path, q),
        detail: `Line ${h.line}`,
        snippet: snip,
        score: Math.min(1, score),
        target: { kind: "file", path: h.path, line: h.line },
      };
    };
    const { stoppedEarly } = await contentSearch(root, q, {
      max: want,
      signal: r.signal,
      onHit: (h) => {
        hits.push(h);
        r.partial.push(toResult(h));
      },
      files: () => this.files(root),
      ...(this.o.noRipgrep ? { noRipgrep: true } : {}),
    });
    const results = hits.map(toResult).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return { results: results.slice(0, r.limit + 1), more: stoppedEarly || results.length > r.limit };
  }

  private searchTasks(r: ScopeRun): ScopeAnswer {
    const terms = queryTerms(r.query);
    const hay = sql`${tasksTable.title} || ' ' || ${tasksTable.prompt} || ' ' || coalesce(${tasksTable.summary}, '')`;
    const rows = this.o.db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.projectId, r.projectId as string), ...likeAll(hay, terms)))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(60)
      .all();
    const q = r.query;
    const results = rows.map((t, i): SearchResult => {
      const title = titleWithMarks(t.title, q);
      const inTitle = title.marks.length > 0;
      const summary = t.summary ?? "";
      const snippet = snippetAround(summary, q) ?? (inTitle ? null : snippetAround(t.prompt, q));
      // Recent tasks first among equals; a title match beats a match in the answer.
      const score =
        (inTitle ? 0.75 : 0.55) + (t.title.toLowerCase() === q.toLowerCase() ? 0.2 : 0) - i * 0.002;
      return {
        id: `task:${t.id}`,
        scope: "tasks",
        title: title.text,
        titleMarks: title.marks,
        detail: [TASK_STATUS[t.status] ?? t.status, shortDate(t.updatedAt)].filter(Boolean).join(" · "),
        snippet,
        score,
        target: { kind: "task", taskId: t.id },
      };
    });
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, r.limit + 1), more: results.length > r.limit };
  }

  private searchDecisions(r: ScopeRun): ScopeAnswer {
    const terms = queryTerms(r.query);
    const rows = this.o.db
      .select()
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.type, "decision"),
          eq(eventsTable.projectId, r.projectId as string),
          sql`${eventsTable.taskId} IS NOT NULL`,
          ...likeAll(sql`${eventsTable.text} || ' ' || coalesce(${eventsTable.details}, '')`, terms),
        ),
      )
      .orderBy(desc(eventsTable.ts))
      .limit(60)
      .all();
    const q = r.query;
    const results = rows.map((e, i): SearchResult => {
      const t = titleWithMarks(e.text, q);
      let reason = "";
      try {
        const d = e.details ? (JSON.parse(e.details) as Record<string, unknown>) : null;
        reason = typeof d?.reason === "string" ? d.reason : "";
      } catch {
        reason = "";
      }
      const agent = capitalise(e.agent.split("@")[0] ?? e.agent);
      return {
        id: `decision:${e.id}`,
        scope: "decisions",
        title: t.text,
        titleMarks: t.marks,
        detail: [agent, shortDate(e.ts)].filter(Boolean).join(" · "),
        snippet: t.marks.length ? null : snippetAround(reason, q),
        score: (t.marks.length ? 0.7 : 0.5) - i * 0.002,
        target: { kind: "decision", taskId: e.taskId as string, eventId: e.id },
      };
    });
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, r.limit + 1), more: results.length > r.limit };
  }

  private searchMemory(r: ScopeRun): ScopeAnswer {
    const terms = queryTerms(r.query);
    const facts = [...(r.projectId ? this.o.memory.list(r.projectId) : []), ...this.o.memory.list(null)];
    const q = r.query;
    const results: SearchResult[] = [];
    for (const f of facts) {
      const lower = f.text.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const t = titleWithMarks(f.text, q);
      const exact = lower.includes(q.toLowerCase());
      results.push({
        id: `memory:${f.id}`,
        scope: "memory",
        title: t.text,
        titleMarks: t.marks,
        detail: [MEMORY_KIND[f.kind] ?? f.kind, f.projectId ? "This project" : "Every project"].join(" · "),
        snippet: null,
        score: (exact ? 0.7 : 0.55) + (f.projectId ? 0.05 : 0),
        target: { kind: "memory", factId: f.id, global: f.projectId === null },
      });
    }
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, r.limit + 1), more: results.length > r.limit };
  }

  private async searchLogs(r: ScopeRun): Promise<ScopeAnswer> {
    if (!this.o.logs) return { results: [], more: false, error: "Logs are not available." };
    const q = r.query;
    const res = await this.o.logs.query({ text: q, limit: r.limit + 1, maxBytes: 3 * 1024 * 1024 });
    const lines = [...res.lines].reverse();
    const results = lines.map((l, i): SearchResult => {
      const t = titleWithMarks(l.msg, q);
      const extra = [l.err?.message ?? "", JSON.stringify(l.data)].join(" ");
      const time = new Date(l.ts);
      const clock = Number.isNaN(time.getTime())
        ? ""
        : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return {
        id: `log:${l.id}`,
        scope: "logs",
        title: t.text,
        titleMarks: t.marks,
        detail: [capitalise(l.level), l.component, shortDate(l.ts), clock].filter(Boolean).join(" · "),
        snippet: t.marks.length ? null : snippetAround(extra, q),
        score: 0.5 - i * 0.01,
        target: { kind: "log", text: q, taskId: l.taskId },
      };
    });
    return { results: results.slice(0, r.limit + 1), more: lines.length > r.limit || res.next !== null };
  }
}

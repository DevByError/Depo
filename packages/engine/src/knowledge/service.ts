import fs from "node:fs";
import path from "node:path";
import { newId } from "@depo/shared";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../db";
import { knowledgePacks } from "../db/schema";
import type { EventBus } from "../events/bus";
import { type AgentTool, tool } from "../tools/index";
import { downloadGithubZip, type GithubEndpoints, parseGithubUrl } from "../util/github";
import { extractZip } from "../util/unzip";

export interface PackDto {
  id: string;
  name: string;
  version: string;
  kind: "docs" | "security" | "ux" | "custom";
  source: string;
  description: string;
  docCount: number;
  chunkCount: number;
  enabled: boolean;
  createdAt: string;
}

export interface KnowledgeHit {
  pack: string;
  version: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface CatalogEntry {
  id: string;
  name: string;
  kind: PackDto["kind"];
  description: string;
  /** GitHub folder with the documents. */
  url: string;
  extensions: string[];
  /** Tags and paths in this catalog were not checked against GitHub from the build machine. */
  verified: boolean;
  approxSizeMb: number;
}

/** Packs the user can install with one click (a GitHub download, started by the user). */
export const PACK_CATALOG: CatalogEntry[] = [
  {
    id: "owasp-cheatsheets",
    name: "OWASP Cheat Sheet Series",
    kind: "security",
    description: "Short, practical security guidance per topic.",
    url: "https://github.com/OWASP/CheatSheetSeries/tree/master/cheatsheets",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 3,
  },
  {
    id: "owasp-top10",
    name: "OWASP Top 10 (2021)",
    kind: "security",
    description: "The ten most critical web application risks.",
    url: "https://github.com/OWASP/Top10/tree/master/2021/docs/en",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 1,
  },
  {
    id: "owasp-asvs",
    name: "OWASP ASVS 4.0",
    kind: "security",
    description: "Application Security Verification Standard requirements.",
    url: "https://github.com/OWASP/ASVS/tree/master/4.0/en",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 1,
  },
  {
    id: "owasp-api-top10",
    name: "OWASP API Security Top 10 (2023)",
    kind: "security",
    description: "The ten most critical API risks.",
    url: "https://github.com/OWASP/API-Security/tree/master/editions/2023/en",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 1,
  },
  {
    id: "fastapi",
    name: "FastAPI documentation",
    kind: "docs",
    description: "FastAPI guides and reference.",
    url: "https://github.com/fastapi/fastapi/tree/master/docs/en/docs",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 8,
  },
  {
    id: "django",
    name: "Django documentation",
    kind: "docs",
    description: "Django topics, howtos and reference.",
    url: "https://github.com/django/django/tree/main/docs",
    extensions: [".txt", ".rst"],
    verified: false,
    approxSizeMb: 15,
  },
  {
    id: "react",
    name: "React documentation",
    kind: "docs",
    description: "Learn and reference sections of react.dev.",
    url: "https://github.com/reactjs/react.dev/tree/main/src/content",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 10,
  },
  {
    id: "nextjs",
    name: "Next.js documentation",
    kind: "docs",
    description: "Next.js guides and API reference.",
    url: "https://github.com/vercel/next.js/tree/canary/docs",
    extensions: [".md", ".mdx"],
    verified: false,
    approxSizeMb: 40,
  },
  {
    id: "typescript",
    name: "TypeScript handbook",
    kind: "docs",
    description: "The TypeScript handbook and reference.",
    url: "https://github.com/microsoft/TypeScript-Website/tree/v2/packages/documentation/copy/en",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 5,
  },
  {
    id: "nodejs",
    name: "Node.js API documentation",
    kind: "docs",
    description: "Node.js built-in module reference.",
    url: "https://github.com/nodejs/node/tree/main/doc/api",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 15,
  },
  {
    id: "mdn-web",
    name: "MDN Web Docs (web)",
    kind: "docs",
    description: "HTML, CSS, JavaScript and Web API reference. Large.",
    url: "https://github.com/mdn/content/tree/main/files/en-us/web",
    extensions: [".md"],
    verified: false,
    approxSizeMb: 250,
  },
  {
    id: "tailwind",
    name: "Tailwind CSS documentation",
    kind: "docs",
    description: "Utility classes and configuration.",
    url: "https://github.com/tailwindlabs/tailwindcss.com/tree/main/src/docs",
    extensions: [".mdx", ".md"],
    verified: false,
    approxSizeMb: 5,
  },
  {
    id: "wcag",
    name: "WCAG 2.2 understanding documents",
    kind: "ux",
    description: "What each WCAG success criterion means and how to meet it.",
    url: "https://github.com/w3c/wcag/tree/main/understanding",
    extensions: [".html"],
    verified: false,
    approxSizeMb: 5,
  },
];

const TEXT_EXT = [".md", ".mdx", ".markdown", ".txt", ".rst", ".html", ".htm", ".pdf"];
const MAX_DOC_BYTES = 6 * 1024 * 1024;
const CHUNK = 1400;

interface Chunk {
  title: string;
  text: string;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, n: string, t: string) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "")}\n`,
    )
    .replace(/<\/(p|div|li|tr|section|article|pre|ul|ol|table|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Split a document into passages that follow its headings, each at most ~1400 characters. */
export function chunkText(text: string, fallbackTitle: string): Chunk[] {
  const out: Chunk[] = [];
  let title = fallbackTitle;
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t.length > 20) out.push({ title, text: t });
    buf = [];
    size = 0;
  };
  for (const raw of text
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")) {
    const h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(raw);
    if (h) {
      flush();
      title = h[2] ?? title;
      buf.push(raw);
      size += raw.length;
      continue;
    }
    if (size + raw.length > CHUNK && raw.trim() === "") flush();
    else if (size > CHUNK * 1.6) flush();
    buf.push(raw);
    size += raw.length + 1;
  }
  flush();
  return out;
}

async function readDocument(file: string): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  if (fs.statSync(file).size > MAX_DOC_BYTES) return null;
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  const raw = fs.readFileSync(file, "utf8");
  if (ext === ".html" || ext === ".htm") return htmlToText(raw);
  return raw;
}

function ftsQuery(q: string): string {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((w) => !STOP.has(w)).slice(0, 12);
  return words.map((w) => `"${w}"`).join(" OR ");
}
const STOP = new Set([
  "the",
  "and",
  "for",
  "are",
  "with",
  "how",
  "what",
  "does",
  "this",
  "that",
  "from",
  "into",
  "can",
  "you",
  "use",
  "using",
  "should",
  "which",
  "when",
]);

/**
 * Knowledge packs: local, versioned document collections indexed for full-text search, so agents
 * work from current references offline and say which pack and version they used.
 */
export class KnowledgeService {
  private readonly sql;

  constructor(
    private readonly o: {
      db: AppDb;
      bus: EventBus;
      dir: string;
      github?: GithubEndpoints;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.sql = o.db.$client;
    fs.mkdirSync(o.dir, { recursive: true });
  }

  list(): PackDto[] {
    return this.o.db.select().from(knowledgePacks).orderBy(asc(knowledgePacks.name)).all().map(toDto);
  }

  catalog(): (CatalogEntry & { installed: boolean })[] {
    const names = new Set(this.list().map((p) => p.name));
    return PACK_CATALOG.map((c) => ({ ...c, installed: names.has(c.name) }));
  }

  /** Index a folder or a single file (Markdown, text, HTML, PDF, or a website export). */
  async importPath(input: {
    name: string;
    path: string;
    version?: string;
    description?: string;
    kind?: PackDto["kind"];
    extensions?: string[];
  }): Promise<PackDto> {
    const src = path.resolve(input.path);
    if (!fs.existsSync(src)) throw new Error(`Not found: ${input.path}`);
    const files: { abs: string; rel: string }[] = [];
    const exts = (input.extensions?.length ? input.extensions : TEXT_EXT).map((e) => e.toLowerCase());
    if (fs.statSync(src).isDirectory()) {
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (exts.includes(path.extname(e.name).toLowerCase()))
            files.push({ abs: full, rel: path.relative(src, full).replace(/\\/g, "/") });
        }
      };
      walk(src);
    } else {
      files.push({ abs: src, rel: path.basename(src) });
    }
    if (files.length === 0) throw new Error("No documents (.md, .txt, .html, .pdf) were found there.");
    return this.indexFiles({ ...input, source: src }, files);
  }

  async installFromCatalog(id: string): Promise<PackDto> {
    const c = PACK_CATALOG.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown pack: ${id}`);
    const gh = parseGithubUrl(c.url);
    if (!gh) throw new Error("Bad catalog address.");
    const stage = path.join(this.o.dir, ".staging", newId("kpk"));
    const zip = `${stage}.zip`;
    try {
      const { commit } = await downloadGithubZip(gh, zip, {
        ...(this.o.github ? { endpoints: this.o.github } : {}),
        ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      });
      const prefix = gh.subpath ? `${gh.subpath.replace(/^\/|\/$/g, "")}/` : "";
      extractZip(zip, stage, {
        strip: 1,
        filter: (name) => {
          const inner = name.split("/").slice(1).join("/");
          return inner.startsWith(prefix) && c.extensions.includes(path.extname(inner).toLowerCase());
        },
        maxFiles: 20_000,
        maxTotalBytes: 600 * 1024 * 1024,
      });
      const root = path.join(stage, prefix);
      if (!fs.existsSync(root))
        throw new Error(
          `No documents found at ${gh.subpath || "the repository root"}. The catalog path may have moved.`,
        );
      return await this.importPath({
        name: c.name,
        path: root,
        version: commit ? commit.slice(0, 10) : (gh.ref ?? "latest"),
        description: c.description,
        kind: c.kind,
        extensions: c.extensions,
      });
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  private async indexFiles(
    meta: { name: string; source: string; version?: string; description?: string; kind?: PackDto["kind"] },
    files: { abs: string; rel: string }[],
  ): Promise<PackDto> {
    const name = meta.name.trim();
    if (!name) throw new Error("Give the pack a name.");
    const version = meta.version?.trim() || new Date().toISOString().slice(0, 10);
    // Re-importing a pack replaces its older version.
    const old = this.o.db.select().from(knowledgePacks).where(eq(knowledgePacks.name, name)).get();
    const id = old?.id ?? newId("kpk");
    if (old) this.sql.query("DELETE FROM knowledge_fts WHERE pack_id = ?").run(id);
    const insert = this.sql.query(
      "INSERT INTO knowledge_fts (text, title, path, pack_id) VALUES (?, ?, ?, ?)",
    );
    let docs = 0;
    let chunks = 0;
    const batch: [string, string, string][] = [];
    for (const f of files) {
      let text: string | null = null;
      try {
        text = await readDocument(f.abs);
      } catch {
        text = null;
      }
      if (!text?.trim()) continue;
      docs++;
      for (const c of chunkText(text, path.basename(f.rel, path.extname(f.rel))))
        batch.push([c.text, c.title, f.rel]);
    }
    if (docs === 0) throw new Error("None of those files had readable text.");
    const tx = this.sql.transaction(() => {
      for (const [t, ti, p] of batch) {
        insert.run(t, ti, p, id);
        chunks++;
      }
    });
    tx();
    const now = new Date().toISOString();
    const values = {
      name,
      version,
      kind: meta.kind ?? "custom",
      source: meta.source,
      description: meta.description ?? "",
      docCount: docs,
      chunkCount: chunks,
      updatedAt: now,
    };
    if (old) this.o.db.update(knowledgePacks).set(values).where(eq(knowledgePacks.id, id)).run();
    else
      this.o.db
        .insert(knowledgePacks)
        .values({ id, enabled: 1, createdAt: now, ...values })
        .run();
    this.o.bus.emit({
      agent: "engine",
      type: "info",
      text: `Knowledge pack "${name}" ${version}: ${docs} documents, ${chunks} passages`,
      details: { pack: name, docs, chunks },
      status: "succeeded",
    });
    return this.get(id);
  }

  get(id: string): PackDto {
    const r = this.o.db.select().from(knowledgePacks).where(eq(knowledgePacks.id, id)).get();
    if (!r) throw new Error(`Unknown knowledge pack: ${id}`);
    return toDto(r);
  }

  setEnabled(id: string, enabled: boolean): PackDto {
    this.get(id);
    this.o.db
      .update(knowledgePacks)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(knowledgePacks.id, id))
      .run();
    return this.get(id);
  }

  remove(id: string): { ok: true } {
    this.get(id);
    this.sql.query("DELETE FROM knowledge_fts WHERE pack_id = ?").run(id);
    this.o.db.delete(knowledgePacks).where(eq(knowledgePacks.id, id)).run();
    return { ok: true };
  }

  search(query: string, opts: { limit?: number; pack?: string } = {}): KnowledgeHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const packs = new Map(
      this.o.db
        .select()
        .from(knowledgePacks)
        .where(eq(knowledgePacks.enabled, 1))
        .all()
        .map((p) => [p.id, p]),
    );
    if (packs.size === 0) return [];
    const rows = this.sql
      .query<
        { text: string; title: string; path: string; pack_id: string; score: number; snip: string },
        [string, number]
      >(
        "SELECT text, title, path, pack_id, bm25(knowledge_fts, 1.0, 3.0) AS score, snippet(knowledge_fts, 0, '[', ']', ' … ', 24) AS snip FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?",
      )
      .all(q, (opts.limit ?? 6) * 6);
    const wanted = opts.pack?.toLowerCase();
    const hits: KnowledgeHit[] = [];
    for (const r of rows) {
      const p = packs.get(r.pack_id);
      if (!p) continue;
      if (wanted && !p.name.toLowerCase().includes(wanted)) continue;
      hits.push({
        pack: p.name,
        version: p.version,
        path: r.path,
        title: r.title,
        snippet: r.text.length > 900 ? r.snip : r.text,
        score: -r.score,
      });
      if (hits.length >= (opts.limit ?? 6)) break;
    }
    return hits;
  }

  /** The search tool agents get when at least one pack is installed. */
  extrasFor(): { tools: AgentTool<z.ZodType>[]; allow: string[]; prompt: string } {
    const packs = this.list().filter((p) => p.enabled);
    if (packs.length === 0) return { tools: [], allow: [], prompt: "" };
    const self = this;
    const t = tool({
      name: "search_knowledge",
      description:
        "Search the installed documentation packs (offline) for current, authoritative answers. Results name the pack and version: say which you used.",
      schema: z.object({
        query: z.string().min(2).max(300),
        pack: z.string().max(80).optional().describe("Only this pack (part of its name)"),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      async run(a, ctx) {
        const hits = self.search(a.query, { limit: a.limit, ...(a.pack ? { pack: a.pack } : {}) });
        ctx.bus.emit({
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          agent: ctx.agent,
          type: "searching",
          text: `Knowledge search "${a.query}": ${hits.length} passages`,
          details: { hits: hits.length, packs: [...new Set(hits.map((h) => `${h.pack} ${h.version}`))] },
          status: "succeeded",
        });
        if (!hits.length) return "Nothing found in the knowledge packs.";
        return hits.map((h) => `[${h.pack} ${h.version}] ${h.path} — ${h.title}\n${h.snippet}`).join("\n\n");
      },
    });
    return {
      tools: [t],
      allow: [t.name],
      prompt: `# Knowledge packs\nOffline references are installed: ${packs.map((p) => `${p.name} ${p.version}`).join("; ")}. Use search_knowledge before relying on memory for APIs, versions or security rules, and name the pack you used.`,
    };
  }
}

function toDto(r: typeof knowledgePacks.$inferSelect): PackDto {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    kind: r.kind as PackDto["kind"],
    source: r.source,
    description: r.description,
    docCount: r.docCount,
    chunkCount: r.chunkCount,
    enabled: r.enabled === 1,
    createdAt: r.createdAt,
  };
}

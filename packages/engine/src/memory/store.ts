import fs from "node:fs";
import path from "node:path";
import { type JsonValue, type MemoryFact, MemoryFactSchema, type MemoryKind, newId } from "@depo/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppDb } from "../db";
import { memoryFacts } from "../db/schema";
import type { EventBus } from "../events/bus";

const GLOBAL_DIR = "_global";

/**
 * Project memory (a Markdown file the user and agents can edit, plus structured facts),
 * global memory (preferences for every project) and lessons learned from fix loops.
 */
export class MemoryStore {
  constructor(
    private readonly db: AppDb,
    private readonly bus: EventBus,
    private readonly projectsDir: string,
  ) {}

  // ---- Markdown ------------------------------------------------------------------------------

  markdownPath(projectId: string | null): string {
    return projectId
      ? path.join(this.projectsDir, projectId, "project-memory.md")
      : path.join(this.projectsDir, GLOBAL_DIR, "global-memory.md");
  }

  getMarkdown(projectId: string | null): string {
    try {
      return fs.readFileSync(this.markdownPath(projectId), "utf8");
    } catch {
      return "";
    }
  }

  setMarkdown(projectId: string | null, markdown: string, by: "user" | "agent" = "user"): void {
    const file = this.markdownPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, markdown.replace(/\r\n/g, "\n"));
    fs.renameSync(tmp, file);
    this.changed(projectId, by === "user" ? "Memory edited" : "Memory updated by an agent");
  }

  /** Starting memory for a new project, from what the user told the wizard. */
  initProject(projectId: string, info: { name: string; description: string; stack: string }): void {
    if (this.getMarkdown(projectId)) return;
    const lines = [
      `# ${info.name}`,
      "",
      "Project memory. Agents read this at the start of every task. Edit it freely.",
      "",
      "## About",
      info.description.trim() || "(not described yet)",
      "",
      "## Stack",
      info.stack.trim() || "Let the agents decide.",
      "",
      "## Conventions",
      "",
      "## Decisions",
      "",
    ];
    const file = this.markdownPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n"));
  }

  copyProject(fromId: string, toId: string): void {
    const md = this.getMarkdown(fromId);
    if (md) {
      const file = this.markdownPath(toId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, md);
    }
    for (const f of this.list(fromId)) this.add(toId, f.kind, f.text, f.source, f.signature);
  }

  removeProject(projectId: string): void {
    fs.rmSync(path.join(this.projectsDir, projectId), { recursive: true, force: true });
  }

  // ---- facts ---------------------------------------------------------------------------------

  list(projectId: string | null, kinds?: MemoryKind[]): MemoryFact[] {
    const rows = this.db
      .select()
      .from(memoryFacts)
      .where(projectId ? eq(memoryFacts.projectId, projectId) : isNull(memoryFacts.projectId))
      .orderBy(desc(memoryFacts.updatedAt))
      .all();
    return rows.map(toFact).filter((f) => !kinds || kinds.includes(f.kind));
  }

  add(
    projectId: string | null,
    kind: MemoryKind,
    text: string,
    source: MemoryFact["source"] = "user",
    signature: string | null = null,
  ): MemoryFact {
    const now = new Date().toISOString();
    const id = newId("mem");
    this.db
      .insert(memoryFacts)
      .values({
        id,
        projectId,
        kind,
        text: text.trim(),
        signature,
        source,
        uses: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.changed(projectId, `Remembered: ${text.trim().slice(0, 120)}`);
    return this.getFact(id);
  }

  update(id: string, text: string): MemoryFact {
    const fact = this.getFact(id);
    this.db
      .update(memoryFacts)
      .set({ text: text.trim(), updatedAt: new Date().toISOString() })
      .where(eq(memoryFacts.id, id))
      .run();
    this.changed(fact.projectId, "Memory edited");
    return this.getFact(id);
  }

  remove(id: string): void {
    const fact = this.getFact(id);
    this.db.delete(memoryFacts).where(eq(memoryFacts.id, id)).run();
    this.changed(fact.projectId, "Memory item removed");
  }

  getFact(id: string): MemoryFact {
    const row = this.db.select().from(memoryFacts).where(eq(memoryFacts.id, id)).get();
    if (!row) throw new Error(`Unknown memory item: ${id}`);
    return toFact(row);
  }

  // ---- remembered by itself (memory.auto) ----------------------------------------------------

  /**
   * Save an item Depo found by itself, without an event per item (the caller announces a summary).
   * With a key (e.g. "auto:test-command") the keyed item is updated in place. Otherwise an item
   * that says the same thing as an existing one (same normalised text, or token overlap of 80% or
   * more) is not added again: an auto item is refreshed with the new wording, anything the user or
   * an agent wrote is left as it is. A change of case or punctuation only counts as unchanged.
   */
  upsertAuto(
    projectId: string,
    kind: Exclude<MemoryKind, "lesson">,
    text: string,
    key: string | null = null,
  ): { fact: MemoryFact; change: "added" | "updated" | "unchanged" } {
    const clean = text.trim();
    const existing = this.list(projectId, ["fact", "decision", "preference"]);
    const now = new Date().toISOString();
    const same =
      (key ? existing.find((f) => f.signature === key) : undefined) ??
      existing.find((f) => isDuplicate(f.text, clean) && (!key || !f.signature?.startsWith("auto:")));
    if (same) {
      // Only auto items are refreshed, and only when the wording really changed (not case or punctuation).
      if (same.source !== "auto" || normalizeMemoryText(same.text) === normalizeMemoryText(clean))
        return { fact: same, change: "unchanged" };
      this.db
        .update(memoryFacts)
        .set({ text: clean, kind, updatedAt: now })
        .where(eq(memoryFacts.id, same.id))
        .run();
      return { fact: this.getFact(same.id), change: "updated" };
    }
    const id = newId("mem");
    this.db
      .insert(memoryFacts)
      .values({
        id,
        projectId,
        kind,
        text: clean,
        signature: key,
        source: "auto",
        uses: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { fact: this.getFact(id), change: "added" };
  }

  /** Remove a keyed auto item (a fact that no longer holds, e.g. after the changes were discarded). */
  removeAutoKey(projectId: string, key: string): boolean {
    const row = this.list(projectId).find((f) => f.signature === key && f.source === "auto");
    if (!row) return false;
    this.db.delete(memoryFacts).where(eq(memoryFacts.id, row.id)).run();
    return true;
  }

  /** Keep at most `max` auto items per project: the oldest go first. User and agent items stay. */
  pruneAuto(projectId: string, max: number): number {
    const auto = this.list(projectId).filter((f) => f.source === "auto");
    const extra = auto.slice(max);
    for (const f of extra) this.db.delete(memoryFacts).where(eq(memoryFacts.id, f.id)).run();
    return extra.length;
  }

  /** One memory_updated event for the activity feed and the Memory panel. */
  announce(projectId: string | null, text: string, details: Record<string, JsonValue> = {}): void {
    this.bus.emit({
      projectId,
      agent: "engine",
      type: "memory_updated",
      text,
      details: { scope: projectId ? "project" : "global", ...details },
      status: "succeeded",
    });
  }

  // ---- lessons learned -----------------------------------------------------------------------

  /** Store how a failing check was fixed. A lesson with the same signature is refreshed, not duplicated. */
  recordLesson(projectId: string, errorText: string, solution: string): MemoryFact | null {
    const signature = errorSignature(errorText);
    if (!signature) return null;
    const existing = this.db
      .select()
      .from(memoryFacts)
      .where(and(eq(memoryFacts.projectId, projectId), eq(memoryFacts.signature, signature)))
      .get();
    const text = `When "${signature}" appears: ${solution.trim().slice(0, 600)}`;
    if (existing) {
      this.db
        .update(memoryFacts)
        .set({ text, uses: existing.uses + 1, updatedAt: new Date().toISOString() })
        .where(eq(memoryFacts.id, existing.id))
        .run();
      return this.getFact(existing.id);
    }
    return this.add(projectId, "lesson", text, "system", signature);
  }

  /** Lessons whose error signature appears in this output (this project first, then any project). */
  findLessons(projectId: string, output: string, limit = 3): MemoryFact[] {
    const sig = errorSignature(output);
    if (!sig) return [];
    const all = this.db.select().from(memoryFacts).where(eq(memoryFacts.kind, "lesson")).all().map(toFact);
    const hits = all.filter((f) => f.signature && (sig.includes(f.signature) || f.signature.includes(sig)));
    hits.sort(
      (a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId) || b.uses - a.uses,
    );
    return hits.slice(0, limit);
  }

  // ---- prompt context ------------------------------------------------------------------------

  /** Memory block for an agent's system prompt, trimmed to a character budget. */
  contextFor(projectId: string, budgetChars = 6000): string {
    const parts: string[] = [];
    const projectMd = this.getMarkdown(projectId).trim();
    if (projectMd) parts.push(`## Project memory\n${projectMd}`);
    const facts = this.list(projectId, ["fact", "decision", "preference"]);
    if (facts.length) parts.push(`## Project facts\n${facts.map((f) => `- ${f.text}`).join("\n")}`);
    const lessons = this.list(projectId, ["lesson"]).slice(0, 8);
    if (lessons.length) parts.push(`## Lessons learned\n${lessons.map((f) => `- ${f.text}`).join("\n")}`);
    const globalMd = this.getMarkdown(null).trim();
    if (globalMd) parts.push(`## The user's general preferences\n${globalMd}`);
    const globalFacts = this.list(null);
    if (globalFacts.length) parts.push(globalFacts.map((f) => `- ${f.text}`).join("\n"));
    let text = parts.join("\n\n");
    if (text.length > budgetChars) text = `${text.slice(0, budgetChars)}\n(memory shortened to fit)`;
    return text;
  }

  private changed(projectId: string | null, text: string) {
    this.bus.emit({
      projectId,
      agent: "engine",
      type: "memory_updated",
      text,
      details: { scope: projectId ? "project" : "global" },
      status: "succeeded",
    });
  }
}

function toFact(r: typeof memoryFacts.$inferSelect): MemoryFact {
  return MemoryFactSchema.parse({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    text: r.text,
    signature: r.signature,
    source: r.source,
    uses: r.uses,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** Lower-case words and numbers only, accents removed: "Uses Postgres!" and "uses postgres" match. */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Token overlap (Jaccard) of two texts after normalising: 1 = the same words. */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(normalizeMemoryText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeMemoryText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both);
}

/** Do two memory items say the same thing? Same normalised text, or 80% or more word overlap. */
export function isDuplicate(a: string, b: string): boolean {
  const na = normalizeMemoryText(a);
  return na === normalizeMemoryText(b) || tokenJaccard(a, b) >= 0.8;
}

/**
 * A stable fingerprint of the first real error in some output: the error line with paths,
 * numbers, quoted values and addresses removed, so the same problem matches next time.
 */
export function errorSignature(output: string): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const line =
    lines.find((l) => /^(E\s+)?\w*(Error|Exception)\b[:(]/.test(l)) ??
    lines.find((l) => /\b(error|exception)\b/i.test(l) && !/^\d+ (passed|failed)/.test(l)) ??
    lines.find((l) => /\bFAILED\b|\bfailed\b/.test(l));
  if (!line) return null;
  const sig = line
    .replace(/^E\s+/, "")
    .replace(/(["'`]).*?\1/g, "…")
    .replace(/[A-Za-z]:\\[^\s:]+|\/[^\s:]+\/[^\s:]*/g, "…")
    .replace(/0x[0-9a-f]+/gi, "…")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160);
  return sig.length >= 8 ? sig : null;
}

import {
  type AgentManifest,
  type AgentMessage,
  AgentMessageSchema,
  type BlackboardEntry,
  newId,
} from "@depo/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { agentMessages, blackboard, blackboardHistory } from "../db/schema";

const MAX_SECTION = 120_000;

/** Sections every agent may append to. */
const SHARED_SECTIONS = ["decisions.md"];

/** May this agent write this section? A manifest entry ending in `/` covers a whole folder. */
export function mayWrite(manifest: AgentManifest, section: string): boolean {
  if (SHARED_SECTIONS.includes(section)) return true;
  return manifest.writes.some((w) => (w.endsWith("/") ? section.startsWith(w) : section === w));
}

/** Section names are relative, forward-slash paths without tricks. */
export function cleanSection(raw: string): string {
  const s = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
  if (!s || s.length > 200 || s.split("/").some((p) => p === ".." || p === "" || p === ".")) {
    throw new Error(`Invalid blackboard section name: ${raw}`);
  }
  if (!/^[\w./ -]+$/.test(s)) throw new Error(`Invalid blackboard section name: ${raw}`);
  return s;
}

/**
 * The project blackboard: a shared, versioned store of notes and contracts (brief, plan, design
 * system, OpenAPI, schema, reviews, decisions). Agents read what they need and write only to
 * the sections they own. Every change keeps the old version.
 */
export class Blackboard {
  constructor(private readonly db: AppDb) {}

  list(projectId: string): BlackboardEntry[] {
    return this.db
      .select()
      .from(blackboard)
      .where(eq(blackboard.projectId, projectId))
      .orderBy(asc(blackboard.section))
      .all()
      .map(toEntry);
  }

  read(projectId: string, section: string): BlackboardEntry | null {
    const r = this.db
      .select()
      .from(blackboard)
      .where(and(eq(blackboard.projectId, projectId), eq(blackboard.section, section)))
      .get();
    return r ? toEntry(r) : null;
  }

  write(
    projectId: string,
    section: string,
    content: string,
    owner: string,
    taskId: string | null,
    mode: "replace" | "append" = "replace",
  ): BlackboardEntry {
    const name = cleanSection(section);
    const prev = this.read(projectId, name);
    let text = mode === "append" && prev ? `${prev.content.trimEnd()}\n\n${content}` : content;
    if (text.length > MAX_SECTION) text = text.slice(-MAX_SECTION);
    const now = new Date().toISOString();
    const version = (prev?.version ?? 0) + 1;
    this.db
      .insert(blackboard)
      .values({
        projectId,
        section: name,
        content: text,
        version,
        owner,
        taskId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [blackboard.projectId, blackboard.section],
        set: { content: text, version, owner, taskId, updatedAt: now },
      })
      .run();
    this.db
      .insert(blackboardHistory)
      .values({ projectId, section: name, version, content: text, owner, taskId, createdAt: now })
      .run();
    return { section: name, owner, version, updatedAt: now, content: text };
  }

  history(projectId: string, section: string): { version: number; owner: string; createdAt: string }[] {
    return this.db
      .select()
      .from(blackboardHistory)
      .where(and(eq(blackboardHistory.projectId, projectId), eq(blackboardHistory.section, section)))
      .orderBy(desc(blackboardHistory.version))
      .all()
      .map((h) => ({ version: h.version, owner: h.owner, createdAt: h.createdAt }));
  }

  /** A compact digest of the blackboard for an agent's prompt (names, owners, and short heads). */
  digest(projectId: string, budget: number, sections?: string[]): string {
    const out: string[] = [];
    let used = 0;
    for (const e of this.list(projectId)) {
      if (e.section === "plan.json") continue;
      if (sections && !sections.some((s) => (s.endsWith("/") ? e.section.startsWith(s) : e.section === s)))
        continue;
      const head =
        e.content.length > 700 ? `${e.content.slice(0, 700)}\n[…read the rest with bb_read]` : e.content;
      const block = `## ${e.section} (v${e.version}, by ${e.owner})\n${head}`;
      if (used + block.length > budget) {
        out.push(`## ${e.section} (v${e.version}, by ${e.owner}) [read with bb_read]`);
        continue;
      }
      out.push(block);
      used += block.length;
    }
    return out.join("\n\n");
  }

  // ---- typed messages --------------------------------------------------------------------

  addMessage(m: Omit<AgentMessage, "id" | "createdAt">): AgentMessage {
    const msg = AgentMessageSchema.parse({ ...m, id: newId("amsg"), createdAt: new Date().toISOString() });
    this.db
      .insert(agentMessages)
      .values({
        id: msg.id,
        taskId: msg.taskId,
        fromAgent: msg.from,
        toAgent: msg.to,
        type: msg.type,
        summary: msg.summary,
        artifacts: JSON.stringify(msg.artifacts),
        criteria: JSON.stringify(msg.criteria),
        confidence: msg.confidence,
        createdAt: msg.createdAt,
        updatedAt: msg.createdAt,
      })
      .run();
    return msg;
  }

  messages(taskId: string): AgentMessage[] {
    return this.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.taskId, taskId))
      .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
      .all()
      .map((r) =>
        AgentMessageSchema.parse({
          id: r.id,
          taskId: r.taskId,
          from: r.fromAgent,
          to: r.toAgent,
          type: r.type,
          summary: r.summary,
          artifacts: JSON.parse(r.artifacts),
          criteria: JSON.parse(r.criteria),
          confidence: r.confidence,
          createdAt: r.createdAt,
        }),
      );
  }
}

function toEntry(r: typeof blackboard.$inferSelect): BlackboardEntry {
  return {
    section: r.section,
    owner: r.owner,
    version: r.version,
    updatedAt: r.updatedAt,
    content: r.content,
  };
}

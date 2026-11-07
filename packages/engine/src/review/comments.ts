import {
  type ChangeSet,
  type DiffSide,
  type FileChange,
  newId,
  type ReviewComment,
  ReviewCommentSchema,
} from "@depo/shared";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AppDb } from "../db";
import { changeSets, reviewComments } from "../db/schema";
import type { EventBus } from "../events/bus";

/**
 * Pull-request style review of a change set: line comments that survive reloads, "Request changes"
 * (one follow-up to the same task with every open comment), and bookkeeping when the agent's next
 * change set arrives: a comment whose lines are gone is addressed, one whose lines are still there
 * moves to the new change set, and the agent can say "Addressed: 1, 3".
 */

/** A diff row: `t` is "+", "-" or " "; `o`/`n` are its line numbers in the old and new file. */
export interface DiffRow {
  hunk: number;
  t: string;
  text: string;
  o: number | null;
  n: number | null;
}

export interface RowKey {
  side: DiffSide;
  line: number;
}

/** The rows of a file's diff, in order (the same numbering as the Diff Review screen). */
export function diffRows(f: Pick<FileChange, "hunks">): DiffRow[] {
  const rows: DiffRow[] = [];
  f.hunks.forEach((h, hunk) => {
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith("\\")) continue;
      const t = l[0] ?? " ";
      rows.push({
        hunk,
        t,
        text: l.slice(1).replace(/\r$/, ""),
        o: t === "+" ? null : o,
        n: t === "-" ? null : n,
      });
      if (t !== "+") o++;
      if (t !== "-") n++;
    }
  });
  return rows;
}

/** Removed rows are found by their old line, the others by their new line. */
export function rowKey(r: DiffRow): RowKey {
  return r.t === "-" ? { side: "old", line: r.o ?? 0 } : { side: "new", line: r.n ?? 0 };
}

const sameKey = (r: DiffRow, k: RowKey) =>
  k.side === "old" ? r.t === "-" && r.o === k.line : r.t !== "-" && r.n === k.line;
const rowText = (r: DiffRow) => `${r.t}${r.text}`;

const MAX_QUOTE_ROWS = 40;
/** Rows of a quote that go into the follow-up message (small models, small contexts). */
const MESSAGE_QUOTE_ROWS = 12;
const MAX_COMMENTS_PER_REQUEST = 30;
const MAX_COMMENTS_PER_SET = 200;

/** "app/main.py:12", "app/main.py:12-14", or "app/main.py:7 (removed)". */
export function locationLabel(
  c: Pick<ReviewComment, "path" | "side" | "line" | "endSide" | "endLine">,
): string {
  const news = [c.side === "new" ? c.line : null, c.endSide === "new" ? c.endLine : null].filter(
    (x): x is number => x !== null,
  );
  if (news.length > 0) {
    const a = Math.min(...news);
    const b = Math.max(...news);
    return `${c.path}:${a === b ? a : `${a}-${b}`}`;
  }
  const a = Math.min(c.line, c.endLine);
  const b = Math.max(c.line, c.endLine);
  return `${c.path}:${a === b ? a : `${a}-${b}`} (removed)`;
}

/** Numbers the agent says it handled: "Addressed: 1, 3 and 4" (any line of its replies). */
export function addressedRefs(texts: string[]): Set<number> {
  const out = new Set<number>();
  const re = /\baddressed(?:\s+comments?)?\s*[:-]\s*((?:#?\d+\s*(?:,|and|&)?\s*)+)/gi;
  for (const t of texts) {
    for (const m of t.matchAll(re)) {
      for (const d of (m[1] ?? "").match(/\d+/g) ?? []) out.add(Number(d));
    }
  }
  return out;
}

/** A fence longer than any run of backticks in the text, so quoted code cannot close it. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

export interface ReviewHost {
  db: AppDb;
  bus: EventBus;
  /** Load a change set (throws when unknown). */
  changeSet(id: string): ChangeSet;
  /** Send text to the task: a steering note while it works, otherwise a follow-up. */
  deliver(taskId: string, text: string): "queued" | "followup";
}

export class ReviewStore {
  constructor(private readonly h: ReviewHost) {}

  /** Comments shown on a change set, and the ones a newer version addressed or made outdated. */
  list(changeSetId: string): ReviewComment[] {
    return this.h.db
      .select()
      .from(reviewComments)
      .where(or(eq(reviewComments.changeSetId, changeSetId), eq(reviewComments.addressedIn, changeSetId)))
      .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
      .all()
      .map(toComment);
  }

  get(id: string): ReviewComment {
    const row = this.h.db.select().from(reviewComments).where(eq(reviewComments.id, id)).get();
    if (!row) throw new Error("This comment no longer exists.");
    return toComment(row);
  }

  add(p: {
    changeSetId: string;
    path: string;
    start: RowKey;
    end?: RowKey | undefined;
    body: string;
  }): ReviewComment {
    const cs = this.h.changeSet(p.changeSetId);
    const file = cs.files.find((f) => f.path === p.path);
    if (!file) throw new Error(`${p.path} is not part of this change set.`);
    if (file.binary) throw new Error("Binary files cannot have line comments.");
    const count = this.h.db
      .select({ id: reviewComments.id })
      .from(reviewComments)
      .where(eq(reviewComments.changeSetId, cs.id))
      .all().length;
    if (count >= MAX_COMMENTS_PER_SET) throw new Error("This change set has too many comments already.");
    const rows = diffRows(file);
    let a = rows.findIndex((r) => sameKey(r, p.start));
    let b = p.end ? rows.findIndex((r) => sameKey(r, p.end as RowKey)) : a;
    if (a < 0 || b < 0) throw new Error("That line is not part of the diff.");
    if (b < a) [a, b] = [b, a];
    if (rows[a]?.hunk !== rows[b]?.hunk) throw new Error("A comment can cover lines of one change only.");
    const picked = rows.slice(a, b + 1);
    if (picked.length > MAX_QUOTE_ROWS) throw new Error(`Select at most ${MAX_QUOTE_ROWS} lines.`);
    const first = rowKey(picked[0] as DiffRow);
    const last = rowKey(picked.at(-1) as DiffRow);
    const now = new Date().toISOString();
    const id = newId("rvc");
    this.h.db
      .insert(reviewComments)
      .values({
        id,
        projectId: cs.projectId,
        taskId: cs.taskId,
        changeSetId: cs.id,
        path: file.path,
        side: first.side,
        line: first.line,
        endSide: last.side,
        endLine: last.line,
        quote: picked.map(rowText).join("\n"),
        body: p.body,
        status: "open",
        addressedBy: null,
        addressedIn: null,
        sentAt: null,
        ref: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id);
  }

  update(
    id: string,
    p: { body?: string | undefined; status?: "open" | "addressed" | undefined },
  ): ReviewComment {
    const c = this.get(id);
    const set: Partial<typeof reviewComments.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (p.body !== undefined) set.body = p.body;
    if (p.status === "addressed" && c.status !== "addressed") {
      set.status = "addressed";
      set.addressedBy = "owner";
    } else if (p.status === "open" && c.status !== "open") {
      // Reopened: it shows on the change set it was addressed in, if that one is newer.
      set.status = "open";
      set.addressedBy = null;
      if (c.addressedIn) set.changeSetId = c.addressedIn;
      set.addressedIn = null;
    }
    this.h.db.update(reviewComments).set(set).where(eq(reviewComments.id, id)).run();
    return this.get(id);
  }

  remove(id: string): boolean {
    const found = this.h.db
      .select({ id: reviewComments.id })
      .from(reviewComments)
      .where(eq(reviewComments.id, id))
      .get();
    if (!found) return false;
    this.h.db.delete(reviewComments).where(eq(reviewComments.id, id)).run();
    return true;
  }

  /**
   * Send every open comment of the change set to its task as one message: `path:line`, the quoted
   * code and the comment, numbered so the agent can answer "Addressed: 1, 3".
   */
  requestChanges(
    changeSetId: string,
    note?: string,
  ): { taskId: string; sent: number; delivery: "queued" | "followup" } {
    const cs = this.h.changeSet(changeSetId);
    if (!cs.taskId) throw new Error("These changes do not belong to a task, so there is no agent to ask.");
    if (cs.status !== "pending" && cs.status !== "partially_applied")
      throw new Error("Only changes that wait for review can be sent back.");
    const open = this.h.db
      .select()
      .from(reviewComments)
      .where(and(eq(reviewComments.changeSetId, cs.id), eq(reviewComments.status, "open")))
      .orderBy(asc(reviewComments.path), asc(reviewComments.createdAt))
      .all()
      .map(toComment);
    const extra = note?.trim() ?? "";
    if (open.length === 0 && !extra) throw new Error("Add a comment first, or say what should change.");
    const sending = open.slice(0, MAX_COMMENTS_PER_REQUEST);
    const text = requestMessage(sending, extra, open.length - sending.length);
    const now = new Date().toISOString();
    sending.forEach((c, i) => {
      this.h.db
        .update(reviewComments)
        .set({ sentAt: now, ref: i + 1, updatedAt: now })
        .where(eq(reviewComments.id, c.id))
        .run();
    });
    const delivery = this.h.deliver(cs.taskId, text);
    this.h.bus.emit({
      agent: "user",
      projectId: cs.projectId,
      taskId: cs.taskId,
      type: "info",
      text:
        sending.length > 0
          ? `Asked for changes: ${sending.length} comment${sending.length === 1 ? "" : "s"} on ${cs.title}`
          : `Asked for changes on ${cs.title}`,
      details: { changeSetId: cs.id, comments: sending.length, delivery },
      status: "info",
    });
    return { taskId: cs.taskId, sent: sending.length, delivery };
  }

  /**
   * The task produced a new change set (or none): comments the agent says it handled, and those
   * whose lines are gone, are addressed; unsent ones whose lines are gone are outdated; the rest
   * move to the new change set. `replies` are the agent's messages since the last request.
   */
  onChangeSet(taskId: string, next: ChangeSet | null, replies: string[]): number {
    const older = this.h.db
      .select({ id: changeSets.id })
      .from(changeSets)
      .where(eq(changeSets.taskId, taskId))
      .all()
      .map((r) => r.id)
      .filter((id) => id !== next?.id);
    if (older.length === 0) return 0;
    const open = this.h.db
      .select()
      .from(reviewComments)
      .where(and(inArray(reviewComments.changeSetId, older), eq(reviewComments.status, "open")))
      .all()
      .map(toComment);
    if (open.length === 0) return 0;
    const lastSent = open.reduce<string | null>(
      (m, c) => (c.sentAt && (!m || c.sentAt > m) ? c.sentAt : m),
      null,
    );
    const said = addressedRefs(replies);
    const now = new Date().toISOString();
    let addressed = 0;
    for (const c of open) {
      const set = (v: Partial<typeof reviewComments.$inferInsert>) =>
        this.h.db
          .update(reviewComments)
          .set({ ...v, updatedAt: now })
          .where(eq(reviewComments.id, c.id))
          .run();
      if (c.sentAt && c.sentAt === lastSent && c.ref !== null && said.has(c.ref)) {
        set({ status: "addressed", addressedBy: "agent", addressedIn: next?.id ?? null });
        addressed++;
        continue;
      }
      const found = next ? findQuote(next, c) : null;
      if (found && next) {
        set({
          changeSetId: next.id,
          side: found.start.side,
          line: found.start.line,
          endSide: found.end.side,
          endLine: found.end.line,
        });
      } else if (c.sentAt) {
        set({ status: "addressed", addressedBy: "changed", addressedIn: next?.id ?? null });
        addressed++;
      } else {
        set({ status: "outdated", addressedIn: next?.id ?? null });
      }
    }
    if (addressed > 0) {
      const cs = next ?? this.h.changeSet(older.at(-1) as string);
      this.h.bus.emit({
        agent: "engine",
        projectId: cs.projectId,
        taskId,
        type: "info",
        text: `${addressed} review comment${addressed === 1 ? "" : "s"} addressed`,
        details: { changeSetId: next?.id ?? null, addressed },
        status: "succeeded",
      });
    }
    return addressed;
  }
}

/** Where the quoted rows are in a newer change set, if they are still there unchanged. */
function findQuote(cs: ChangeSet, c: ReviewComment): { start: RowKey; end: RowKey } | null {
  const file = cs.files.find((f) => f.path === c.path);
  if (!file || file.binary) return null;
  const want = c.quote.split("\n");
  const rows = diffRows(file);
  for (let i = 0; i + want.length <= rows.length; i++) {
    if (rows[i]?.hunk !== rows[i + want.length - 1]?.hunk) continue;
    if (want.every((w, k) => rowText(rows[i + k] as DiffRow) === w)) {
      return { start: rowKey(rows[i] as DiffRow), end: rowKey(rows[i + want.length - 1] as DiffRow) };
    }
  }
  return null;
}

/** The follow-up the agent reads: numbered comments with their place and code, then the owner's note. */
export function requestMessage(comments: ReviewComment[], note: string, more = 0): string {
  const parts: string[] = [];
  if (comments.length > 0) {
    parts.push(
      `Please revise your changes. I left ${comments.length} review comment${comments.length === 1 ? "" : "s"} on the diff:`,
    );
    comments.forEach((c, i) => {
      const rows = c.quote.split("\n");
      const shown = rows.slice(0, MESSAGE_QUOTE_ROWS);
      if (rows.length > shown.length) shown.push(`… (${rows.length - shown.length} more lines)`);
      const code = shown.join("\n");
      const f = fence(code);
      parts.push(`${i + 1}. ${locationLabel(c)}\n${f}diff\n${code}\n${f}\n${c.body}`);
    });
    if (more > 0) parts.push(`(${more} more comment${more === 1 ? "" : "s"} will follow after these.)`);
  } else {
    parts.push("Please revise your changes.");
  }
  if (note) parts.push(comments.length > 0 ? `Overall: ${note}` : note);
  parts.push(
    comments.length > 0
      ? "Make the changes in this same copy and run the checks again. When you finish, list the comments you handled, like: Addressed: 1, 2"
      : "Make the changes in this same copy and run the checks again.",
  );
  return parts.join("\n\n");
}

function toComment(r: typeof reviewComments.$inferSelect): ReviewComment {
  return ReviewCommentSchema.parse({
    id: r.id,
    projectId: r.projectId,
    taskId: r.taskId,
    changeSetId: r.changeSetId,
    path: r.path,
    side: r.side,
    line: r.line,
    endSide: r.endSide,
    endLine: r.endLine,
    quote: r.quote,
    body: r.body,
    status: r.status,
    addressedBy: r.addressedBy,
    addressedIn: r.addressedIn,
    sentAt: r.sentAt,
    ref: r.ref,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

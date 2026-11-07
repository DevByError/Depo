import type { ChatMessage } from "@depo/model-gateway";
import { AGENT_IDS, type AgentId, newId, type SteerInfo, type SteerState } from "@depo/shared";
import { eq } from "drizzle-orm";
import { manifestOf } from "../agents/manifests";
import type { AppDb } from "../db";
import { messages } from "../db/schema";
import type { EventBus } from "../events/bus";

/**
 * Steering: notes the owner sends while a task works. A note is stored with the task at once (as
 * a user message with a `steer` part), shown as queued, and handed to agents only between steps:
 * each agent loop asks its reader for new notes before it calls the model again, never in the
 * middle of a tool call. The first agent to read a note moves it to that point of the transcript.
 */

export interface SteerNote {
  id: string;
  text: string;
  queuedAt: string;
  state: SteerState;
  readBy: string[];
}

/** What a steering note looks like in the transcript (JSON in `messages.content`). */
export interface StoredNote {
  role: "user";
  content: string;
  steer: SteerInfo;
}

/** The message an agent reads: clearly marked as the owner's, so it is not mistaken for tool output. */
export function steerPrompt(texts: string[]): string {
  const tail =
    "Adjust your work to it. Everything else you were asked still applies unless the note changes it.";
  if (texts.length === 1) return `Note from the owner while you work: ${texts[0]}\n\n${tail}`;
  return `Notes from the owner while you work:\n${texts.map((t) => `- ${t}`).join("\n")}\n\n${tail}`;
}

/** "Backend", "the coding agent" or "the Manager" for an agent tag like `backend@1.0.0`. */
export function readerName(tag: string): string {
  const id = tag.split("@")[0] ?? tag;
  if (id === "coder") return "The coding agent";
  if ((AGENT_IDS as readonly string[]).includes(id)) return manifestOf(id as AgentId).name;
  return id;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The notes of one run of a task. Created when the run starts and settled when it ends: notes
 * nobody read become the next turn (the run finished) or are marked as not read (it stopped).
 */
export class SteerInbox {
  private readonly notes = new Map<string, SteerNote>();
  private wake: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(
    private readonly o: {
      db: AppDb;
      bus: EventBus;
      taskId: string;
      projectId: string;
      /** Strictly increasing ISO timestamps shared with the transcript, so ordering holds. */
      stamp: () => string;
    },
  ) {}

  /** Queue a note for the agents at work. */
  add(text: string): SteerNote {
    const at = this.o.stamp();
    const note: SteerNote = { id: newId("msg"), text, queuedAt: at, state: "queued", readBy: [] };
    this.notes.set(note.id, note);
    this.o.db
      .insert(messages)
      .values({
        id: note.id,
        taskId: this.o.taskId,
        role: "user",
        content: JSON.stringify(this.stored(note, null)),
        createdAt: at,
        updatedAt: at,
      })
      .run();
    this.o.bus.emit({
      agent: "user",
      projectId: this.o.projectId,
      taskId: this.o.taskId,
      type: "owner_note",
      text: `Note for the agents: ${clip(text)}`,
      details: { noteId: note.id, state: "queued" },
      status: "started",
    });
    const w = this.wake;
    this.wake = null;
    w?.resolve();
    return note;
  }

  /** Notes this agent has not read yet (still queued, or read only by others), oldest first. */
  unreadBy(agent: string): SteerNote[] {
    return [...this.notes.values()].filter(
      (n) => (n.state === "queued" || n.state === "delivered") && !n.readBy.includes(agent),
    );
  }

  /** Notes nobody has read. */
  unread(): SteerNote[] {
    return [...this.notes.values()].filter((n) => n.state === "queued");
  }

  /** Every note of this run so far that an agent may still need (not dropped). */
  all(): SteerNote[] {
    return [...this.notes.values()].filter((n) => n.state === "queued" || n.state === "delivered");
  }

  /** The agent read the note. The first reader moves it to this point of the transcript. */
  markRead(id: string, agent: string): void {
    const n = this.notes.get(id);
    if (!n || (n.state !== "queued" && n.state !== "delivered") || n.readBy.includes(agent)) return;
    const first = n.state === "queued";
    n.state = "delivered";
    n.readBy.push(agent);
    const at = this.o.stamp();
    const row = this.o.db.select().from(messages).where(eq(messages.id, id)).get();
    const prev = row ? (JSON.parse(row.content) as Partial<StoredNote>) : null;
    const deliveredAt = first ? at : (prev?.steer?.deliveredAt ?? at);
    this.o.db
      .update(messages)
      .set({
        content: JSON.stringify(this.stored(n, deliveredAt)),
        updatedAt: at,
        ...(first ? { createdAt: at } : {}),
      })
      .where(eq(messages.id, id))
      .run();
    this.o.bus.emit({
      agent,
      projectId: this.o.projectId,
      taskId: this.o.taskId,
      type: "owner_note",
      text: `${readerName(agent)} read your note: ${clip(n.text, 100)}`,
      details: { noteId: id, state: "delivered", readBy: [...n.readBy] },
      status: "succeeded",
    });
  }

  /**
   * A reader for one agent loop: on each call, the notes this agent has not seen as one owner
   * message (marked read), or nothing. `seen` lists notes the agent already has in its prompt.
   */
  reader(agent: string, seen: Iterable<string> = []): () => ChatMessage[] {
    const known = new Set(seen);
    for (const id of known) this.markRead(id, agent);
    return () => {
      const fresh = this.unreadBy(agent).filter((n) => !known.has(n.id));
      if (fresh.length === 0) return [];
      for (const n of fresh) {
        known.add(n.id);
        this.markRead(n.id, agent);
      }
      return [{ role: "user", content: steerPrompt(fresh.map((n) => n.text)) }];
    };
  }

  /** Resolves when the next note arrives (the team's Manager waits on it next to running work). */
  next(): Promise<void> {
    if (!this.wake) {
      let resolve = () => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.wake = { promise, resolve };
    }
    return this.wake.promise;
  }

  /**
   * The run ended with notes nobody read. `followup`: they become the next turn, moved to the end
   * of the transcript; otherwise they are marked as not read. Returns the notes it settled.
   */
  settle(followup: boolean): SteerNote[] {
    const left = this.unread();
    for (const n of left) {
      n.state = followup ? "followup" : "dropped";
      const at = this.o.stamp();
      this.o.db
        .update(messages)
        .set({
          content: JSON.stringify(this.stored(n, null)),
          updatedAt: at,
          ...(followup ? { createdAt: at } : {}),
        })
        .where(eq(messages.id, n.id))
        .run();
    }
    if (left.length && !followup) {
      this.o.bus.emit({
        agent: "engine",
        projectId: this.o.projectId,
        taskId: this.o.taskId,
        type: "owner_note",
        text:
          left.length === 1
            ? "Your note was not read: the task stopped first"
            : `${left.length} notes were not read: the task stopped first`,
        details: { noteIds: left.map((n) => n.id), state: "dropped" },
        status: "cancelled",
      });
    }
    const w = this.wake;
    this.wake = null;
    w?.resolve();
    return left;
  }

  private stored(n: SteerNote, deliveredAt: string | null): StoredNote {
    return {
      role: "user",
      content: n.text,
      steer: { state: n.state, readBy: [...n.readBy], queuedAt: n.queuedAt, deliveredAt },
    };
  }
}

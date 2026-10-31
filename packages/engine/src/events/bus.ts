import { type DepoEvent, DepoEventSchema, type EventType, type NewEvent, newId } from "@depo/shared";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AppDb } from "../db";
import { events as eventsTable } from "../db/schema";
import type { Logger } from "../logger";
import { redact } from "../redact";

export type EventListener = (event: DepoEvent) => void;

export interface RecentQuery {
  limit: number;
  projectId?: string | null;
  types?: EventType[];
  query?: string;
}

/**
 * The Event Bus. Every engine action is announced here.
 * - Events are validated, secrets are redacted, and a per-run sequence number is assigned.
 * - Non-ephemeral events are written to the audit log (SQLite) before listeners run,
 *   so anything a client sees is already durable.
 * - A listener that throws is logged and isolated; it cannot break the bus.
 */
export class EventBus {
  private seq = 0;
  private persisted = 0;
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  get persistedCount(): number {
    return this.persisted;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: NewEvent): DepoEvent {
    const now = new Date();
    const event = DepoEventSchema.parse({
      id: newId("evt", now.getTime()),
      ts: now.toISOString(),
      seq: ++this.seq,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      agent: input.agent,
      type: input.type,
      text: redact(input.text),
      details: input.details ? redact(input.details) : null,
      durationMs: input.durationMs ?? null,
      status: input.status ?? "info",
      ephemeral: input.ephemeral ?? false,
    });

    if (!event.ephemeral) {
      const iso = event.ts;
      this.db
        .insert(eventsTable)
        .values({
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          projectId: event.projectId,
          taskId: event.taskId,
          agent: event.agent,
          type: event.type,
          text: event.text,
          details: event.details ? JSON.stringify(event.details) : null,
          durationMs: event.durationMs,
          status: event.status,
          createdAt: iso,
          updatedAt: iso,
        })
        .run();
      this.persisted++;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error("event listener failed", { err, eventType: event.type });
      }
    }
    return event;
  }

  /** Newest-last list of persisted events, for the activity feed and audit search. */
  recent(q: RecentQuery): DepoEvent[] {
    const where: SQL[] = [];
    if (q.projectId === null) where.push(isNull(eventsTable.projectId));
    else if (typeof q.projectId === "string") where.push(eq(eventsTable.projectId, q.projectId));
    if (q.types && q.types.length > 0) where.push(inArray(eventsTable.type, q.types));
    if (q.query) {
      const pattern = `%${q.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const textMatch = or(
        sql`${eventsTable.text} LIKE ${pattern} ESCAPE '\\'`,
        sql`${eventsTable.agent} LIKE ${pattern} ESCAPE '\\'`,
      );
      if (textMatch) where.push(textMatch);
    }
    const rows = this.db
      .select()
      .from(eventsTable)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(sql`rowid`)) // rowid = insertion order, stable across engine restarts
      .limit(q.limit)
      .all();
    return rows.reverse().map((r) =>
      DepoEventSchema.parse({
        id: r.id,
        ts: r.ts,
        seq: r.seq,
        projectId: r.projectId,
        taskId: r.taskId,
        agent: r.agent,
        type: r.type,
        text: r.text,
        details: r.details ? JSON.parse(r.details) : null,
        durationMs: r.durationMs,
        status: r.status,
        ephemeral: false,
      }),
    );
  }
}

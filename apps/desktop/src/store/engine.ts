import type { DepoEvent, HeartbeatDetails } from "@depo/shared";
import { HeartbeatDetailsSchema } from "@depo/shared";
import { create } from "zustand";
import type { ConnectionStatus } from "@/lib/engine-client";

export const MAX_EVENTS = 5000;
export const MAX_HEARTBEATS = 60;

export interface EngineInfo {
  engineVersion: string;
  runtime: string;
  platform: string;
  arch: string;
  pid: number;
  startedAt: string;
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
}

export interface Heartbeat {
  receivedAt: number;
  details: HeartbeatDetails;
  event: DepoEvent;
}

interface EngineState {
  status: ConnectionStatus;
  statusError: string | null;
  info: EngineInfo | null;
  /** Feed events (persisted + ephemeral except heartbeats), oldest first, capped. */
  events: DepoEvent[];
  heartbeats: Heartbeat[];
  setStatus(status: ConnectionStatus, error?: string): void;
  setInfo(info: EngineInfo): void;
  /** Merge a backlog from `events.recent` without duplicating live events. */
  loadBacklog(events: DepoEvent[]): void;
  receive(event: DepoEvent): void;
}

export function capEvents(events: DepoEvent[], max = MAX_EVENTS): DepoEvent[] {
  return events.length > max ? events.slice(events.length - max) : events;
}

export const useEngine = create<EngineState>((set) => ({
  status: "idle",
  statusError: null,
  info: null,
  events: [],
  heartbeats: [],
  setStatus: (status, error) => set({ status, statusError: error ?? null }),
  setInfo: (info) => set({ info }),
  loadBacklog: (backlog) =>
    set((s) => {
      const seen = new Set(s.events.map((e) => e.id));
      const merged = [...backlog.filter((e) => !seen.has(e.id)), ...s.events];
      merged.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts.localeCompare(b.ts)));
      return { events: capEvents(merged) };
    }),
  receive: (event) =>
    set((s) => {
      if (event.type === "heartbeat") {
        const parsed = HeartbeatDetailsSchema.safeParse(event.details);
        if (!parsed.success) return {};
        const hb: Heartbeat = { receivedAt: Date.now(), details: parsed.data, event };
        return { heartbeats: [...s.heartbeats, hb].slice(-MAX_HEARTBEATS) };
      }
      return { events: capEvents([...s.events, event]) };
    }),
}));

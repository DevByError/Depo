import type { DepoEvent, HeartbeatDetails } from "@depo/shared";
import { HeartbeatDetailsSchema } from "@depo/shared";
import { create } from "zustand";
import type { ConnectionStatus } from "@/lib/engine-client";
import { useTerminal } from "./terminal";

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

/**
 * Progress events (ephemeral, with a `jobId`) replace the previous progress line of the same job
 * instead of piling up, and are dropped once the job's final event arrives.
 */
export function mergeProgress(events: DepoEvent[], event: DepoEvent): DepoEvent[] {
  const jobId = event.details?.jobId;
  if (typeof jobId !== "string") return [...events, event];
  const sameJob = (e: DepoEvent) => e.ephemeral && e.type === event.type && e.details?.jobId === jobId;
  // A "clear" progress event removes the job's line (for example "Waiting for the model").
  if (event.ephemeral && event.details?.clear === true) return events.filter((e) => !sameJob(e));
  if (event.ephemeral) {
    for (let i = events.length - 1; i >= Math.max(0, events.length - 200); i--) {
      const e = events[i];
      if (e && sameJob(e)) {
        const next = events.slice();
        next[i] = event;
        return next;
      }
    }
    return [...events, event];
  }
  return [...events.filter((e) => !sameJob(e)), event];
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
      // Terminal output goes to the Terminal tab (its own store), not the activity feed.
      if (event.type === "terminal_output") {
        useTerminal.getState().receive(event);
        return {};
      }
      if (event.type === "heartbeat") {
        const parsed = HeartbeatDetailsSchema.safeParse(event.details);
        if (!parsed.success) return {};
        const hb: Heartbeat = { receivedAt: Date.now(), details: parsed.data, event };
        return { heartbeats: [...s.heartbeats, hb].slice(-MAX_HEARTBEATS) };
      }
      return { events: capEvents(mergeProgress(s.events, event)) };
    }),
}));

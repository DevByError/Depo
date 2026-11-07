import type { TeamEta, TeamEvent } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "@/store/engine";
import { call } from "./engine";
import { buildIndex, extendIndex, type ReplayIndex, teamAt, toTeamEvent } from "./team-replay";
import { ACTIVE_TASK, type LiveTeam, liveTeam, refreshKey } from "./team-view";

/** A clock that ticks every `intervalMs` (or stands still when null). */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** True when the person asked the system for less motion. */
export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

const PAGE = 500;
/** 20,000 events: far more than a long team run stores. */
const MAX_PAGES = 40;

/** Every stored event of a task, oldest first, page by page. */
export async function fetchTeamEvents(taskId: string): Promise<TeamEvent[]> {
  const out: TeamEvent[] = [];
  let after: number | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await call("team.events", {
      taskId,
      limit: PAGE,
      ...(after !== undefined ? { after } : {}),
    });
    out.push(...page.events);
    if (page.next === null) break;
    after = page.next;
  }
  return out;
}

export interface TeamViewResult {
  view: LiveTeam | null;
  loading: boolean;
  error: string | null;
  /** The run's events, indexed for replay. Null when the engine could not send them (live only). */
  replay: ReplayIndex | null;
  /** How long the work takes on this PC; null until the engine answers. */
  eta: TeamEta | null;
  /** The moment shown (ms): the replay position, or the live edge. */
  t: number;
  /** The live edge: now while the task runs, its last event once it is over. */
  edge: number;
  /** Showing the live edge (not a moment the person picked). */
  live: boolean;
  /** The task is still running. */
  active: boolean;
}

/**
 * The team view of a task at a moment. The `team.timeline` snapshot gives the plan and the agents
 * taking part; the task's stored events (`team.events`) plus the live event stream are replayed by
 * one reducer, at `cursor` or at the live edge when the cursor is null. When the events cannot be
 * loaded (an older engine), the snapshot merged with live events is shown instead.
 */
export function useTeamView(taskId: string | null, opts: { cursor?: number | null } = {}): TeamViewResult {
  const connected = useEngine((s) => s.status === "open");
  const events = useEngine((s) => s.events);
  const taskEvents = useMemo(
    () => (taskId ? events.filter((e) => e.taskId === taskId) : []),
    [events, taskId],
  );
  const query = useQuery({
    queryKey: ["teamTimeline", taskId],
    queryFn: () => call("team.timeline", { taskId: taskId ?? "" }),
    enabled: connected && !!taskId,
  });
  const stored = useQuery({
    queryKey: ["teamEvents", taskId],
    queryFn: () => fetchTeamEvents(taskId ?? ""),
    enabled: connected && !!taskId,
    // Live events arrive through the engine store; a quick tab switch does not need a reload.
    staleTime: 30_000,
    retry: false,
  });

  // Refetch shortly after the team picture changes (bursts collapse into one call).
  const key = useMemo(() => refreshKey(taskEvents), [taskEvents]);
  const seen = useRef<{ task: string | null; key: string | null } | null>(null);
  const { refetch } = query;
  useEffect(() => {
    if (!connected) return;
    if (!seen.current || seen.current.task !== taskId) {
      seen.current = { task: taskId, key };
      return;
    }
    if (seen.current.key === key) return;
    seen.current = { task: taskId, key };
    const t = setTimeout(() => void refetch(), 200);
    return () => clearTimeout(t);
  }, [key, taskId, connected, refetch]);

  // The replay index: built once from the stored events, then extended with live ones.
  const cache = useRef<{
    task: string;
    base: TeamEvent[];
    ids: Set<string>;
    index: ReplayIndex;
  } | null>(null);
  const replay = useMemo((): ReplayIndex | null => {
    const base = stored.data;
    if (!taskId || !base) return null;
    const c = cache.current;
    if (!c || c.task !== taskId || c.base !== base) {
      const ids = new Set(base.map((e) => e.id));
      const extra = taskEvents.filter((e) => !e.ephemeral && !ids.has(e.id)).map(toTeamEvent);
      for (const e of extra) ids.add(e.id);
      const index = buildIndex([...base, ...extra]);
      cache.current = { task: taskId, base, ids, index };
      return index;
    }
    const fresh = taskEvents.filter((e) => !e.ephemeral && !c.ids.has(e.id));
    if (fresh.length > 0) {
      for (const e of fresh) c.ids.add(e.id);
      c.index = extendIndex(c.index, fresh.map(toTeamEvent));
    }
    return c.index;
  }, [stored.data, taskEvents, taskId]);

  const snapshot = query.data;
  const nodes = snapshot?.plan?.nodes ?? [];
  const finished = nodes.filter((n) => n.status === "done" || n.status === "failed").length;
  const eta = useQuery({
    // Learning happens when tasks finish, so the estimate is asked again then.
    queryKey: ["teamEta", taskId, nodes.length, finished, snapshot?.status ?? null],
    queryFn: () => call("team.eta", { taskId: taskId ?? "" }),
    enabled: connected && !!taskId && !!snapshot,
    staleTime: 60_000,
    retry: false,
  });

  const active = !!snapshot && ACTIVE_TASK.includes(snapshot.status);
  const now = useNow(active ? 1000 : null);
  const usable = replay && replay.events.length > 0 ? replay : null;
  const edge = usable ? (active ? Math.max(now, usable.end) : usable.end) : now;
  const cursor = usable ? (opts.cursor ?? null) : null;
  const live = cursor === null;
  const t = live ? edge : Math.max(usable?.start ?? 0, Math.min(cursor, edge));
  const view = useMemo(() => {
    if (!snapshot) return null;
    if (usable) return teamAt(snapshot, usable, { t, live, taskEvents });
    return liveTeam(snapshot, taskEvents, query.dataUpdatedAt, now);
  }, [snapshot, usable, t, live, taskEvents, query.dataUpdatedAt, now]);

  return {
    view,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    replay: usable,
    eta: eta.data ?? null,
    t,
    edge,
    live,
    active,
  };
}

/** How long a task takes on this PC (for the chat's elapsed and remaining hint). */
export function useTaskEta(taskId: string | null): TeamEta | null {
  const connected = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["teamEta", taskId, "task"],
    queryFn: () => call("team.eta", { taskId: taskId ?? "" }),
    enabled: connected && !!taskId,
    staleTime: 60_000,
    retry: false,
  });
  return q.data ?? null;
}

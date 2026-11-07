import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "@/store/engine";
import { call } from "./engine";
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

/**
 * The team view of a task: the `team.timeline` snapshot, refreshed after handoffs, reviews and
 * decisions, merged with the live event stream so actions and decisions show up at once.
 */
export function useTeamView(taskId: string | null): {
  view: LiveTeam | null;
  loading: boolean;
  error: string | null;
} {
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

  const active = !!query.data && ACTIVE_TASK.includes(query.data.status);
  const now = useNow(active ? 1000 : null);
  const view = useMemo(
    () => (query.data ? liveTeam(query.data, taskEvents, query.dataUpdatedAt, now) : null),
    [query.data, taskEvents, query.dataUpdatedAt, now],
  );
  return {
    view,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

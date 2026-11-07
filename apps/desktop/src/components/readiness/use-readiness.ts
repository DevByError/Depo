import type { DepoEvent, EventType, ReadinessReport, ReadinessRunKind } from "@depo/shared";
import { hashKey, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";

export const readinessKey = (taskId: string) => ["readiness", taskId] as const;

/** Same key as the Diff Review's line comments (ReviewComments.commentsKey). */
const commentsHash = (changeSetId: string) => hashKey(["changes", "comments", changeSetId]);

/** Events of a task after which its report can read differently. */
const REFRESH_TYPES = new Set<EventType>([
  "testing",
  "test_result",
  "linting",
  "security_scan",
  "rendering_screenshot",
  "decision",
  "handoff",
  "writing_file",
  "editing_file",
  "applied_changes",
  "info",
]);

/** How far back to look for the newest such event (the feed keeps thousands). */
const SCAN = 400;

/** The id of the task's newest event that can change its report, or null. */
export function lastReadinessEvent(events: DepoEvent[], taskId: string | null): string | null {
  if (!taskId) return null;
  for (let i = events.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const e = events[i];
    if (e && e.taskId === taskId && !e.ephemeral && REFRESH_TYPES.has(e.type)) return e.id;
  }
  return null;
}

/** Wait a moment after the last change: a test run or a review sends several events at once. */
export const REFRESH_DELAY_MS = 300;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRefresh(qc: QueryClient, taskId: string) {
  const prev = timers.get(taskId);
  if (prev) clearTimeout(prev);
  timers.set(
    taskId,
    setTimeout(() => {
      timers.delete(taskId);
      void qc.invalidateQueries({ queryKey: readinessKey(taskId) });
    }, REFRESH_DELAY_MS),
  );
}

/**
 * The readiness report of a task. It reads again when the task's tests, page checks, scans,
 * decisions or edits arrive, and when the line comments of its change set change.
 */
export function useReadiness(taskId: string | null) {
  const connected = useEngine((s) => s.status === "open");
  const qc = useQueryClient();
  const enabled = connected && !!taskId;
  const query = useQuery({
    queryKey: readinessKey(taskId ?? ""),
    queryFn: async (): Promise<ReadinessReport> =>
      (await call("readiness.get", { taskId: taskId ?? "" })).report,
    enabled,
    retry: false,
    staleTime: 5_000,
  });

  const stamp = useEngine((s) => (enabled ? lastReadinessEvent(s.events, taskId) : null));
  const seen = useRef(stamp);
  useEffect(() => {
    if (!taskId || stamp === seen.current) return;
    seen.current = stamp;
    scheduleRefresh(qc, taskId);
  }, [stamp, taskId, qc]);

  const changeSetId = query.data?.changeSetId ?? null;
  useEffect(() => {
    if (!taskId || !changeSetId) return;
    const hash = commentsHash(changeSetId);
    return qc.getQueryCache().subscribe((ev) => {
      if (ev.type === "updated" && ev.action.type === "success" && ev.query.queryHash === hash)
        scheduleRefresh(qc, taskId);
    });
  }, [qc, taskId, changeSetId]);

  return query;
}

/** Run the tests, a page check or a scan in the private copy; the answer is the new report. */
export function useReadinessRun(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (check: ReadinessRunKind) =>
      // A full test suite or the first start of an app can take minutes.
      call("readiness.run", { taskId, check }, { timeoutMs: 20 * 60_000 }),
    onSuccess: (r) => qc.setQueryData(readinessKey(taskId), r.report),
  });
}

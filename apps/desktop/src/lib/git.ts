import type { DepoEvent, GitCommitRef } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";

/** The project's git status, refreshed every few seconds while the window is visible. */
export function useGitStatus(projectId: string | null) {
  const connected = useEngine((s) => s.status === "open");
  return useQuery({
    queryKey: ["git", "status", projectId],
    queryFn: () => call("git.status", { projectId: projectId ?? "" }),
    enabled: connected && !!projectId,
    staleTime: 4000,
    refetchInterval: () => (typeof document !== "undefined" && document.hidden ? false : 15_000),
    retry: false,
  });
}

export function changesHint(n: number): string {
  if (n === 0) return "Everything is committed";
  return `${n} change${n === 1 ? "" : "s"} not committed`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 Nov", "4 Nov 2025". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(t);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  )
    return "yesterday";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === today.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** The commit Depo made for a change set, from the activity events this window has seen. */
export function committedFromEvents(events: DepoEvent[], changeSetId: string): GitCommitRef | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== "committed" || e.details?.changeSetId !== changeSetId) continue;
    const d = e.details;
    if (typeof d.hash !== "string") continue;
    return {
      hash: d.hash,
      shortHash: typeof d.shortHash === "string" ? d.shortHash : d.hash.slice(0, 7),
      branch: typeof d.branch === "string" ? d.branch : null,
    };
  }
  return null;
}

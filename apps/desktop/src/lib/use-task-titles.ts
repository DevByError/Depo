import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useEngine } from "@/store/engine";
import { call } from "./engine";

/**
 * Task titles by id for the given projects. Uses the same cache as the Chat task list, so it
 * usually costs no extra request.
 */
export function useTaskTitles(projectIds: (string | null | undefined)[]): Map<string, string> {
  const connected = useEngine((s) => s.status === "open");
  const ids = useMemo(
    () =>
      [...new Set(projectIds.filter((p): p is string => typeof p === "string" && p.length > 0))].slice(0, 12),
    [projectIds],
  );
  const results = useQueries({
    queries: ids.map((projectId) => ({
      queryKey: ["tasks", "list", projectId],
      queryFn: () => call("tasks.list", { projectId }),
      enabled: connected,
      staleTime: 10_000,
    })),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` changes whenever any list does.
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const r of results) for (const t of r.data?.tasks ?? []) map.set(t.id, t.title);
    return map;
  }, [stamp]);
}

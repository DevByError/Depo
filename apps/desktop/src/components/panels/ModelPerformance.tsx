import type { ModelCall } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { AGENT_SOFT, agentInitials, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatClock } from "@/lib/format";
import { formatMs } from "@/lib/logs";
import { useEngine } from "@/store/engine";

export function formatSpeed(tps: number | null | undefined): string {
  if (tps === null || tps === undefined) return "–";
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** Recent model calls at a glance: speed, time to first token and errors, per model. */
export function ModelPerformance() {
  const connected = useEngine((s) => s.status === "open");
  const stats = useQuery({
    queryKey: ["models", "stats"],
    queryFn: () => call("models.stats", { limit: 8 }),
    enabled: connected,
    refetchInterval: 5000,
  });
  const models = stats.data?.models ?? [];
  const calls = stats.data?.calls ?? [];

  return (
    <section className="mt-4" aria-labelledby="model-perf-title">
      <h3 id="model-perf-title" className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-fg">
        <Gauge className="size-3.5 text-accent" aria-hidden />
        Model performance
        <span className="font-normal text-subtle">(this run)</span>
      </h3>
      {models.length === 0 ? (
        <p className="text-subtle">No model calls yet. Speeds show here after the first answer.</p>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">Speed per model</caption>
            <thead className="text-[11px] text-subtle">
              <tr>
                <th scope="col" className="w-[38%] pb-1 font-normal">
                  Model
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Calls
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Speed
                </th>
                <th scope="col" className="pb-1 font-normal">
                  First token
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Errors
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-muted">
              {models.map((m) => (
                <tr key={`${m.providerId}/${m.model}`} className="border-t border-border/60">
                  <td
                    className="truncate py-1 pr-2 font-mono text-[11px] text-fg"
                    title={`${m.providerId} · ${m.model}`}
                  >
                    {m.model}
                  </td>
                  <td className="py-1">{m.calls}</td>
                  <td className="py-1 text-fg">{formatSpeed(m.avgTokensPerSec)}</td>
                  <td className="py-1">{formatMs(m.medianTtftMs)}</td>
                  <td
                    className={cn("py-1", m.errors > 0 ? "text-danger" : "text-subtle")}
                    title={m.lastError ?? undefined}
                  >
                    {m.errors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-2 space-y-0.5" aria-label="Recent model calls">
            {calls.map((c) => (
              <CallRow key={`${c.ts}-${c.model}-${c.durationMs}`} call={c} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CallRow({ call: c }: { call: ModelCall }) {
  const agent = c.agent?.split("@")[0] ?? null;
  return (
    <li className="flex items-center gap-2 text-[11px] text-muted">
      <time
        className="shrink-0 tabular-nums text-subtle"
        dateTime={c.ts}
        title={new Date(c.ts).toLocaleString()}
      >
        {formatClock(c.ts)}
      </time>
      {agent ? (
        <span
          className={cn("shrink-0 rounded px-1 text-[9px] font-semibold", AGENT_SOFT[agentTone(agent)])}
          title={c.agent ?? undefined}
        >
          {agentInitials(agent)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-mono">{c.model}</span>
      {c.ok ? (
        <span className="shrink-0 tabular-nums">
          {formatSpeed(c.tokensPerSec)} · first {formatMs(c.ttftMs)} · {formatMs(c.durationMs)}
        </span>
      ) : (
        <span className="min-w-0 shrink truncate text-danger" title={c.error ?? undefined}>
          {c.error ?? "Failed"}
        </span>
      )}
    </li>
  );
}

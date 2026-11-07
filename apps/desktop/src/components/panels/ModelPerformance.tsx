import type { ModelCall, ModelStat } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Hourglass } from "lucide-react";
import { AGENT_SOFT, agentInitials, agentTone } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { call } from "@/lib/engine";
import { formatClock } from "@/lib/format";
import { formatMs } from "@/lib/logs";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";

export function formatSpeed(tps: number | null | undefined): string {
  if (tps === null || tps === undefined) return "–";
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** "16k" for a context length in tokens. */
export function formatContext(tokens: number | null | undefined): string | null {
  if (!tokens) return null;
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/**
 * Loads take most of the model time: worth a hint. Needs at least two loads, so one first load
 * at the start of the day does not count.
 */
export function loadsDominate(models: ModelStat[]): boolean {
  let load = 0;
  let busy = 0;
  let loads = 0;
  for (const m of models) {
    load += m.loadMsTotal ?? 0;
    busy += m.busyMsTotal ?? 0;
    loads += m.coldLoads ?? 0;
  }
  return loads >= 2 && busy > 0 && load / busy >= 0.4;
}

/** Recent model calls at a glance: load time, reading and writing speed, first token and errors. */
export function ModelPerformance() {
  const connected = useEngine((s) => s.status === "open");
  const openSettings = useUi((s) => s.setSettingsOpen);
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
          {loadsDominate(models) && (
            <div
              role="note"
              className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-raised/40 px-2.5 py-1.5 text-[11px] text-muted"
            >
              <Hourglass className="size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1">
                Most time goes to loading models. Keep them loaded longer or use one model for more roles.
              </span>
              <button
                type="button"
                onClick={() => openSettings(true)}
                className="rounded px-1.5 py-0.5 text-accent hover:bg-hover"
              >
                Open settings
              </button>
            </div>
          )}
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">Speed per model</caption>
            <thead className="text-[11px] text-subtle">
              <tr>
                <th scope="col" className="w-[32%] pb-1 font-normal">
                  Model
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Calls
                </th>
                <th scope="col" className="pb-1 font-normal" title="Time to load the model into memory">
                  Load
                </th>
                <th scope="col" className="pb-1 font-normal" title="How fast the model reads the prompt">
                  Reading
                </th>
                <th scope="col" className="pb-1 font-normal" title="How fast the model writes its answer">
                  Writing
                </th>
                <th scope="col" className="pb-1 font-normal">
                  First token
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-muted">
              {models.map((m) => (
                <ModelRow key={`${m.providerId}/${m.model}`} m={m} />
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

function ModelRow({ m }: { m: ModelStat }) {
  const ctx = formatContext(m.contextLength);
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="py-1 pr-2" title={`${m.providerId} · ${m.model}${ctx ? ` · context ${ctx}` : ""}`}>
        <div className="truncate font-mono text-[11px] text-fg">{m.model}</div>
        {ctx && <div className="text-[10px] text-subtle">{ctx} context</div>}
      </td>
      <td className="py-1">
        {m.calls}
        {m.errors > 0 && (
          <span className="block text-[10px] text-danger" title={m.lastError ?? undefined}>
            {m.errors} failed
          </span>
        )}
      </td>
      <td className="py-1">
        <LoadCell m={m} />
      </td>
      <td className="py-1">{formatSpeed(m.avgPromptTokensPerSec)}</td>
      <td className="py-1 text-fg">{formatSpeed(m.avgTokensPerSec)}</td>
      <td className="py-1">{formatMs(m.medianTtftMs)}</td>
    </tr>
  );
}

/** The usual load time, and "kept loaded" when the last calls found the model in memory. */
function LoadCell({ m }: { m: ModelStat }) {
  const kept = m.keptLoaded === true;
  if (m.medianLoadMs === null || m.medianLoadMs === undefined) {
    return kept ? <span className="text-success">Kept loaded</span> : <span>–</span>;
  }
  return (
    <>
      <span title={`${m.coldLoads ?? 0} load${m.coldLoads === 1 ? "" : "s"} this run`}>
        {formatMs(m.medianLoadMs)}
      </span>
      {kept && <span className="block text-[10px] text-success">kept loaded</span>}
    </>
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
          {c.coldLoad ? `loaded in ${formatMs(c.loadMs)} · ` : ""}
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

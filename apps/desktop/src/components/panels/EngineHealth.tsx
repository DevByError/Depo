import { formatBytes, formatDuration } from "@/lib/format";
import { useEngine } from "@/store/engine";
import { connectionLabel } from "./ConnectionBadge";
import { HeartbeatPulse } from "./HeartbeatPulse";
import { ModelPerformance } from "./ModelPerformance";

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-8" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 160;
  const h = 32;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-8 w-full"
      role="img"
      aria-label="Engine memory over the last minutes"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-raised/40 px-3 py-2">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums text-fg">{value}</div>
    </div>
  );
}

export function EngineHealth() {
  const status = useEngine((s) => s.status);
  const statusError = useEngine((s) => s.statusError);
  const info = useEngine((s) => s.info);
  const heartbeats = useEngine((s) => s.heartbeats);
  const last = heartbeats.at(-1)?.details;

  return (
    <section className="h-full overflow-y-auto p-3 text-xs" tabIndex={0} aria-label="Engine health">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
        <span>
          <span className="font-medium text-fg">{connectionLabel(status)}</span>
          {statusError && status !== "open" ? ` · ${statusError}` : ""}
        </span>
        <HeartbeatPulse />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
        <Stat label="Uptime" value={last ? formatDuration(last.uptimeMs) : "–"} />
        <Stat label="Memory (RSS)" value={last ? formatBytes(last.rssBytes) : "–"} />
        <Stat label="Heap used" value={last ? formatBytes(last.heapUsedBytes) : "–"} />
        <Stat label="UI clients" value={last ? String(last.connectedClients) : "–"} />
        <Stat label="Events logged (this run)" value={last ? String(last.eventsPersisted) : "–"} />
        <div className="rounded-md border border-border bg-raised/40 px-3 py-2">
          <div className="text-[11px] text-subtle">Memory trend</div>
          <Sparkline values={heartbeats.map((h) => h.details.rssBytes)} />
        </div>
      </div>
      {info && (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-muted">
          <dt className="text-subtle">Engine</dt>
          <dd>
            {info.engineVersion} · {info.runtime} · {info.platform}/{info.arch} · PID {info.pid}
          </dd>
          <dt className="text-subtle">Data folder</dt>
          <dd className="break-all font-mono text-[11px]">{info.dataDir}</dd>
          <dt className="text-subtle">Database</dt>
          <dd className="break-all font-mono text-[11px]">
            {info.dbPath} (schema v{info.schemaVersion})
          </dd>
        </dl>
      )}
      <ModelPerformance />
    </section>
  );
}

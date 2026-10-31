import { useEffect, useState } from "react";
import { formatAgo } from "@/lib/format";
import { useEngine } from "@/store/engine";

/** Ticks so "x s ago" stays live between heartbeats. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function HeartbeatPulse({ withLabel = true }: { withLabel?: boolean }) {
  const last = useEngine((s) => s.heartbeats.at(-1));
  const status = useEngine((s) => s.status);
  const now = useNow();
  const age = last ? now - last.receivedAt : null;
  const stale = age === null || age > 6000 || status !== "open";

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="heartbeat">
      <span className="relative inline-flex size-2">
        {!stale && (
          <span key={last?.event.id} className="pulse-ring absolute inset-0 rounded-full bg-success" />
        )}
        <span
          className={
            stale ? "relative size-2 rounded-full bg-subtle" : "relative size-2 rounded-full bg-success"
          }
        />
      </span>
      {withLabel && (
        <span className="tabular-nums">
          {age === null ? "No heartbeat yet" : `Heartbeat ${formatAgo(age)}`}
        </span>
      )}
    </span>
  );
}

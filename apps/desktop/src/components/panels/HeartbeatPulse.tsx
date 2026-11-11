import { useEffect, useState } from "react";
import { formatAgo, formatDuration } from "@/lib/format";
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

/** Heartbeats come every 2 s: three missed in a row means the engine is busy or blocked. */
export const LATE_HEARTBEAT_MS = 6000;

/**
 * What the heartbeat line says. A late heartbeat on an open link means the engine is busy (it
 * still runs; the watchdog logs what blocked it), which is different from a dropped link.
 */
export function pulseLabel(status: string, age: number | null): string {
  if (status === "reconnecting" || status === "connecting") return "Reconnecting to the engine";
  if (status !== "open") return "Not connected to the engine";
  if (age === null) return "No heartbeat yet";
  if (age > LATE_HEARTBEAT_MS) return `Engine busy · no heartbeat for ${formatDuration(age)}`;
  return `Heartbeat ${formatAgo(age)}`;
}

export function HeartbeatPulse({ withLabel = true }: { withLabel?: boolean }) {
  const last = useEngine((s) => s.heartbeats.at(-1));
  const status = useEngine((s) => s.status);
  const now = useNow();
  const age = last ? now - last.receivedAt : null;
  const stale = age === null || age > LATE_HEARTBEAT_MS || status !== "open";
  const busy = status === "open" && age !== null && age > LATE_HEARTBEAT_MS;

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="heartbeat">
      <span className="relative inline-flex size-2">
        {!stale && (
          <span key={last?.event.id} className="pulse-ring absolute inset-0 rounded-full bg-success" />
        )}
        <span
          className={
            busy
              ? "relative size-2 rounded-full bg-warning"
              : stale
                ? "relative size-2 rounded-full bg-subtle"
                : "relative size-2 rounded-full bg-success"
          }
        />
      </span>
      {withLabel && <span className="tabular-nums">{pulseLabel(status, age)}</span>}
    </span>
  );
}

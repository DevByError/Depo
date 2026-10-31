import type { DepoEvent } from "@depo/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, HeartPulse, Search } from "lucide-react";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { EVENT_STYLE, TONE_TEXT } from "@/lib/event-style";
import { formatBytes, formatClock, formatDuration } from "@/lib/format";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { HeartbeatPulse } from "./HeartbeatPulse";

export function filterEvents(events: DepoEvent[], query: string): DepoEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return events;
  return events.filter(
    (e) => e.text.toLowerCase().includes(q) || e.agent.toLowerCase().includes(q) || e.type.includes(q),
  );
}

export function ActivityFeed() {
  const events = useEngine((s) => s.events);
  const heartbeats = useEngine((s) => s.heartbeats);
  const query = useUi((s) => s.feedQuery);
  const setQuery = useUi((s) => s.setFeedQuery);
  const showHeartbeats = useUi((s) => s.showHeartbeats);
  const setShowHeartbeats = useUi((s) => s.setShowHeartbeats);
  const deferredQuery = useDeferredValue(query);

  const rows = useMemo(() => {
    const base = showHeartbeats
      ? [...events, ...heartbeats.map((h) => h.event)].sort((a, b) =>
          a.ts === b.ts ? a.seq - b.seq : a.ts.localeCompare(b.ts),
        )
      : events;
    return filterEvents(base, deferredQuery);
  }, [events, heartbeats, showHeartbeats, deferredQuery]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  useEffect(() => {
    if (stickToBottom.current && rows.length > 0)
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <label className="flex h-7 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
          <Search className="size-3.5 text-subtle" aria-hidden />
          <span className="sr-only">Filter activity</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter activity"
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-subtle"
          />
        </label>
        <button
          type="button"
          onClick={() => setShowHeartbeats(!showHeartbeats)}
          aria-pressed={showHeartbeats}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
            showHeartbeats
              ? "border-accent bg-accent-soft text-fg"
              : "border-border text-muted hover:bg-hover",
          )}
        >
          <HeartPulse className="size-3.5" aria-hidden />
          Heartbeats
        </button>
      </div>

      <LiveHeartbeatRow />

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-label="Activity feed"
      >
        {rows.length === 0 ? (
          <p className="p-6 text-center text-xs text-subtle">
            {query ? "No activity matches this filter." : "Waiting for engine activity…"}
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const ev = rows[item.index];
              if (!ev) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <EventRow event={ev} open={expanded.has(ev.id)} onToggle={() => toggle(ev.id)} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveHeartbeatRow() {
  const last = useEngine((s) => s.heartbeats.at(-1));
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-raised/50 px-3 py-1.5 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium text-fg">Engine</span>
        <HeartbeatPulse />
      </span>
      {last && (
        <span className="tabular-nums text-subtle">
          up {formatDuration(last.details.uptimeMs)} · {formatBytes(last.details.rssBytes)}
        </span>
      )}
    </div>
  );
}

const EventRow = memo(function EventRow({
  event,
  open,
  onToggle,
}: {
  event: DepoEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const style = EVENT_STYLE[event.type];
  const Icon = style.icon;
  const hasDetails = event.details !== null && Object.keys(event.details).length > 0;
  return (
    <div
      className="border-b border-border/60 px-3 py-1.5 text-xs hover:bg-hover/60"
      data-event-type={event.type}
    >
      <button
        type="button"
        onClick={hasDetails ? onToggle : undefined}
        aria-expanded={hasDetails ? open : undefined}
        className={cn("flex w-full items-start gap-2 text-left", !hasDetails && "cursor-default")}
      >
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_TEXT[style.tone])} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{agentLabel(event.agent)}</span>
          <span className="text-subtle"> · </span>
          <span className="break-words text-muted">{event.text}</span>
        </span>
        <time className="shrink-0 tabular-nums text-subtle" dateTime={event.ts}>
          {formatClock(event.ts)}
        </time>
        {hasDetails && (
          <ChevronRight
            className={cn("mt-0.5 size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")}
            aria-hidden
          />
        )}
      </button>
      {open && hasDetails && (
        <pre className="mt-1.5 ml-5.5 overflow-x-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      )}
    </div>
  );
});

function agentLabel(agent: string): string {
  if (agent === "engine") return "Engine";
  if (agent === "user") return "You";
  const [name, version] = agent.split("@");
  if (!name || !version) return agent;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} Agent (${version})`;
}

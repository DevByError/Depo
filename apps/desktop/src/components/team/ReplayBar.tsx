import { Check, Link2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/event-style";
import { formatClock } from "@/lib/format";
import { momentRef, parseMoment } from "@/lib/team-moment";
import { type Marker, markerCounts, type ReplayIndex, stepEvent, stepMarker } from "@/lib/team-replay";
import { type ReplayPlayer, SPEEDS } from "@/lib/use-replay";
import { useUi } from "@/store/ui";

const TONE_BG: Record<Tone, string> = {
  neutral: "bg-border-strong",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/** "4:05" or "1:02:09" from the start of the run. */
export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function spoken(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", `${s % 60} s`].filter(Boolean);
  return parts.join(" ");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The film strip under the Team header: play and pause, step through events or jump between key
 * moments, pick a speed, drag the position, go back to live, and share the moment shown.
 */
export function ReplayBar({
  index,
  player,
  t,
  edge,
  live,
  active,
  taskId,
  projectId,
}: {
  index: ReplayIndex;
  player: ReplayPlayer;
  t: number;
  edge: number;
  live: boolean;
  active: boolean;
  taskId: string;
  projectId: string | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const hintId = useId();
  const [shareOpen, setShareOpen] = useState(false);
  const span = Math.max(1, edge - index.start);
  const pos = Math.min(span, Math.max(0, t - index.start));
  const pct = (v: number) => `${(Math.min(span, Math.max(0, v - index.start)) / span) * 100}%`;
  const counts = markerCounts(index.markers);

  const fromPointer = (clientX: number): number => {
    const el = track.current;
    if (!el) return t;
    const rect = el.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    // A marker within a few pixels wins, so a key moment is easy to hit.
    const near = index.markers.find((m) => Math.abs(((m.t - index.start) / span) * rect.width - x) <= 5);
    if (near) return near.t;
    return index.start + (rect.width > 0 ? (x / rect.width) * span : 0);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    player.seek(fromPointer(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) player.seek(fromPointer(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const step = (dir: 1 | -1) => player.seek(stepEvent(index, t, dir, edge));
  const jump = (dir: 1 | -1) => player.seek(stepMarker(index, t, dir, edge));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        if (e.shiftKey) jump(1);
        else step(1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        if (e.shiftKey) jump(-1);
        else step(-1);
        break;
      case "PageDown":
        jump(1);
        break;
      case "PageUp":
        jump(-1);
        break;
      case "Home":
        player.seek(index.start);
        break;
      case "End":
        player.goLive();
        break;
      case " ":
        player.toggle();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const clock = formatClock(new Date(t).toISOString());
  const summary = [
    plural(counts.decision, "decision"),
    plural(counts.review, "approval"),
    counts.changes ? plural(counts.changes, "change request") : "",
    counts.send_back ? `${counts.send_back} sent back` : "",
    counts.error ? plural(counts.error, "problem") : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section aria-label="Replay" className="@container shrink-0 border-b border-border bg-panel px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex items-center gap-0.5">
          <IconButton label="Previous key moment" onClick={() => jump(-1)}>
            <SkipBack />
          </IconButton>
          <IconButton label="Step back" onClick={() => step(-1)}>
            <StepBack />
          </IconButton>
          <button
            type="button"
            onClick={player.toggle}
            aria-label={player.playing ? "Pause" : "Play"}
            className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg shadow-pop transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel [&_svg]:size-3.5"
          >
            {player.playing ? <Pause aria-hidden /> : <Play aria-hidden className="translate-x-px" />}
          </button>
          <IconButton label="Step forward" onClick={() => step(1)}>
            <StepForward />
          </IconButton>
          <IconButton label="Next key moment" onClick={() => jump(1)}>
            <SkipForward />
          </IconButton>
        </div>
        <fieldset className="flex items-center rounded-md border border-border bg-bg p-0.5">
          <legend className="sr-only">Playback speed</legend>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={player.speed === s}
              aria-label={`${s} times speed`}
              onClick={() => player.setSpeed(s)}
              className={cn(
                "h-6 min-w-8 rounded px-1.5 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                player.speed === s ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              {s}x
            </button>
          ))}
        </fieldset>
        <span className="text-xs tabular-nums text-muted" data-testid="replay-time">
          <span className="text-fg">{formatOffset(pos)}</span>
          <span className="text-subtle"> / {formatOffset(span)}</span>
        </span>

        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={Math.round(span / 1000)}
          aria-valuenow={Math.round(pos / 1000)}
          aria-valuetext={`${spoken(pos)} into the run, at ${clock}${live ? (active ? ", live" : ", the end") : ""}`}
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="group relative order-last h-7 min-w-0 basis-full cursor-pointer touch-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent @2xl:order-none @2xl:basis-0 @2xl:flex-1"
        >
          <span
            aria-hidden
            className="absolute inset-x-1 top-1/2 h-1 -translate-y-1/2 rounded-full bg-hover"
          />
          <span
            aria-hidden
            className="absolute top-1/2 left-1 h-1 -translate-y-1/2 rounded-full bg-accent/60"
            style={{ width: `calc((100% - 0.5rem) * ${pos / span})` }}
          />
          <span aria-hidden className="absolute inset-x-1 top-0 bottom-0">
            {index.markers.map((m) => (
              <MarkerTick key={`${m.i}`} m={m} left={pct(m.t)} />
            ))}
            <span
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-accent shadow-pop transition-transform group-active:scale-110"
              style={{ left: pct(t) }}
            />
          </span>
        </div>
        <span id={hintId} className="sr-only">
          {summary} on the timeline. Arrow keys step through events. Shift with an arrow key, or Page Up and
          Page Down, jumps between key moments. Space plays or pauses. End goes back to{" "}
          {active ? "live" : "the end"}.
        </span>

        <div className="ml-auto flex items-center gap-1.5 @2xl:ml-0">
          <button
            type="button"
            aria-pressed={live}
            onClick={player.goLive}
            title={active ? "Follow the team live" : "Show how the run ended"}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              live
                ? "border-accent/40 bg-accent-soft text-accent"
                : "border-border text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {active && (
              <span className="relative flex size-1.5" aria-hidden>
                {live && (
                  <span className="absolute inline-flex size-full rounded-full bg-current opacity-50 motion-safe:animate-ping" />
                )}
                <span className="relative inline-flex size-1.5 rounded-full bg-current" />
              </span>
            )}
            {active ? "Live" : "End"}
          </button>
          <button
            type="button"
            aria-expanded={shareOpen}
            onClick={() => setShareOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Link2 className="size-3.5" aria-hidden />
            Share moment
          </button>
        </div>
      </div>
      {shareOpen && (
        <SharePanel
          reference={momentRef({ taskId, projectId, atMs: Math.round(pos) })}
          at={`${formatOffset(pos)} into the run (${clock})`}
          onClose={() => setShareOpen(false)}
        />
      )}
    </section>
  );
}

function MarkerTick({ m, left }: { m: Marker; left: string }) {
  const tall = m.kind !== "decision";
  return (
    <span
      title={m.label}
      data-marker={m.kind}
      className={cn(
        "absolute top-1/2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
        tall ? "h-3.5" : "h-2.5 opacity-80",
        TONE_BG[m.tone],
      )}
      style={{ left }}
    />
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/** Copy the moment's reference, or paste one to open it. Nothing leaves this PC. */
function SharePanel({ reference, at, onClose }: { reference: string; at: string; onClose(): void }) {
  const openTeamMoment = useUi((s) => s.openTeamMoment);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [paste, setPaste] = useState("");
  const [bad, setBad] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const pasteId = useId();
  const linkId = useId();

  useEffect(() => {
    if (copied !== "done") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      setCopied("done");
    } catch {
      // No clipboard (locked down WebView): the link is selected for Ctrl+C instead.
      linkRef.current?.select();
      setCopied("failed");
    }
  };
  const open = () => {
    const m = parseMoment(paste);
    if (!m) {
      setBad(true);
      return;
    }
    setBad(false);
    setPaste("");
    openTeamMoment(m);
    onClose();
  };

  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-border bg-bg p-2.5 text-xs @2xl:grid-cols-2">
      <div className="min-w-0">
        <label htmlFor={linkId} className="mb-1 block text-[11px] text-muted">
          Link to this moment, {at}
        </label>
        <div className="flex gap-1.5">
          <input
            ref={linkRef}
            id={linkId}
            readOnly
            value={reference}
            onFocus={(e) => e.currentTarget.select()}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-panel px-2 font-mono text-[11px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-accent-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
          >
            {copied === "done" && <Check className="size-3" aria-hidden />}
            {copied === "done" ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-subtle" aria-live="polite">
          {copied === "failed"
            ? "Copying is blocked here. The link is selected, so press Ctrl+C."
            : "Paste it in a note or a chat. It opens this moment in Depo on this PC."}
        </p>
      </div>
      <form
        className="min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          open();
        }}
      >
        <label htmlFor={pasteId} className="mb-1 block text-[11px] text-muted">
          Open a moment someone shared
        </label>
        <div className="flex gap-1.5">
          <input
            id={pasteId}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setBad(false);
            }}
            placeholder="depo://team/..."
            aria-invalid={bad}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-panel px-2 font-mono text-[11px] text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="submit"
            className="h-7 shrink-0 rounded-md border border-border px-2.5 text-[11px] font-medium text-fg hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open
          </button>
        </div>
        <p className={cn("mt-1 text-[11px]", bad ? "text-danger" : "text-subtle")} aria-live="polite">
          {bad
            ? "That is not a Depo moment link. It starts with depo://team/."
            : "Links start with depo://team/."}
        </p>
      </form>
    </div>
  );
}

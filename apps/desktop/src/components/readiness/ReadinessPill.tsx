import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ReadinessCard } from "./ReadinessCard";
import { shortVerdict, VERDICT_STYLE } from "./readiness-view";
import { useReadiness } from "./use-readiness";

/**
 * "Ready", "2 warnings" or "Not ready" in a header. Opens the readiness card below it; Escape or
 * a click elsewhere closes it, and focus goes back to the pill.
 */
export function ReadinessPill({
  taskId,
  className,
  align = "end",
}: {
  taskId: string;
  className?: string;
  /** Which edge of the pill the card lines up with: end for a pill on the right of a header. */
  align?: "start" | "end";
}) {
  const report = useReadiness(taskId);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inside = !!wrap.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) {
        e.stopPropagation();
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const r = report.data;
  if (!r) return null;
  const style = VERDICT_STYLE[r.verdict];
  const Icon = style.icon;
  return (
    <div ref={wrap} className={cn("relative shrink-0", className)}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Readiness: ${r.headline}. ${open ? "Hide" : "Show"} details`}
        title={r.text}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium hover:opacity-90",
          style.pill,
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {shortVerdict(r)}
      </button>
      {open && (
        <div
          id={id}
          className={cn(
            "absolute top-full z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-lg shadow-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <ReadinessCard taskId={taskId} scrollable className="max-h-[70vh] overflow-y-auto" />
        </div>
      )}
    </div>
  );
}

/** A small "Ready" / "2 warnings" / "Not ready" next to a task in review. Text only, not a control. */
export function ReadinessBadge({ taskId }: { taskId: string }) {
  const report = useReadiness(taskId);
  const r = report.data;
  if (!r) return null;
  const style = VERDICT_STYLE[r.verdict];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-medium",
        style.pill,
      )}
      title={r.text}
      data-testid="readiness-badge"
    >
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">Readiness: </span>
      {shortVerdict(r)}
    </span>
  );
}

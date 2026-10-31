import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Drag handle between two panels. `onResize` receives the pointer delta since drag start.
 * Keyboard: arrow keys resize by 16px (accessible alternative to dragging).
 */
export function Splitter({
  orientation,
  label,
  onResizeStart,
  onResize,
  onKeyResize,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  onResizeStart: () => void;
  onResize: (delta: number) => void;
  onKeyResize: (delta: number) => void;
}) {
  const start = useRef<number | null>(null);
  const vertical = orientation === "vertical";

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = vertical ? e.clientX : e.clientY;
    onResizeStart();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    onResize((vertical ? e.clientX : e.clientY) - start.current);
  };
  const up = () => {
    start.current = null;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const map: Record<string, number> = vertical
      ? { ArrowLeft: -step, ArrowRight: step }
      : { ArrowUp: -step, ArrowDown: step };
    const d = map[e.key];
    if (d !== undefined) {
      e.preventDefault();
      onKeyResize(d);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the WAI-ARIA pattern for splitters.
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      aria-valuenow={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      className={cn(
        "group relative z-10 shrink-0 touch-none bg-border transition-colors hover:bg-accent focus-visible:bg-accent",
        vertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <span className={cn("absolute", vertical ? "inset-y-0 -inset-x-1.5" : "inset-x-0 -inset-y-1.5")} />
    </div>
  );
}

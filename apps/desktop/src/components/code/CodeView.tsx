import { Check, Copy, MessageCircleQuestion, Pencil, X } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Token } from "@/lib/highlight/tokens";
import { Tokens } from "./Tokens";

/** Selected lines, 1-based and inclusive (a <= b). */
export interface LineRange {
  a: number;
  b: number;
}

/** Lines per block; blocks off screen skip layout and paint (`content-visibility: auto`). */
const CHUNK = 200;
const LINE_PX = 19;
const PAGE = 20;
const FLASH_MS = 2400;

type Handlers = {
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onMouseDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => void;
};

const lineOf = (el: Element) => Number((el as HTMLElement).dataset.gutter);

/**
 * A file's lines with a gutter of line-number buttons ("Line N"). Click a number to select its
 * line, Shift+click or drag for a range, or select text with the mouse. From the keyboard: one tab
 * stop in the gutter, arrows move, Shift+arrows extend, Enter selects, Escape clears.
 * `goto` scrolls to a line and highlights it for a moment.
 */
export function CodeLines({
  lines,
  tokens,
  goto,
  range,
  onRange,
}: {
  lines: string[];
  /** Highlighted lines, or null to show plain text. */
  tokens: Token[][] | null;
  goto: { line: number; seq: number } | null;
  range: LineRange | null;
  onRange: (r: LineRange | null) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(() => (goto ? clampLine(goto.line, lines.length) : 1));
  const [flash, setFlash] = useState(0);
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);
  // The mouse went down in the gutter: its mouseup is not a text selection.
  const gutterDown = useRef(false);
  // Handlers read the latest values through a ref, so the line blocks can stay memoised.
  const live = useRef({ range, cursor, count: lines.length, onRange });
  live.current = { range, cursor, count: lines.length, onRange };

  useLayoutEffect(() => {
    if (!goto || lines.length === 0) return;
    const line = clampLine(goto.line, lines.length);
    setCursor(line);
    setFlash(line);
    boxRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView?.({ block: "center" });
    const t = window.setTimeout(() => setFlash(0), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [goto, lines.length]);

  useEffect(() => {
    if (!range) anchor.current = null;
  }, [range]);

  const focusLine = useCallback((line: number) => {
    boxRef.current?.querySelector<HTMLButtonElement>(`[data-gutter="${line}"]`)?.focus();
  }, []);

  const select = useCallback((line: number, extend: boolean) => {
    const { onRange: set } = live.current;
    const from = extend ? (anchor.current ?? live.current.cursor) : line;
    anchor.current = from;
    set({ a: Math.min(from, line), b: Math.max(from, line) });
    setCursor(line);
  }, []);

  const handlers = useRef<Handlers>({
    onClick: (e) => {
      const line = lineOf(e.currentTarget);
      window.getSelection?.()?.removeAllRanges();
      e.currentTarget.focus();
      if (!dragging.current) select(line, e.shiftKey);
      dragging.current = false;
    },
    onMouseDown: (e) => {
      if (e.button !== 0) return;
      // No text selection while picking lines in the gutter.
      e.preventDefault();
      gutterDown.current = true;
      if (e.shiftKey) return;
      dragging.current = false;
      select(lineOf(e.currentTarget), false);
    },
    onMouseEnter: (e) => {
      if ((e.buttons & 1) !== 1 || anchor.current === null) return;
      dragging.current = true;
      select(lineOf(e.currentTarget), true);
    },
    onKeyDown: (e) => {
      const line = lineOf(e.currentTarget);
      const { count, range: current } = live.current;
      const go = (to: number) => {
        e.preventDefault();
        const next = clampLine(to, count);
        if (e.shiftKey) select(next, true);
        else setCursor(next);
        focusLine(next);
      };
      switch (e.key) {
        case "ArrowDown":
          return go(line + 1);
        case "ArrowUp":
          return go(line - 1);
        case "PageDown":
          return go(line + PAGE);
        case "PageUp":
          return go(line - PAGE);
        case "Home":
          return go(1);
        case "End":
          return go(count);
        case "Enter":
        case " ":
          e.preventDefault();
          select(line, e.shiftKey);
          return;
        case "Escape":
          if (current) {
            e.preventDefault();
            live.current.onRange(null);
          }
          return;
      }
    },
  });

  // Text selected with the mouse selects its lines; a plain click in the code clears the selection.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onUp = (e: globalThis.MouseEvent) => {
      const fromGutter = gutterDown.current;
      gutterDown.current = false;
      if (fromGutter || (e.target as Element | null)?.closest?.("[data-gutter]")) return;
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        if (live.current.range) live.current.onRange(null);
        return;
      }
      const r = sel.getRangeAt(0);
      if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return;
      const rowOf = (n: Node) =>
        Number(
          (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>("[data-line]")?.dataset.line ??
            0,
        );
      const a = rowOf(r.startContainer);
      let b = rowOf(r.endContainer);
      // A selection that ends at the very start of a line (triple click) does not include that line.
      if (b > a && r.endOffset === 0) b--;
      if (!a || !b) return;
      anchor.current = a;
      setCursor(b);
      live.current.onRange({ a, b });
    };
    box.addEventListener("mouseup", onUp);
    return () => box.removeEventListener("mouseup", onUp);
  }, []);

  const chunks: number[] = [];
  for (let s = 0; s < lines.length; s += CHUNK) chunks.push(s);
  return (
    <div ref={boxRef} className="min-w-0 flex-1 py-1 font-mono text-[12px]">
      {chunks.map((start) => {
        const end = Math.min(lines.length, start + CHUNK);
        const inside = (n: number) => n > start && n <= end;
        const hit = range && range.a <= end && range.b > start;
        return (
          <Chunk
            key={start}
            start={start}
            end={end}
            lines={lines}
            tokens={tokens}
            selA={hit ? range.a : 0}
            selB={hit ? range.b : 0}
            cursor={inside(cursor) ? cursor : 0}
            flash={inside(flash) ? flash : 0}
            handlers={handlers.current}
          />
        );
      })}
    </div>
  );
}

function clampLine(n: number, count: number): number {
  return Math.max(1, Math.min(Math.max(1, count), Math.round(n)));
}

const Chunk = memo(function Chunk({
  start,
  end,
  lines,
  tokens,
  selA,
  selB,
  cursor,
  flash,
  handlers,
}: {
  start: number;
  end: number;
  lines: string[];
  tokens: Token[][] | null;
  selA: number;
  selB: number;
  cursor: number;
  flash: number;
  handlers: Handlers;
}) {
  const rows = [];
  for (let i = start; i < end; i++) {
    const n = i + 1;
    const picked = n >= selA && n <= selB && selA > 0;
    rows.push(
      <div
        key={n}
        data-line={n}
        className={cn(
          "flex scroll-mt-10 scroll-mb-16 transition-colors duration-700",
          picked && "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]",
          !picked && n === flash && "bg-accent-soft",
        )}
      >
        <button
          type="button"
          data-gutter={n}
          tabIndex={n === cursor ? 0 : -1}
          aria-label={`Line ${n}`}
          aria-pressed={picked}
          {...handlers}
          className={cn(
            "w-12 shrink-0 cursor-pointer select-none pr-3 text-right text-[11px] leading-[19px] tabular-nums hover:text-fg focus-visible:-outline-offset-2",
            picked ? "text-muted" : "text-subtle",
          )}
        >
          {n}
        </button>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 leading-[19px] text-fg">
          <Tokens tokens={tokens?.[i]} text={lines[i] ?? ""} />
        </span>
      </div>,
    );
  }
  return (
    <div style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${(end - start) * LINE_PX}px` }}>
      {rows}
    </div>
  );
});

/**
 * The floating bar for selected lines: ask Depo about them, start a change, or copy "path:line".
 * Left and right arrows move between its buttons; Escape clears the selection.
 */
export function SelectionBar({
  range,
  busy,
  error,
  canAsk,
  copied,
  onAsk,
  onChange,
  onCopy,
  onClear,
}: {
  range: LineRange;
  busy: boolean;
  error: string | null;
  canAsk: boolean;
  copied: "idle" | "copied" | "failed";
  onAsk: () => void;
  onChange: () => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  const label = range.a === range.b ? `Line ${range.a}` : `Lines ${range.a} to ${range.b}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClear();
      return;
    }
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 mt-auto flex flex-col items-center gap-1 px-3 pt-2 pb-3">
      {error && (
        <p
          role="alert"
          className="pointer-events-auto rounded-md bg-panel px-2 py-1 text-[11px] text-danger shadow-pop"
        >
          {error}
        </p>
      )}
      <div
        role="toolbar"
        aria-label="Selected lines"
        onKeyDown={onKeyDown}
        className="pointer-events-auto flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-1 shadow-pop"
      >
        <span className="px-2 text-[11px] font-medium text-muted tabular-nums">{label}</span>
        <Button size="sm" variant="ghost" onClick={onAsk} disabled={!canAsk || busy}>
          <MessageCircleQuestion aria-hidden />
          Ask about this
        </Button>
        <Button size="sm" variant="ghost" onClick={onChange}>
          <Pencil aria-hidden />
          Change this
        </Button>
        <Button size="sm" variant="ghost" onClick={onCopy}>
          {copied === "copied" ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
          Copy path:line
        </Button>
        <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={onClear}>
          <X aria-hidden />
        </Button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {copied === "copied"
          ? "Copied."
          : copied === "failed"
            ? "Could not copy. Your system blocked it."
            : ""}
      </p>
    </div>
  );
}

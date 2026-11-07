import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Stick-to-bottom scrolling for live logs and chat transcripts, the way Claude's chat behaves:
 *
 * - While the reader is at the end (within `threshold` px), new content keeps the view at the end,
 *   including text that grows in place (a streaming reply): a ResizeObserver watches the content.
 * - The moment they scroll up (wheel, keys, scrollbar drag, touch), the view never moves again on
 *   its own until they come back to the end, or call `jumpToLatest()` (for a "Jump to latest" pill).
 * - Expanding something inside the content (any click on an `[aria-expanded]` control or a
 *   `<summary>`) does not drag the view to the end; the reader keeps looking at what they opened.
 * - When content above the viewport changes size, the reader's position stays put: browsers with
 *   CSS scroll anchoring (Chromium, so WebView2 on Windows) do this natively, others get a fallback.
 * - `resetKey` (for example the open task's id) re-pins and jumps to the end once.
 *
 * Usage: put `scrollRef` on the scrolling element and `contentRef` on the element inside it that
 * holds the content (it must grow with the content, so no fixed height). For a virtualised list,
 * `contentRef` goes on the element sized to the list's total height.
 *
 *   const stick = useStickToBottom({ resetKey: taskId, count: items.length });
 *   <div ref={stick.scrollRef} className="overflow-y-auto"><div ref={stick.contentRef}>…</div></div>
 *   {!stick.pinned && <button onClick={stick.jumpToLatest}>Jump to latest</button>}
 */

/** Distance from the end (px) that still counts as "at the end". */
export const STICK_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/** Is the reader at, or within `threshold` px of, the end? */
export function isNearBottom(m: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/**
 * The decision after a scroll event: should the view keep following new content?
 * - At the very end: yes (this also covers the browser clamping the position when content shrinks).
 * - Moved up since the last event: no, the reader is looking at something.
 * - Moved down to within `threshold` of the end: yes, they came back.
 * - Otherwise nothing changes.
 */
export function pinnedAfterScroll(
  prev: { pinned: boolean; lastScrollTop: number },
  m: ScrollMetrics,
  threshold = STICK_THRESHOLD_PX,
): boolean {
  if (distanceFromBottom(m) <= 1) return true;
  if (m.scrollTop < prev.lastScrollTop - 1) return false;
  if (isNearBottom(m, threshold)) return true;
  return prev.pinned;
}

export interface StickToBottomOptions {
  /** Re-pin and jump to the end once whenever this value changes (for example the open task's id). */
  resetKey?: unknown;
  /** Px from the end that still counts as "at the end". Default 80. */
  threshold?: number;
  /** A number that grows with the content (items, messages), to count what arrived while away. */
  count?: number;
  /** Elements used to hold the reader's place where the browser has no scroll anchoring. */
  anchorSelector?: string;
}

export interface StickToBottom<S extends HTMLElement, C extends HTMLElement> {
  /** Put on the scrolling element. */
  scrollRef: (el: S | null) => void;
  /** Put on the content element inside it. */
  contentRef: (el: C | null) => void;
  /** True while the view follows new content. Show a "Jump to latest" control when false. */
  pinned: boolean;
  /** How much `count` grew since the reader scrolled away (0 while pinned). */
  newCount: number;
  /** Scroll smoothly to the end and follow new content again. */
  jumpToLatest: () => void;
  /** Do not follow the next content change (call before a change the reader made themselves). */
  keepPosition: () => void;
}

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function supportsScrollAnchoring(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("overflow-anchor", "auto")
  );
}

export function useStickToBottom<
  S extends HTMLElement = HTMLDivElement,
  C extends HTMLElement = HTMLDivElement,
>(options: StickToBottomOptions = {}): StickToBottom<S, C> {
  const { resetKey, threshold = STICK_THRESHOLD_PX, count = 0, anchorSelector = ":scope > *" } = options;
  const [scrollEl, setScrollEl] = useState<S | null>(null);
  const [contentEl, setContentEl] = useState<C | null>(null);
  const [pinned, setPinnedState] = useState(true);
  const [leftAt, setLeftAt] = useState<number | null>(null);

  const pinnedRef = useRef(true);
  const lastTopRef = useRef(0);
  const animatingRef = useRef(false);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepUntil = useRef(0);
  const draggingRef = useRef(false);
  const countRef = useRef(count);
  countRef.current = count;
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  /** Fallback anchoring: the element at the top of the view and its offset from the view's top. */
  const anchorRef = useRef<{ el: Element; top: number } | null>(null);

  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinnedState(next);
    setLeftAt(next ? null : countRef.current);
  }, []);

  const stopAnimating = useCallback(() => {
    animatingRef.current = false;
    if (animTimer.current) clearTimeout(animTimer.current);
    animTimer.current = null;
  }, []);

  const toEnd = useCallback((el: S, smooth: boolean) => {
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (smooth && typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
    if (!smooth) lastTopRef.current = el.scrollTop;
  }, []);

  const recordAnchor = useCallback(() => {
    if (!scrollEl || !contentEl || pinnedRef.current) return;
    const viewTop = scrollEl.getBoundingClientRect().top;
    let best: { el: Element; top: number } | null = null;
    for (const el of contentEl.querySelectorAll(anchorSelector)) {
      const r = el.getBoundingClientRect();
      const top = r.top - viewTop;
      if (r.bottom - viewTop <= 0) continue;
      // The element that starts closest above (or at) the top of the view, else the first one below.
      if (top <= 0 ? !best || best.top > 0 || top > best.top : !best) best = { el, top };
    }
    anchorRef.current = best;
  }, [scrollEl, contentEl, anchorSelector]);

  // Scroll, wheel, key and pointer handling on the scrolling element.
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const nativeAnchoring = supportsScrollAnchoring();
    let raf = 0;
    const onScroll = () => {
      const m = { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
      if (animatingRef.current) {
        if (distanceFromBottom(m) <= 1) stopAnimating();
        else if (m.scrollTop < lastTopRef.current - 1) {
          stopAnimating();
          setPinned(false);
        }
      } else {
        setPinned(
          pinnedAfterScroll(
            { pinned: pinnedRef.current, lastScrollTop: lastTopRef.current },
            m,
            thresholdRef.current,
          ),
        );
      }
      lastTopRef.current = m.scrollTop;
      if (!nativeAnchoring && !pinnedRef.current) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(recordAnchor);
      }
    };
    const leave = () => {
      if (el.scrollHeight <= el.clientHeight) return;
      stopAnimating();
      setPinned(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) leave();
    };
    const onKey = (e: KeyboardEvent) => {
      if (UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) leave();
    };
    // Dragging the scrollbar: the press lands on the scrolling element itself.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === el) draggingRef.current = true;
    };
    const onTouchStart = () => {
      draggingRef.current = true;
    };
    const onRelease = () => {
      draggingRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("touchend", onRelease);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("touchend", onRelease);
    };
  }, [scrollEl, setPinned, stopAnimating, recordAnchor]);

  // Follow size changes of the content (new items, streaming text) and of the view itself.
  useEffect(() => {
    const el = scrollEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const nativeAnchoring = supportsScrollAnchoring();
    const onResize = () => {
      if (Date.now() < keepUntil.current) {
        // The reader opened something: stay where they are, and stop following if that moved the end away.
        setPinned(isNearBottom(el, thresholdRef.current));
        lastTopRef.current = el.scrollTop;
        return;
      }
      if (pinnedRef.current && !draggingRef.current) {
        toEnd(el, animatingRef.current);
        return;
      }
      // Not following: hold the reader's place if the browser does not.
      const a = anchorRef.current;
      if (!nativeAnchoring && a?.el.isConnected) {
        const top = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const delta = top - a.top;
        if (Math.abs(delta) >= 1) {
          el.scrollTop += delta;
          lastTopRef.current = el.scrollTop;
        }
      }
      recordAnchor();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    if (contentEl) ro.observe(contentEl);
    return () => ro.disconnect();
  }, [scrollEl, contentEl, setPinned, toEnd, recordAnchor]);

  // A click on an expander inside the content: the change that follows is the reader's own.
  useEffect(() => {
    const el = contentEl;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[aria-expanded], summary")) keepUntil.current = Date.now() + 250;
    };
    el.addEventListener("click", onClick, true);
    return () => el.removeEventListener("click", onClick, true);
  }, [contentEl]);

  // A new subject (another task): follow from the end again, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the subject changes
  useLayoutEffect(() => {
    stopAnimating();
    pinnedRef.current = true;
    setPinnedState(true);
    setLeftAt(null);
    if (scrollEl) toEnd(scrollEl, false);
  }, [resetKey, scrollEl]);

  useEffect(() => stopAnimating, [stopAnimating]);

  const jumpToLatest = useCallback(() => {
    const el = scrollEl;
    if (!el) return;
    setPinned(true);
    const smooth = !reducedMotion() && distanceFromBottom(el) > 4;
    if (smooth) {
      animatingRef.current = true;
      if (animTimer.current) clearTimeout(animTimer.current);
      animTimer.current = setTimeout(() => {
        animatingRef.current = false;
        if (pinnedRef.current) toEnd(el, false);
      }, 900);
    }
    toEnd(el, smooth);
  }, [scrollEl, setPinned, toEnd]);

  const keepPosition = useCallback(() => {
    keepUntil.current = Date.now() + 250;
  }, []);

  return {
    scrollRef: setScrollEl,
    contentRef: setContentEl,
    pinned,
    newCount: pinned || leftAt === null ? 0 : Math.max(0, count - leftAt),
    jumpToLatest,
    keepPosition,
  };
}

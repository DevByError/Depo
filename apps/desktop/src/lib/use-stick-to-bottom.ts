import { useCallback, useEffect, useRef, useState } from "react";

/** How close to the end still counts as "at the bottom", in pixels. */
const NEAR_BOTTOM = 40;

/**
 * Follow new rows in a scrolling list only while the reader is at the bottom. Scrolling up stops
 * the following (the view is never pulled away from what they read) and counts the rows that
 * arrive meanwhile, for a "Jump to latest" pill.
 *
 * `lastKey` is the key of the newest row: rows added in front (older ones) do not move the view.
 */
export function useStickToBottom(
  count: number,
  lastKey: string | null,
  scrollToEnd: () => void,
  enabled = true,
) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const last = useRef({ count, key: lastKey });
  // Scroll events caused by our own scrolling are not the reader's choice.
  const programmatic = useRef(0);
  const scrollRef = useRef(scrollToEnd);
  scrollRef.current = scrollToEnd;

  const follow = useCallback(() => {
    programmatic.current = performance.now();
    scrollRef.current();
  }, []);

  const setBottom = useCallback((v: boolean) => {
    atBottomRef.current = v;
    setAtBottom(v);
    if (v) setUnseen(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    // Right after a programmatic scroll the list may still be measuring rows; only a move away
    // from the bottom after that settles counts as the reader scrolling up.
    if (!bottom && performance.now() - programmatic.current < 150) return;
    if (bottom !== atBottomRef.current) setBottom(bottom);
    else if (bottom) setUnseen(0);
  }, [setBottom]);

  useEffect(() => {
    const prev = last.current;
    last.current = { count, key: lastKey };
    if (!enabled || count === 0 || lastKey === prev.key) return;
    if (atBottomRef.current) follow();
    else if (count > prev.count) setUnseen((n) => n + (count - prev.count));
  }, [count, lastKey, enabled, follow]);

  const jumpToLatest = useCallback(() => {
    setBottom(true);
    follow();
  }, [follow, setBottom]);

  /** Follow again from the next change (for example after the filter changed). */
  const reset = useCallback(() => setBottom(true), [setBottom]);

  /** Stop following (for example when the reader asks for older rows). */
  const release = useCallback(() => {
    atBottomRef.current = false;
    setAtBottom(false);
  }, []);

  return { ref, atBottom, unseen, onScroll, jumpToLatest, reset, release };
}

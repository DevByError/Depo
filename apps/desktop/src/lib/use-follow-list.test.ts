import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useFollowList } from "./use-follow-list";

afterEach(() => vi.restoreAllMocks());

test("follows new rows only while the reader is at the bottom", () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const scroll = vi.fn();
  const { result, rerender } = renderHook(({ count, last }) => useFollowList(count, last, scroll), {
    initialProps: { count: 3, last: "c" },
  });
  // The backlog on mount is followed.
  expect(scroll).toHaveBeenCalledTimes(1);
  rerender({ count: 4, last: "d" });
  expect(scroll).toHaveBeenCalledTimes(2);

  // The reader scrolls up (well after our own scroll).
  const el = { scrollHeight: 1000, scrollTop: 200, clientHeight: 300 };
  result.current.ref.current = el as unknown as HTMLDivElement;
  now += 1000;
  act(() => result.current.onScroll());
  expect(result.current.atBottom).toBe(false);

  // New rows do not move the view; they are counted for the pill.
  rerender({ count: 6, last: "f" });
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(result.current.unseen).toBe(2);

  // Older rows added in front are neither followed nor counted as new.
  rerender({ count: 9, last: "f" });
  expect(result.current.unseen).toBe(2);

  act(() => result.current.jumpToLatest());
  expect(scroll).toHaveBeenCalledTimes(3);
  expect(result.current.atBottom).toBe(true);
  expect(result.current.unseen).toBe(0);

  // A scroll event right after our own scroll (rows still being measured) is not the reader's.
  el.scrollTop = 100;
  act(() => result.current.onScroll());
  expect(result.current.atBottom).toBe(true);

  // Reaching the bottom by hand starts following again.
  now += 1000;
  act(() => result.current.onScroll());
  expect(result.current.atBottom).toBe(false);
  el.scrollTop = 690;
  act(() => result.current.onScroll());
  expect(result.current.atBottom).toBe(true);
  rerender({ count: 10, last: "g" });
  expect(scroll).toHaveBeenCalledTimes(4);
});

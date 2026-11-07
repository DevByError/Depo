import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  isNearBottom,
  pinnedAfterScroll,
  STICK_THRESHOLD_PX,
  useStickToBottom,
} from "./use-stick-to-bottom";

describe("stick-to-bottom decisions", () => {
  const view = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it("measures the distance from the end", () => {
    expect(distanceFromBottom(view(1500))).toBe(0);
    expect(distanceFromBottom(view(1400))).toBe(100);
    expect(distanceFromBottom(view(0, 300, 500))).toBe(0);
  });

  it("counts the last ~80 px as the end", () => {
    expect(STICK_THRESHOLD_PX).toBe(80);
    expect(isNearBottom(view(1500))).toBe(true);
    expect(isNearBottom(view(1420))).toBe(true);
    expect(isNearBottom(view(1419))).toBe(false);
    expect(isNearBottom(view(1400), 120)).toBe(true);
  });

  it("stops following the moment the reader scrolls up, even a little", () => {
    expect(pinnedAfterScroll({ pinned: true, lastScrollTop: 1500 }, view(1480))).toBe(false);
    expect(pinnedAfterScroll({ pinned: true, lastScrollTop: 1500 }, view(900))).toBe(false);
  });

  it("follows again once the reader is back near the end", () => {
    expect(pinnedAfterScroll({ pinned: false, lastScrollTop: 1000 }, view(1430))).toBe(true);
    expect(pinnedAfterScroll({ pinned: false, lastScrollTop: 1000 }, view(1200))).toBe(false);
    expect(pinnedAfterScroll({ pinned: false, lastScrollTop: 1600 }, view(1500))).toBe(true);
  });

  it("content that grows or shrinks does not unpin by itself", () => {
    // Our own jump to the new end: moving down.
    expect(pinnedAfterScroll({ pinned: true, lastScrollTop: 1500 }, view(2500, 3000))).toBe(true);
    // The browser clamped the position after content shrank: at the very end.
    expect(pinnedAfterScroll({ pinned: true, lastScrollTop: 1500 }, view(700, 1200))).toBe(true);
    // Moving down but still far away keeps the previous choice.
    expect(pinnedAfterScroll({ pinned: true, lastScrollTop: 100 }, view(200))).toBe(true);
    expect(pinnedAfterScroll({ pinned: false, lastScrollTop: 100 }, view(200))).toBe(false);
  });
});

/** jsdom has no layout: give the scrolling element a fake size and position. */
function fakeLayout(el: HTMLElement, size: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => size.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, size.scrollHeight - size.clientHeight));
    },
  });
}

function Probe({ count }: { count: number }) {
  const stick = useStickToBottom({ count, resetKey: "task-1" });
  return (
    <div>
      <div data-testid="scroller" ref={stick.scrollRef}>
        <div ref={stick.contentRef} />
      </div>
      <output data-testid="pinned">{String(stick.pinned)}</output>
      <output data-testid="new">{stick.newCount}</output>
      <button type="button" onClick={stick.jumpToLatest}>
        Jump to latest
      </button>
    </div>
  );
}

describe("useStickToBottom", () => {
  afterEach(cleanup);

  it("unpins on scroll up, counts what arrives, and jumps back", () => {
    const { rerender } = render(<Probe count={3} />);
    const el = screen.getByTestId("scroller");
    const size = { scrollHeight: 2000, clientHeight: 500 };
    fakeLayout(el, size);
    el.scrollTop = 1500;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned").textContent).toBe("true");

    // The reader wheels up.
    fireEvent.wheel(el, { deltaY: -100 });
    el.scrollTop = 1400;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned").textContent).toBe("false");

    // Two new items arrive while away.
    rerender(<Probe count={5} />);
    expect(screen.getByTestId("new").textContent).toBe("2");

    // Jump to latest: back at the end and following.
    act(() => {
      screen.getByRole("button", { name: "Jump to latest" }).click();
    });
    expect(screen.getByTestId("pinned").textContent).toBe("true");
    expect(screen.getByTestId("new").textContent).toBe("0");
    expect(el.scrollTop).toBe(1500);
  });

  it("re-pins when the reader scrolls back down near the end", () => {
    render(<Probe count={1} />);
    const el = screen.getByTestId("scroller");
    fakeLayout(el, { scrollHeight: 2000, clientHeight: 500 });
    el.scrollTop = 1500;
    fireEvent.scroll(el);
    el.scrollTop = 600;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned").textContent).toBe("false");
    el.scrollTop = 1450;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned").textContent).toBe("true");
  });

  it("keyboard scrolling up stops following", () => {
    render(<Probe count={1} />);
    const el = screen.getByTestId("scroller");
    fakeLayout(el, { scrollHeight: 2000, clientHeight: 500 });
    fireEvent.keyDown(el, { key: "PageUp" });
    expect(screen.getByTestId("pinned").textContent).toBe("false");
  });
});

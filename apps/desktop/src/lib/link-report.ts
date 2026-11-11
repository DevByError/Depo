import type { ClientReport } from "@depo/shared";
import type { LinkClose } from "./engine-client";

/**
 * What the window tells the engine after it connects again, so a dropped link can be explained
 * from the engine log: how the last link ended, whether the page was reloaded (F5, or a crashed
 * window that was opened again) and how long the window itself froze.
 */

const LOADS_KEY = "depo.pageLoads";

/** Count this load of the window; more than 1 in one session means it was reloaded. */
export function countPageLoad(storage: Pick<Storage, "getItem" | "setItem"> | undefined): number {
  try {
    const n = Number.parseInt(storage?.getItem(LOADS_KEY) ?? "0", 10);
    const next = (Number.isFinite(n) && n > 0 ? n : 0) + 1;
    storage?.setItem(LOADS_KEY, String(next));
    return next;
  } catch {
    return 1;
  }
}

/** Window freezes (long tasks of a second or more) since the last report. */
export class FreezeMeter {
  private count = 0;
  private longest = 0;

  add(durationMs: number): void {
    if (durationMs < 1000) return;
    this.count++;
    this.longest = Math.max(this.longest, durationMs);
  }

  /** Read and reset. */
  take(): { freezes: number; longestFreezeMs: number } {
    const r = { freezes: this.count, longestFreezeMs: Math.round(this.longest) };
    this.count = 0;
    this.longest = 0;
    return r;
  }

  /** Watch the window's long tasks where the browser can (WebView2 and Chromium can). */
  observe(): void {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.add(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Not supported here: freezes are reported as 0.
    }
  }
}

export function buildReport(o: {
  close: LinkClose | null;
  connects: number;
  pageLoads: number;
  freezes: { freezes: number; longestFreezeMs: number };
  visible: boolean;
  now?: number;
}): ClientReport {
  const now = o.now ?? Date.now();
  return {
    connects: o.connects,
    pageLoads: o.pageLoads,
    lastClose: o.close
      ? {
          code: o.close.code,
          reason: o.close.reason.slice(0, 200),
          clean: o.close.clean,
          agoMs: Math.max(0, now - o.close.at),
          downMs: o.close.downMs,
          attempts: o.close.attempts,
        }
      : null,
    freezes: o.freezes.freezes,
    longestFreezeMs: o.freezes.longestFreezeMs,
    visible: o.visible,
  };
}

/** Worth a line in the engine log: the link dropped, the window was reloaded, or it froze. */
export function worthReporting(r: ClientReport): boolean {
  return r.lastClose !== null || r.pageLoads > 1 || r.freezes > 0;
}

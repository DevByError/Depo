import type { SearchTarget } from "@depo/shared";
import { create } from "zustand";
import { useUi } from "./ui";

/**
 * "Open this there" requests from search (Ctrl+K) and other jumps. A screen that can show the
 * target reads its request, shows it, and clears it. Each request has a number, so asking for
 * the same place twice still moves there.
 */
interface NavState {
  /** Files tab: this file, at this line. */
  file: { path: string; line: number | null; seq: number } | null;
  /** Memory tab: this item (project or global memory). */
  memory: { factId: string; global: boolean; seq: number } | null;
  /** Logs tab: filter to this text. */
  logsText: { text: string; seq: number } | null;
  clearFile(): void;
  clearMemory(): void;
  clearLogsText(): void;
}

let seq = 0;

export const useNav = create<NavState>((set) => ({
  file: null,
  memory: null,
  logsText: null,
  clearFile: () => set({ file: null }),
  clearMemory: () => set({ memory: null }),
  clearLogsText: () => set({ logsText: null }),
}));

/** The highlight a revealed element gets for a moment. */
const FLASH = ["ring-2", "ring-accent", "rounded-md"];

/**
 * Wait until an element exists (the screen may still be loading), scroll it into view and
 * highlight it briefly. Gives up quietly after `timeoutMs`.
 */
export function revealWhenReady(selector: string, timeoutMs = 4000): void {
  if (typeof document === "undefined") return;
  const started = Date.now();
  const tick = () => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      el.classList.add(...FLASH);
      window.setTimeout(() => el.classList.remove(...FLASH), 2400);
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tick, 80);
  };
  window.setTimeout(tick, 0);
}

/** Open a search result where it belongs. */
export function openSearchTarget(target: SearchTarget): void {
  const ui = useUi.getState();
  switch (target.kind) {
    case "file":
      useNav.setState({ file: { path: target.path, line: target.line, seq: ++seq } });
      ui.setCenterTab("files");
      return;
    case "task":
      ui.setTaskId(target.taskId);
      ui.setCenterTab("chat");
      return;
    case "decision":
      ui.setTaskId(target.taskId);
      ui.setCenterTab("team");
      revealWhenReady(`[data-decision-id="${cssEscape(target.eventId)}"]`);
      return;
    case "memory":
      useNav.setState({ memory: { factId: target.factId, global: target.global, seq: ++seq } });
      ui.setCenterTab("memory");
      revealWhenReady(`[data-memory-id="${cssEscape(target.factId)}"]`);
      return;
    case "log":
      useNav.setState({ logsText: { text: target.text, seq: ++seq } });
      ui.openLogs(target.taskId);
      return;
  }
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(s)
    : s.replace(/["\\]/g, "\\$&");
}

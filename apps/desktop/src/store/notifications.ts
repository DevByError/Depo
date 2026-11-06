import { create } from "zustand";
import type { Notice } from "@/lib/notify";

export interface StoredNotice extends Notice {
  id: number;
  at: number;
  read: boolean;
}

const MAX = 50;
let counter = 0;

interface NotificationState {
  items: StoredNotice[];
  enabled: boolean;
  setEnabled(v: boolean): void;
  push(n: Notice): StoredNotice;
  markAllRead(): void;
  clear(): void;
}

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  enabled: true,
  setEnabled: (enabled) => set({ enabled }),
  push(n) {
    const item: StoredNotice = { ...n, id: ++counter, at: Date.now(), read: false };
    set((s) => ({ items: [item, ...s.items].slice(0, MAX) }));
    return item;
  },
  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),
  clear: () => set({ items: [] }),
}));

/** Show a system notification when the window is in the background. Never throws. */
export function systemNotify(n: Notice): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && !document.hidden && document.hasFocus()) return;
    new Notification(n.title, { body: n.text.slice(0, 200), tag: n.taskId ?? undefined });
  } catch {
    // Notifications are a convenience only.
  }
}

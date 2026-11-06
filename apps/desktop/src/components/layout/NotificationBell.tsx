import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";
import { useNotifications } from "@/store/notifications";
import { useUi } from "@/store/ui";

/** The bell in the status bar: things that need you, and tasks that finished. */
export function NotificationBell() {
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clear = useNotifications((s) => s.clear);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = items.filter((i) => !i.read).length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (taskId: string | null, title: string) => {
    const ui = useUi.getState();
    if (taskId) ui.setTaskId(taskId);
    ui.setCenterTab(title.startsWith("Changes") ? "diff" : "chat");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markAllRead();
        }}
        className="relative flex h-6 w-6 items-center justify-center rounded text-subtle hover:bg-hover hover:text-fg"
      >
        <Bell className="size-3.5" aria-hidden />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 bottom-8 z-50 w-80 rounded-lg border border-border bg-panel p-2 shadow-2xl"
        >
          <div className="mb-1 flex items-center px-1">
            <span className="text-xs font-semibold text-fg">Notifications</span>
            {items.length > 0 && (
              <button type="button" onClick={clear} className="ml-auto text-[11px] text-muted hover:text-fg">
                Clear
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted">
              Nothing yet. You will see approvals and finished tasks here.
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => go(n.taskId, n.title)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <div
                      className={cn(
                        "text-xs font-medium",
                        n.level === "problem"
                          ? "text-danger"
                          : n.level === "attention"
                            ? "text-warning"
                            : "text-fg",
                      )}
                    >
                      {n.title}
                    </div>
                    <div className="line-clamp-2 text-[11px] text-muted">{n.text}</div>
                    <div className="text-[10px] text-subtle">
                      {formatRelative(new Date(n.at).toISOString())}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

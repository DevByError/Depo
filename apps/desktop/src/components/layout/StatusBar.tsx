import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { ConnectionDot, connectionLabel } from "@/components/panels/ConnectionBadge";
import { HeartbeatPulse } from "@/components/panels/HeartbeatPulse";
import { cn } from "@/lib/cn";
import { useEngine } from "@/store/engine";
import { useUi } from "@/store/ui";
import { NotificationBell } from "./NotificationBell";

function Toggle({
  on,
  label,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded hover:bg-hover",
        on ? "text-fg" : "text-subtle",
      )}
    >
      {children}
    </button>
  );
}

export function StatusBar() {
  const status = useEngine((s) => s.status);
  const info = useEngine((s) => s.info);
  const eventCount = useEngine((s) => s.events.length);
  const ui = useUi();

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted">
      <span className="inline-flex items-center gap-1.5" data-testid="connection-status">
        <ConnectionDot status={status} />
        Engine {connectionLabel(status).toLowerCase()}
      </span>
      <HeartbeatPulse />
      {info && <span className="hidden sm:inline">v{info.engineVersion}</span>}
      <span className="hidden md:inline">{eventCount} events</span>
      <span className="ml-auto inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => ui.setPaletteOpen(true)}
          className="mr-1 hidden rounded border border-border px-1.5 py-px text-[10px] text-subtle hover:text-fg sm:inline"
          aria-label="Open the command palette (Ctrl+K)"
        >
          Ctrl+K
        </button>
        <NotificationBell />
        <Toggle on={ui.sidebarOpen} label="Toggle sidebar (Ctrl+B)" onClick={() => ui.toggle("sidebarOpen")}>
          <PanelLeft className="size-3.5" aria-hidden />
        </Toggle>
        <Toggle
          on={ui.bottomOpen}
          label="Toggle bottom panel (Ctrl+J)"
          onClick={() => ui.toggle("bottomOpen")}
        >
          <PanelBottom className="size-3.5" aria-hidden />
        </Toggle>
        <Toggle
          on={ui.rightOpen}
          label="Toggle activity panel (Ctrl+L)"
          onClick={() => ui.toggle("rightOpen")}
        >
          <PanelRight className="size-3.5" aria-hidden />
        </Toggle>
      </span>
    </footer>
  );
}

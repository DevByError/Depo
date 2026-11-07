import { Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { setTheme } from "@/lib/engine";
import { useUi } from "@/store/ui";
import { moveInTabs, toolTabs } from "./CenterTabs";

/**
 * The narrow rail at the window's left edge: show or hide the projects sidebar, the tool screens
 * (as icon tabs with tooltips), and settings and theme at the bottom. It stays visible on small windows.
 */
export function ToolRail() {
  const active = useUi((s) => s.centerTab);
  const setActive = useUi((s) => s.setCenterTab);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const toggle = useUi((s) => s.toggle);
  const theme = useUi((s) => s.theme);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const tools = toolTabs();
  const inRail = tools.some((t) => t.id === active);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = moveInTabs(tools, active, e.key, true);
    if (!tab) return;
    e.preventDefault();
    setActive(tab.id);
    document.getElementById(`tab-${tab.id}`)?.focus();
  };

  return (
    <nav
      aria-label="Tools"
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-panel py-1.5"
    >
      <RailButton
        label={sidebarOpen ? "Hide projects (Ctrl+B)" : "Show projects (Ctrl+B)"}
        pressed={sidebarOpen}
        onClick={() => toggle("sidebarOpen")}
      >
        {sidebarOpen ? (
          <PanelLeftClose className="size-4" aria-hidden />
        ) : (
          <PanelLeftOpen className="size-4" aria-hidden />
        )}
      </RailButton>
      <div className="my-1.5 h-px w-6 bg-border" aria-hidden />
      <div
        role="tablist"
        aria-label="Tools"
        aria-orientation="vertical"
        onKeyDown={onKey}
        className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto"
      >
        {tools.map((t, i) => {
          const Icon = t.icon;
          const selected = t.id === active;
          return (
            <Tooltip key={t.id} content={t.label} side="right">
              <button
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                aria-label={t.label}
                aria-selected={selected}
                aria-controls={`panel-${t.id}`}
                tabIndex={selected || (!inRail && i === 0) ? 0 : -1}
                onClick={() => setActive(t.id)}
                className={cn(
                  "relative flex size-9 shrink-0 items-center justify-center rounded-md transition-colors",
                  "before:absolute before:top-2 before:bottom-2 before:-left-1.5 before:w-0.5 before:rounded-full",
                  selected
                    ? "bg-accent-soft text-accent before:bg-accent"
                    : "text-muted before:bg-transparent hover:bg-hover hover:text-fg",
                )}
              >
                <Icon className="size-[18px]" aria-hidden />
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-col items-center gap-0.5 border-t border-border pt-1.5">
        <RailButton
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => void setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </RailButton>
        <RailButton label="Settings (Ctrl+,)" onClick={() => setSettingsOpen(true)}>
          <Settings className="size-4" aria-hidden />
        </RailButton>
      </div>
    </nav>
  );
}

function RailButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {children}
      </button>
    </Tooltip>
  );
}

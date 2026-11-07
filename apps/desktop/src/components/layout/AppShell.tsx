import { useEffect, useRef, useState } from "react";
import { SettingsDialog } from "@/components/panels/SettingsDialog";
import { ProjectDialogs } from "@/components/projects/ProjectDialogs";
import { Splitter } from "@/components/ui/splitter";
import { clamp, LAYOUT_LIMITS, useUi } from "@/store/ui";
import { CenterTabs } from "./CenterTabs";
import { CommandPalette } from "./CommandPalette";
import { OnboardingDialog } from "./OnboardingDialog";
import { Sidebar } from "./Sidebar";
import { BottomPanel, RightPanel } from "./SidePanels";
import { StatusBar } from "./StatusBar";
import { ToolRail } from "./ToolRail";

/** Global shortcuts. Ctrl+B sidebar, Ctrl+J bottom panel, Ctrl+L activity panel, Ctrl+, settings, Ctrl+K command palette. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const ui = useUi.getState();
      const k = e.key.toLowerCase();
      if (k === "b") ui.toggle("sidebarOpen");
      else if (k === "j") ui.toggle("bottomOpen");
      else if (k === "l") ui.toggle("rightOpen");
      else if (k === ",") ui.setSettingsOpen(true);
      else if (k === "k") ui.setPaletteOpen(!ui.paletteOpen);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** Keep the center usable on small windows: side panels give way before the center drops below this. */
const MIN_CENTER = 460 + 48; // plus the tool rail
/** Below these window widths a side panel floats over the center as a drawer instead of squeezing it. */
export const RIGHT_DRAWER_BELOW = 1180;
export const LEFT_DRAWER_BELOW = 860;

/**
 * When the window crosses into drawer mode, close the panel (a drawer should not cover the work on its own)
 * and reopen it when the window is wide again, if it was open before.
 */
function useDrawerMode(panel: "sidebarOpen" | "rightOpen", drawer: boolean) {
  const reopen = useRef(false);
  const was = useRef(drawer);
  useEffect(() => {
    if (was.current === drawer) return;
    was.current = drawer;
    const ui = useUi.getState();
    if (drawer && ui[panel]) {
      reopen.current = true;
      ui.setLayout({ [panel]: false });
    } else if (!drawer && reopen.current) {
      reopen.current = false;
      ui.setLayout({ [panel]: true });
    }
  }, [drawer, panel]);
  // Escape closes an open drawer.
  const open = useUi((s) => s[panel]);
  useEffect(() => {
    if (!drawer || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) useUi.getState().setLayout({ [panel]: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, open, panel]);
}

function Scrim({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onClick={onClose}
      className="absolute inset-0 z-20 cursor-default bg-black/35 backdrop-blur-[1px]"
    />
  );
}

export function AppShell() {
  useShortcuts();
  const ui = useUi();
  const startSize = useRef(0);
  const windowWidth = useWindowWidth();
  const leftDrawer = windowWidth < LEFT_DRAWER_BELOW;
  const rightDrawer = windowWidth < RIGHT_DRAWER_BELOW;
  useDrawerMode("sidebarOpen", leftDrawer);
  useDrawerMode("rightOpen", rightDrawer);
  const drawerMax = Math.max(280, windowWidth - 112);
  const sidebarWidth = leftDrawer
    ? Math.min(ui.sidebarWidth, drawerMax)
    : ui.sidebarOpen
      ? Math.min(
          ui.sidebarWidth,
          Math.max(
            LAYOUT_LIMITS.sidebarWidth[0],
            windowWidth - MIN_CENTER - (ui.rightOpen && !rightDrawer ? LAYOUT_LIMITS.rightWidth[0] : 0),
          ),
        )
      : 0;
  const rightWidth = rightDrawer
    ? Math.min(ui.rightWidth, drawerMax)
    : Math.min(
        ui.rightWidth,
        Math.max(LAYOUT_LIMITS.rightWidth[0], windowWidth - MIN_CENTER - (leftDrawer ? 0 : sidebarWidth)),
      );

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1">
        <ToolRail />
        {ui.sidebarOpen && leftDrawer && (
          <>
            <Scrim label="Close sidebar" onClose={() => ui.setLayout({ sidebarOpen: false })} />
            <div
              style={{ width: sidebarWidth }}
              className="absolute inset-y-0 left-12 z-30 border-r border-border shadow-drawer"
            >
              <Sidebar />
            </div>
          </>
        )}
        {ui.sidebarOpen && !leftDrawer && (
          <>
            <div style={{ width: sidebarWidth }} className="shrink-0">
              <Sidebar />
            </div>
            <Splitter
              orientation="vertical"
              label="Resize sidebar"
              onResizeStart={() => {
                startSize.current = sidebarWidth;
              }}
              onResize={(d) =>
                ui.setLayout({ sidebarWidth: clamp(startSize.current + d, LAYOUT_LIMITS.sidebarWidth) })
              }
              onKeyResize={(d) =>
                ui.setLayout({ sidebarWidth: clamp(sidebarWidth + d, LAYOUT_LIMITS.sidebarWidth) })
              }
            />
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1">
            <CenterTabs />
          </main>
          {ui.bottomOpen && (
            <>
              <Splitter
                orientation="horizontal"
                label="Resize bottom panel"
                onResizeStart={() => {
                  startSize.current = ui.bottomHeight;
                }}
                onResize={(d) =>
                  ui.setLayout({ bottomHeight: clamp(startSize.current - d, LAYOUT_LIMITS.bottomHeight) })
                }
                onKeyResize={(d) =>
                  ui.setLayout({ bottomHeight: clamp(ui.bottomHeight - d, LAYOUT_LIMITS.bottomHeight) })
                }
              />
              <div style={{ height: ui.bottomHeight }} className="shrink-0">
                <BottomPanel />
              </div>
            </>
          )}
        </div>

        {ui.rightOpen && rightDrawer && (
          <>
            <Scrim label="Close activity panel" onClose={() => ui.setLayout({ rightOpen: false })} />
            <div
              style={{ width: rightWidth }}
              className="absolute inset-y-0 right-0 z-30 border-l border-border shadow-drawer"
            >
              <RightPanel />
            </div>
          </>
        )}
        {ui.rightOpen && !rightDrawer && (
          <>
            <Splitter
              orientation="vertical"
              label="Resize activity panel"
              onResizeStart={() => {
                startSize.current = rightWidth;
              }}
              onResize={(d) =>
                ui.setLayout({ rightWidth: clamp(startSize.current - d, LAYOUT_LIMITS.rightWidth) })
              }
              onKeyResize={(d) =>
                ui.setLayout({ rightWidth: clamp(rightWidth - d, LAYOUT_LIMITS.rightWidth) })
              }
            />
            <div style={{ width: rightWidth }} className="shrink-0">
              <RightPanel />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <SettingsDialog />
      <CommandPalette />
      <OnboardingDialog />
      <ProjectDialogs />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { SettingsDialog } from "@/components/panels/SettingsDialog";
import { ProjectDialogs } from "@/components/projects/ProjectDialogs";
import { Splitter } from "@/components/ui/splitter";
import { clamp, LAYOUT_LIMITS, useUi } from "@/store/ui";
import { CenterTabs } from "./CenterTabs";
import { Sidebar } from "./Sidebar";
import { BottomPanel, RightPanel } from "./SidePanels";
import { StatusBar } from "./StatusBar";

/** Global shortcuts. Ctrl+B sidebar, Ctrl+J bottom panel, Ctrl+L activity panel, Ctrl+, settings. */
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
const MIN_CENTER = 460;

export function AppShell() {
  useShortcuts();
  const ui = useUi();
  const startSize = useRef(0);
  const windowWidth = useWindowWidth();
  const sidebarWidth = ui.sidebarOpen
    ? Math.min(
        ui.sidebarWidth,
        Math.max(
          LAYOUT_LIMITS.sidebarWidth[0],
          windowWidth - MIN_CENTER - (ui.rightOpen ? LAYOUT_LIMITS.rightWidth[0] : 0),
        ),
      )
    : 0;
  const rightWidth = Math.min(
    ui.rightWidth,
    Math.max(LAYOUT_LIMITS.rightWidth[0], windowWidth - MIN_CENTER - sidebarWidth),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {ui.sidebarOpen && (
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

        {ui.rightOpen && (
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
      <ProjectDialogs />
    </div>
  );
}

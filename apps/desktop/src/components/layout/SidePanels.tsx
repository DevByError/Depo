import {
  Activity,
  Bug,
  FlaskConical,
  Gauge,
  PanelRightClose,
  ScrollText,
  SquareTerminal,
  Users,
  X,
} from "lucide-react";
import { ActivityFeed } from "@/components/panels/ActivityFeed";
import { AgentBoard } from "@/components/panels/AgentBoard";
import { EngineHealth } from "@/components/panels/EngineHealth";
import { LogsPanel } from "@/components/panels/LogsPanel";
import { PhaseNotice } from "@/components/panels/PhaseNotice";
import { ProblemsPanel } from "@/components/panels/ProblemsPanel";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import { useEngine } from "@/store/engine";
import { type BottomTab, type RightTab, useUi } from "@/store/ui";

function PanelTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors",
        selected ? "bg-hover text-fg" : "text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function RightPanel() {
  const tab = useUi((s) => s.rightTab);
  const setTab = useUi((s) => s.setRightTab);
  const toggle = useUi((s) => s.toggle);
  const tabs: { id: RightTab; label: string; icon: typeof Activity }[] = [
    { id: "activity", label: "Activity", icon: Activity },
    { id: "agents", label: "Agents", icon: Users },
  ];
  return (
    <aside aria-label="Live activity" className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-2">
        <div role="tablist" aria-label="Right panel" className="flex gap-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <PanelTab key={id} selected={tab === id} onClick={() => setTab(id)}>
              <Icon className="size-3.5" aria-hidden />
              {label}
            </PanelTab>
          ))}
        </div>
        <IconButton icon={PanelRightClose} label="Hide panel (Ctrl+L)" onClick={() => toggle("rightOpen")} />
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "activity" ? <ActivityFeed /> : <AgentBoard />}
      </div>
    </aside>
  );
}

export function BottomPanel() {
  const tab = useUi((s) => s.bottomTab);
  const setTab = useUi((s) => s.setBottomTab);
  const toggle = useUi((s) => s.toggle);
  const problemCount = useEngine(
    (s) => s.events.filter((e) => e.type === "error" || e.type === "warning").length,
  );
  const tabs: { id: BottomTab; label: string; icon: typeof Activity }[] = [
    { id: "engine", label: "Engine", icon: Gauge },
    { id: "terminal", label: "Terminal", icon: SquareTerminal },
    { id: "problems", label: problemCount > 0 ? `Problems (${problemCount})` : "Problems", icon: Bug },
    { id: "tests", label: "Test results", icon: FlaskConical },
    { id: "logs", label: "Logs", icon: ScrollText },
  ];
  return (
    <section aria-label="Bottom panel" className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <div
          role="tablist"
          aria-label="Bottom panel"
          className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto"
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <PanelTab key={id} selected={tab === id} onClick={() => setTab(id)}>
              <Icon className="size-3.5" aria-hidden />
              {label}
            </PanelTab>
          ))}
        </div>
        <IconButton icon={X} label="Hide panel (Ctrl+J)" onClick={() => toggle("bottomOpen")} />
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "engine" && <EngineHealth />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "logs" && <LogsPanel />}
        {tab === "terminal" && (
          <PhaseNotice icon={SquareTerminal} title="Terminal" phase="Phase 1">
            A live terminal (xterm.js) for commands agents run in the shadow workspace, with the per-project
            command policy.
          </PhaseNotice>
        )}
        {tab === "tests" && (
          <PhaseNotice icon={FlaskConical} title="Test results" phase="Phase 1">
            Results from each build, test and fix loop, with trimmed logs for failures.
          </PhaseNotice>
        )}
      </div>
    </section>
  );
}

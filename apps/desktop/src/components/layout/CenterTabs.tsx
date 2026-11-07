import {
  Blocks,
  BookMarked,
  BookOpen,
  Boxes,
  FileDiff,
  FlaskConical,
  FolderKanban,
  FolderTree,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Network,
  Palette,
  Presentation,
  Puzzle,
  ShieldCheck,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { AgentLabPanel } from "@/components/panels/AgentLabPanel";
import { BlocksPanel } from "@/components/panels/BlocksPanel";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { DesignPanel } from "@/components/panels/DesignPanel";
import { DiagramsPanel } from "@/components/panels/DiagramsPanel";
import { DiffReviewPanel } from "@/components/panels/DiffReviewPanel";
import { FilesPanel } from "@/components/panels/FilesPanel";
import { KnowledgePanel } from "@/components/panels/KnowledgePanel";
import { MemoryPanel } from "@/components/panels/MemoryPanel";
import { ModelsPanel } from "@/components/panels/ModelsPanel";
import { OverviewPanel } from "@/components/panels/OverviewPanel";
import { PhaseNotice } from "@/components/panels/PhaseNotice";
import { PlanBoard } from "@/components/panels/PlanBoard";
import { SecurityPanel } from "@/components/panels/SecurityPanel";
import { SkillsPanel } from "@/components/panels/SkillsPanel";
import { SlidesPanel } from "@/components/panels/SlidesPanel";
import { cn } from "@/lib/cn";
import { type CenterTab, useUi } from "@/store/ui";

interface TabDef {
  id: CenterTab;
  label: string;
  icon: LucideIcon;
  phase?: string;
  blurb?: string;
}

export const CENTER_TABS: TabDef[] = [
  { id: "overview", label: "Project", icon: FolderKanban },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "diff", label: "Diff Review", icon: FileDiff },
  { id: "memory", label: "Memory", icon: BookMarked },
  { id: "design", label: "Design", icon: Palette },
  { id: "diagrams", label: "Diagrams", icon: Network },
  { id: "slides", label: "Slides", icon: Presentation },
  { id: "agent-lab", label: "Agent Lab", icon: FlaskConical },
  { id: "skills", label: "Skills", icon: Puzzle },
  {
    id: "models",
    label: "Models",
    icon: Boxes,
  },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "blocks", label: "Blocks", icon: Blocks },
  { id: "security", label: "Security", icon: ShieldCheck },
];

/**
 * The centre has two kinds of screens. Work screens (the task flow) sit in the tab strip above the centre,
 * with labels. Tool screens (knowledge, design, models, settings-like screens) sit in the tool rail at the
 * window's left edge, as icons with tooltips. Both are tabs that control the same panel.
 */
export const WORK_TAB_ORDER: CenterTab[] = ["overview", "chat", "plan", "files", "diff"];
export const TOOL_TAB_ORDER: CenterTab[] = [
  "memory",
  "knowledge",
  "skills",
  "design",
  "diagrams",
  "slides",
  "blocks",
  "agent-lab",
  "models",
  "security",
];

function ordered(order: CenterTab[]): TabDef[] {
  const byId = new Map(CENTER_TABS.map((t) => [t.id, t]));
  return order.map((id) => byId.get(id)).filter((t): t is TabDef => !!t);
}

/** Work tabs in strip order. Tabs added later that are in neither list join the strip at the end. */
export function workTabs(): TabDef[] {
  const known = new Set([...WORK_TAB_ORDER, ...TOOL_TAB_ORDER]);
  return [...ordered(WORK_TAB_ORDER), ...CENTER_TABS.filter((t) => !known.has(t.id))];
}

export function toolTabs(): TabDef[] {
  return ordered(TOOL_TAB_ORDER);
}

/** Arrow-key movement inside one tab list (roving focus). */
export function moveInTabs(tabs: TabDef[], active: CenterTab, key: string, vertical: boolean): TabDef | null {
  const back = vertical ? "ArrowUp" : "ArrowLeft";
  const forward = vertical ? "ArrowDown" : "ArrowRight";
  if (key !== back && key !== forward && key !== "Home" && key !== "End") return null;
  if (tabs.length === 0) return null;
  if (key === "Home") return tabs[0] ?? null;
  if (key === "End") return tabs[tabs.length - 1] ?? null;
  const i = tabs.findIndex((t) => t.id === active);
  // From outside this list, the first press enters at the start (or end).
  if (i < 0) return key === forward ? (tabs[0] ?? null) : (tabs[tabs.length - 1] ?? null);
  const next = key === forward ? i + 1 : i - 1;
  return tabs[(next + tabs.length) % tabs.length] ?? null;
}

export function CenterTabs() {
  const active = useUi((s) => s.centerTab);
  const setActive = useUi((s) => s.setCenterTab);
  const current = CENTER_TABS.find((t) => t.id === active) ?? CENTER_TABS[0];

  const strip = workTabs();
  const inStrip = strip.some((t) => t.id === active);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = moveInTabs(strip, active, e.key, false);
    if (!tab) return;
    e.preventDefault();
    setActive(tab.id);
    document.getElementById(`tab-${tab.id}`)?.focus();
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <div
        role="tablist"
        aria-label="Workspace"
        onKeyDown={onKey}
        className="no-scrollbar flex h-10 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-panel px-2"
      >
        {strip.map((t, i) => {
          const Icon = t.icon;
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected || (!inStrip && i === 0) ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 px-3 text-[12.5px] font-medium transition-colors",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                selected
                  ? "text-fg after:bg-accent"
                  : "text-muted after:bg-transparent hover:text-fg hover:after:bg-border-strong",
              )}
            >
              <Icon className={cn("size-3.5", selected ? "text-accent" : "")} aria-hidden />
              {t.label}
            </button>
          );
        })}
        {!inStrip && current && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5 pr-1 text-[12px] text-subtle"
            aria-hidden
          >
            <current.icon className="size-3.5" />
            {current.label}
          </span>
        )}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`panel-${current.id}`}
          aria-labelledby={`tab-${current.id}`}
          className="min-h-0 flex-1"
        >
          {current.id === "overview" ? (
            <OverviewPanel />
          ) : current.id === "memory" ? (
            <MemoryPanel />
          ) : current.id === "chat" ? (
            <ChatPanel />
          ) : current.id === "design" ? (
            <DesignPanel />
          ) : current.id === "diagrams" ? (
            <DiagramsPanel />
          ) : current.id === "slides" ? (
            <SlidesPanel />
          ) : current.id === "plan" ? (
            <PlanBoard />
          ) : current.id === "files" ? (
            <FilesPanel />
          ) : current.id === "diff" ? (
            <DiffReviewPanel />
          ) : current.id === "skills" ? (
            <SkillsPanel />
          ) : current.id === "knowledge" ? (
            <KnowledgePanel />
          ) : current.id === "agent-lab" ? (
            <AgentLabPanel />
          ) : current.id === "blocks" ? (
            <BlocksPanel />
          ) : current.id === "security" ? (
            <SecurityPanel />
          ) : current.id === "models" ? (
            <ModelsPanel />
          ) : (
            <PhaseNotice icon={current.icon} title={current.label} phase={current.phase ?? "a later phase"}>
              {current.blurb}
            </PhaseNotice>
          )}
        </div>
      )}
    </div>
  );
}

import {
  BookOpen,
  Boxes,
  FileDiff,
  FlaskConical,
  FolderTree,
  type LucideIcon,
  MessageSquare,
  Network,
  Presentation,
  Puzzle,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { DiffReviewPanel } from "@/components/panels/DiffReviewPanel";
import { FilesPanel } from "@/components/panels/FilesPanel";
import { ModelsPanel } from "@/components/panels/ModelsPanel";
import { PhaseNotice } from "@/components/panels/PhaseNotice";
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
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "diff", label: "Diff Review", icon: FileDiff },
  {
    id: "diagrams",
    label: "Diagrams",
    icon: Network,
    phase: "Phase 4",
    blurb: "Architecture, ERD, sequence and flow diagrams in Mermaid, with a visual editor.",
  },
  {
    id: "slides",
    label: "Slides",
    icon: Presentation,
    phase: "Phase 4",
    blurb: "Pitch and progress decks with real screenshots. Export to PPTX and PDF.",
  },
  {
    id: "agent-lab",
    label: "Agent Lab",
    icon: FlaskConical,
    phase: "Phase 7",
    blurb: "Edit, evaluate, compare, promote and roll back each agent version.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Puzzle,
    phase: "Phase 5",
    blurb: "Install SKILL.md skills from GitHub, vet them, and assign them to agents.",
  },
  {
    id: "models",
    label: "Models",
    icon: Boxes,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icon: BookOpen,
    phase: "Phase 5",
    blurb: "Offline docs and security packs that agents search and cite.",
  },
];

export function CenterTabs() {
  const active = useUi((s) => s.centerTab);
  const setActive = useUi((s) => s.setCenterTab);
  const current = CENTER_TABS.find((t) => t.id === active) ?? CENTER_TABS[0];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = CENTER_TABS.findIndex((t) => t.id === active);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = CENTER_TABS[(next + CENTER_TABS.length) % CENTER_TABS.length];
    if (tab) {
      setActive(tab.id);
      document.getElementById(`tab-${tab.id}`)?.focus();
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <div
        role="tablist"
        aria-label="Workspace"
        onKeyDown={onKey}
        className="no-scrollbar flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-panel px-2"
      >
        {CENTER_TABS.map((t) => {
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
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs transition-colors",
                selected ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`panel-${current.id}`}
          aria-labelledby={`tab-${current.id}`}
          className="min-h-0 flex-1"
        >
          {current.id === "chat" ? (
            <ChatPanel />
          ) : current.id === "files" ? (
            <FilesPanel />
          ) : current.id === "diff" ? (
            <DiffReviewPanel />
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

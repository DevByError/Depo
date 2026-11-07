import { create } from "zustand";

export type Theme = "dark" | "light";
export type CenterTab =
  | "overview"
  | "chat"
  | "plan"
  | "files"
  | "diff"
  | "memory"
  | "design"
  | "diagrams"
  | "slides"
  | "agent-lab"
  | "skills"
  | "models"
  | "knowledge"
  | "security"
  | "blocks"
  | "preview"
  | "team";
export type BottomTab = "terminal" | "problems" | "tests" | "engine" | "logs" | "history";
export type RightTab = "activity" | "agents";

interface Layout {
  sidebarWidth: number;
  rightWidth: number;
  bottomHeight: number;
  sidebarOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

export type ProjectDialog =
  | { kind: "new" /** A blueprint to preselect under "Start from". */; blueprint?: string }
  | { kind: "import" }
  | { kind: "rename"; projectId: string }
  | { kind: "remove"; projectId: string };

export type FeedScope = "project" | "all";

/** A moment of a team run to reopen in the Team tab's replay (from a shared reference). */
export interface TeamMoment {
  taskId: string;
  projectId: string | null;
  /** Time since the run started. */
  atMs: number;
}

interface UiState extends Layout {
  theme: Theme;
  centerTab: CenterTab;
  bottomTab: BottomTab;
  rightTab: RightTab;
  settingsOpen: boolean;
  paletteOpen: boolean;
  onboardingOpen: boolean;
  feedQuery: string;
  showHeartbeats: boolean;
  /** The project shown in the center tabs. Tasks of other projects keep running. */
  projectId: string | null;
  projectDialog: ProjectDialog | null;
  /** Activity feed: the open project only, or every project. */
  feedScope: FeedScope;
  /** Change set shown in Diff Review. */
  changeSetId: string | null;
  /** Task shown in Chat; null starts a new task. */
  taskId: string | null;
  /** Logs tab: only this task's lines; null shows every line. */
  logsTaskId: string | null;
  setLogsTaskId(id: string | null): void;
  /** Open the Logs tab, filtered to one task (or to none). */
  openLogs(taskId: string | null): void;
  /** Team tab: a shared moment waiting to be opened in the replay. */
  teamMoment: TeamMoment | null;
  /** Open the Team tab's replay at a moment (switches project and task when needed). */
  openTeamMoment(m: TeamMoment): void;
  clearTeamMoment(): void;
  setProjectId(id: string | null): void;
  setProjectDialog(d: ProjectDialog | null): void;
  setFeedScope(s: FeedScope): void;
  setTaskId(id: string | null): void;
  setChangeSetId(id: string | null): void;
  setTheme(t: Theme): void;
  setCenterTab(t: CenterTab): void;
  setBottomTab(t: BottomTab): void;
  setRightTab(t: RightTab): void;
  setSettingsOpen(v: boolean): void;
  setPaletteOpen(v: boolean): void;
  setOnboardingOpen(v: boolean): void;
  setFeedQuery(q: string): void;
  setShowHeartbeats(v: boolean): void;
  setLayout(patch: Partial<Layout>): void;
  toggle(panel: "sidebarOpen" | "rightOpen" | "bottomOpen"): void;
}

const LAYOUT_KEY = "depo.layout";
const THEME_KEY = "depo.theme";

export const LAYOUT_LIMITS = {
  sidebarWidth: [180, 420],
  rightWidth: [280, 640],
  bottomHeight: [120, 520],
} as const;

const DEFAULT_LAYOUT: Layout = {
  sidebarWidth: 240,
  rightWidth: 380,
  bottomHeight: 220,
  sidebarOpen: true,
  rightOpen: true,
  bottomOpen: false,
};

/** Browser storage can be unavailable (private mode, locked profile); never let that break the UI. */
function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return { ...DEFAULT_LAYOUT, ...parsed };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" ? "light" : "dark";
}

export function clamp(n: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const useUi = create<UiState>((set, get) => ({
  ...readLayout(),
  theme: readTheme(),
  centerTab: "chat",
  bottomTab: "engine",
  rightTab: "activity",
  settingsOpen: false,
  paletteOpen: false,
  onboardingOpen: false,
  feedQuery: "",
  showHeartbeats: false,
  projectId: null,
  projectDialog: null,
  feedScope: "project",
  changeSetId: null,
  taskId: null,
  logsTaskId: null,
  setLogsTaskId: (logsTaskId) => set({ logsTaskId }),
  openLogs: (logsTaskId) => set({ logsTaskId, bottomTab: "logs", bottomOpen: true }),
  teamMoment: null,
  openTeamMoment: (m) =>
    set((s) => ({
      teamMoment: m,
      taskId: m.taskId,
      centerTab: "team",
      ...(m.projectId && m.projectId !== s.projectId ? { projectId: m.projectId, changeSetId: null } : {}),
    })),
  clearTeamMoment: () => set({ teamMoment: null }),
  setProjectId: (projectId) => set({ projectId, changeSetId: null, taskId: null }),
  setProjectDialog: (projectDialog) => set({ projectDialog }),
  setFeedScope: (feedScope) => set({ feedScope }),
  setTaskId: (taskId) => set({ taskId }),
  setChangeSetId: (changeSetId) => set({ changeSetId }),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    save(THEME_KEY, theme);
    set({ theme });
  },
  setCenterTab: (centerTab) => set({ centerTab }),
  setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
  setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setFeedQuery: (feedQuery) => set({ feedQuery }),
  setShowHeartbeats: (showHeartbeats) => set({ showHeartbeats }),
  setLayout: (patch) => {
    set(patch);
    const s = get();
    save(
      LAYOUT_KEY,
      JSON.stringify({
        sidebarWidth: s.sidebarWidth,
        rightWidth: s.rightWidth,
        bottomHeight: s.bottomHeight,
        sidebarOpen: s.sidebarOpen,
        rightOpen: s.rightOpen,
        bottomOpen: s.bottomOpen,
      }),
    );
  },
  toggle: (panel) => get().setLayout({ [panel]: !get()[panel] }),
}));

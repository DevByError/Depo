import { Moon, Search, Settings, Sun } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { setTheme } from "@/lib/engine";
import { useUi } from "@/store/ui";
import { Logo } from "./Logo";
import { ProjectsSection } from "./ProjectsSection";
import { RunningSection } from "./RunningSection";

export function Sidebar() {
  const query = useUi((s) => s.feedQuery);
  const setQuery = useUi((s) => s.setFeedQuery);
  const setRightTab = useUi((s) => s.setRightTab);
  const theme = useUi((s) => s.theme);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);

  return (
    <nav aria-label="Projects and navigation" className="flex h-full flex-col bg-panel">
      <div className="flex h-11 items-center gap-2 px-3">
        <Logo className="size-5" />
        <span className="text-[14px] font-semibold tracking-tight text-fg">Depo</span>
      </div>

      <div className="px-3 pb-3">
        <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
          <Search className="size-3.5 text-subtle" aria-hidden />
          <span className="sr-only">Search activity</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setRightTab("activity");
            }}
            placeholder="Search activity"
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-subtle"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <ProjectsSection />

        <SectionTitle>Running</SectionTitle>
        <RunningSection />
      </div>

      <div className="flex items-center gap-1 border-t border-border p-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg"
        >
          <Settings className="size-4" aria-hidden />
          Settings
          <span className="ml-auto">
            <Kbd>Ctrl ,</Kbd>
          </span>
        </button>
        <button
          type="button"
          onClick={() => void setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          {theme === "dark" ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </nav>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-3 mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
      {children}
    </h2>
  );
}

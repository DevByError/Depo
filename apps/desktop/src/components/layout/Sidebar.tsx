import { Search } from "lucide-react";
import { useUi } from "@/store/ui";
import { Logo } from "./Logo";
import { ProjectsSection } from "./ProjectsSection";
import { RunningSection } from "./RunningSection";

export function Sidebar() {
  const query = useUi((s) => s.feedQuery);
  const setQuery = useUi((s) => s.setFeedQuery);
  const setRightTab = useUi((s) => s.setRightTab);

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

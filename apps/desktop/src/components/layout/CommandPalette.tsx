import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { type Command, filterCommands, TAB_COMMANDS } from "@/lib/commands";
import { setTheme } from "@/lib/engine";
import { useUi } from "@/store/ui";

/** Ctrl+K: type to find any screen or action, arrows to choose, Enter to run. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const ui = () => useUi.getState();
    return [
      ...TAB_COMMANDS.map(
        (t): Command => ({
          id: `go-${t.id}`,
          title: `Go to ${t.label}`,
          keywords: t.keywords,
          group: "Go to",
          run: () => ui().setCenterTab(t.id),
        }),
      ),
      {
        id: "new-task",
        title: "Start a new task",
        keywords: "chat prompt build",
        group: "Do",
        run: () => {
          ui().setTaskId(null);
          ui().setCenterTab("chat");
        },
      },
      {
        id: "toggle-theme",
        title: "Switch between dark and light theme",
        keywords: "appearance",
        group: "Do",
        run: () => void setTheme(ui().theme === "dark" ? "light" : "dark"),
      },
      {
        id: "toggle-sidebar",
        title: "Show or hide the sidebar",
        keywords: "ctrl+b",
        group: "Do",
        run: () => ui().toggle("sidebarOpen"),
      },
      {
        id: "toggle-activity",
        title: "Show or hide the activity panel",
        keywords: "ctrl+l feed events agents",
        group: "Do",
        run: () => ui().toggle("rightOpen"),
      },
      {
        id: "toggle-bottom",
        title: "Show or hide the bottom panel",
        keywords: "ctrl+j terminal problems tests",
        group: "Do",
        run: () => ui().toggle("bottomOpen"),
      },
      {
        id: "new-project",
        title: "Create a new project",
        keywords: "folder",
        group: "Do",
        run: () => ui().setProjectDialog({ kind: "new" }),
      },
      {
        id: "import-project",
        title: "Import an existing project",
        keywords: "open folder github",
        group: "Do",
        run: () => ui().setProjectDialog({ kind: "import" }),
      },
      {
        id: "settings",
        title: "Open settings",
        keywords: "preferences team reviews updates notifications ctrl+,",
        group: "Do",
        run: () => ui().setSettingsOpen(true),
      },
      {
        id: "tour",
        title: "Show the welcome tour",
        keywords: "help start onboarding",
        group: "Help",
        run: () => ui().setOnboardingOpen(true),
      },
    ];
  }, []);

  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const scrollTo = (i: number) => {
    const id = shown[i]?.id;
    if (id) document.getElementById(`cmd-${id}`)?.scrollIntoView?.({ block: "nearest" });
  };

  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-label="Command palette"
          className="fixed top-[18%] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Type to search screens and actions. Use the arrow keys and Enter.
          </Dialog.Description>
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
            aria-label="Type a command"
            placeholder="Type a command or a screen name"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = Math.min(active + 1, Math.max(shown.length - 1, 0));
                setActive(n);
                scrollTo(n);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.max(active - 1, 0);
                setActive(n);
                scrollTo(n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[active]);
              }
            }}
            className="h-12 w-full border-b border-border bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-subtle"
          />
          <div
            ref={listRef}
            id="palette-list"
            role="listbox"
            aria-label="Commands"
            className="max-h-[50vh] overflow-y-auto p-1.5"
          >
            {shown.map((c, i) => (
              <div
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") run(c);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px]",
                  i === active ? "bg-hover text-fg" : "text-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="text-[11px] text-subtle">{c.group}</span>
              </div>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches.</li>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

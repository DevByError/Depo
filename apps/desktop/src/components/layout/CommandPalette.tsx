import type { SearchResult, SearchScope } from "@depo/shared";
import * as Dialog from "@radix-ui/react-dialog";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookMarked,
  Braces,
  CircleHelp,
  FileText,
  Loader2,
  type LucideIcon,
  MessageSquare,
  ScrollText,
  Search,
  Signpost,
  Sparkles,
  TextSearch,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Highlight } from "@/components/ui/highlight";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { type Command, TAB_COMMANDS } from "@/lib/commands";
import { call, setTheme } from "@/lib/engine";
import {
  buildSections,
  flatItems,
  MIN_REMOTE,
  MORE_HINT,
  moveActive,
  type PaletteItem,
  type PaletteSection,
  PREFIXES,
  parseQuery,
  SCOPE_LABEL,
  scopesFor,
  sliceMarks,
} from "@/lib/search";
import { useEngine } from "@/store/engine";
import { openSearchTarget } from "@/store/nav";
import { useNotifications } from "@/store/notifications";
import { useUi } from "@/store/ui";

const SCOPE_ICON: Record<SearchScope, LucideIcon> = {
  files: FileText,
  symbols: Braces,
  content: TextSearch,
  tasks: MessageSquare,
  decisions: Signpost,
  memory: BookMarked,
  logs: ScrollText,
};
const GROUP_ICON: Record<Command["group"], LucideIcon> = { "Go to": ArrowRight, Do: Zap, Help: CircleHelp };
const MODE_LABEL = {
  commands: "Commands",
  symbols: "Symbols",
  tasks: "Tasks",
  files: "Files",
  ask: "Ask Depo",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Every screen and action, as palette commands. */
function useCommands(): Command[] {
  return useMemo<Command[]>(() => {
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
        id: "history",
        title: "Show commit history",
        keywords: "git log commits branch history",
        group: "Do",
        run: () => ui().setBottomTab("history"),
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
}

/** Start an Ask / explain task with the question and show it in Chat. */
async function askDepo(projectId: string, text: string): Promise<void> {
  const ui = useUi.getState();
  ui.setCenterTab("chat");
  try {
    const task = await call("tasks.send", { projectId, text, mode: "ask" });
    useUi.getState().setTaskId(task.id);
  } catch (err) {
    useNotifications.getState().push({
      title: "Depo could not start the question",
      text: err instanceof Error ? err.message : String(err),
      level: "problem",
      taskId: null,
    });
  }
}

/**
 * Ctrl+K: one box for everything. Commands and screens match as you type; files, symbols, text in
 * files, tasks, decisions, memory and logs come from the engine a moment later. Prefixes narrow it:
 * > commands, @ symbols, # tasks, / files, ? ask Depo.
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const projectId = useUi((s) => s.projectId);
  const connected = useEngine((s) => s.status === "open");
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const debounced = useDebounced(parsed.text, 160);
  const scopes = scopesFor(parsed.mode);
  const remote = open && connected && !!scopes && parsed.text.length >= MIN_REMOTE;
  const ready = remote && debounced === parsed.text;
  const search = useQuery({
    queryKey: ["search", projectId, scopes?.join(","), debounced],
    queryFn: () =>
      call("search.everything", {
        ...(projectId ? { projectId } : {}),
        query: debounced,
        ...(scopes ? { scopes } : {}),
        limit: parsed.mode === "all" ? 5 : 12,
      }),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 5000,
    retry: false,
  });
  const searching = remote && (!ready || search.isFetching);

  const sections = useMemo(
    () =>
      buildSections({
        mode: parsed.mode,
        text: parsed.text,
        commands,
        scopes,
        groups: remote && search.data ? search.data.groups : null,
        searching,
        remote,
        hasProject: !!projectId,
      }),
    [parsed.mode, parsed.text, commands, scopes, remote, search.data, searching, projectId],
  );
  const items = useMemo(() => flatItems(sections), [sections]);
  const found = items.findIndex((i) => i.id === activeId);
  const active = found >= 0 ? found : moveActive(items, -1, 1);
  const activeItem = items[active];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveId(null);
    // Warm the engine's file list so the first search is quick.
    if (projectId && connected)
      void call("search.everything", { projectId, query: "", scopes: ["files"] }).catch(() => {});
  }, [open, projectId, connected]);

  const select = (i: number) => {
    const it = items[i];
    if (!it) return;
    setActiveId(it.id);
    document.getElementById(it.id)?.scrollIntoView?.({ block: "nearest" });
  };

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    if (it.kind === "ask") {
      if (it.disabled || !projectId) return;
      setOpen(false);
      void askDepo(projectId, it.text);
      return;
    }
    setOpen(false);
    if (it.kind === "command") it.command.run();
    else openSearchTarget(it.result.target);
  };

  // Nothing found (the Ask row may still be offered below the message).
  const showEmpty =
    parsed.mode !== "ask" &&
    !searching &&
    items.every((i) => i.kind === "ask") &&
    (items.length === 0 || !!parsed.text);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-label="Command palette"
          className="fixed top-[14%] left-1/2 z-50 flex max-h-[76vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-pop"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search screens, actions, files, code, tasks, decisions, memory and logs. Use the arrow keys and
            Enter. Start with a greater-than sign for commands, at for symbols, hash for tasks, slash for
            files or a question mark to ask Depo.
          </Dialog.Description>
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-subtle" aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-autocomplete="list"
              aria-activedescendant={activeItem?.id}
              aria-label="Type a command"
              placeholder="Search files, code, tasks and commands"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  select(moveActive(items, active, 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  select(moveActive(items, active, -1));
                } else if (e.key === "PageDown") {
                  e.preventDefault();
                  select(moveActive(items, active, "last"));
                } else if (e.key === "PageUp") {
                  e.preventDefault();
                  select(moveActive(items, active, "first"));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if ((e.ctrlKey || e.metaKey) && parsed.text && projectId) {
                    setOpen(false);
                    void askDepo(projectId, parsed.text);
                  } else run(activeItem);
                }
              }}
              className="field-in-frame h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
            />
            {parsed.mode !== "all" && (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-fg">
                {MODE_LABEL[parsed.mode]}
              </span>
            )}
            {searching && (
              <Loader2 className="size-3.5 shrink-0 text-subtle motion-safe:animate-spin" aria-hidden />
            )}
          </div>
          {showEmpty && (
            <p
              role="status"
              className={cn("px-3 text-center text-[13px] text-muted", items.length ? "pt-4 pb-1" : "py-6")}
            >
              {search.isError && remote ? "Search is not available right now." : "Nothing matches."}
            </p>
          )}
          <div
            ref={listRef}
            id="palette-list"
            role="listbox"
            aria-label="Results"
            className={cn("min-h-0 flex-1 overflow-y-auto p-1.5", items.length === 0 && "hidden")}
          >
            {sections.map((s) =>
              s.items.length === 0 ? null : (
                // biome-ignore lint/a11y/useSemanticElements: options in a listbox are grouped with role="group"; a fieldset is for form controls.
                <div key={s.id} role="group" aria-labelledby={`${s.id}-label`} className="pb-1">
                  <div
                    id={`${s.id}-label`}
                    role="presentation"
                    className="flex items-center gap-2 px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle"
                  >
                    <span>{s.label}</span>
                    {s.note && <span className="font-normal">{s.note}</span>}
                    {s.more && !s.note && parsed.mode === "all" && s.scope && MORE_HINT[s.scope] && (
                      <span className="ml-auto font-normal">{MORE_HINT[s.scope]}</span>
                    )}
                  </div>
                  {s.items.map((it) => {
                    const i = items.indexOf(it);
                    return (
                      <Row
                        key={it.id}
                        item={it}
                        active={i === active}
                        onHover={() => setActiveId(it.id)}
                        onRun={() => run(it)}
                      />
                    );
                  })}
                </div>
              ),
            )}
          </div>
          <StatusLines sections={sections} />
          <footer className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-subtle">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> open
            </span>
            <span className="hidden items-center gap-1 sm:inline-flex">
              <Kbd>Ctrl+Enter</Kbd> ask Depo
            </span>
            <span className="ml-auto hidden items-center gap-2 md:inline-flex">
              {PREFIXES.map((p) => (
                <span key={p.prefix} className="inline-flex items-center gap-1">
                  <Kbd>{p.prefix}</Kbd>
                  {p.label}
                </span>
              ))}
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Scopes still searching (one line) and scopes that could not search (one line each). */
function StatusLines({ sections }: { sections: PaletteSection[] }) {
  const empty = sections.filter((s) => s.items.length === 0 && s.note);
  if (empty.length === 0) return null;
  const pending = empty.filter((s) => s.note === "Searching…");
  const problems = empty.filter((s) => s.note !== "Searching…");
  return (
    <div className="shrink-0 space-y-1 px-4 py-2 text-[12px] text-muted" role="status">
      {pending.length > 0 && (
        <p className="flex items-center gap-2">
          <Loader2 className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
          Searching {pending.map((s) => s.label.toLowerCase()).join(", ")}…
        </p>
      )}
      {problems.map((s) => (
        <p key={s.id}>
          <span className="font-medium text-fg">{s.label}:</span> {s.note}
        </p>
      ))}
    </div>
  );
}

function Row({
  item,
  active,
  onHover,
  onRun,
}: {
  item: PaletteItem;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const disabled = item.kind === "ask" && item.disabled;
  return (
    <div
      id={item.id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onRun}
      onKeyDown={(e) => {
        if (e.key === "Enter") onRun();
      }}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]",
        active ? "bg-hover text-fg" : "text-muted",
        disabled && "cursor-default",
      )}
    >
      <RowBody item={item} />
    </div>
  );
}

function RowBody({ item }: { item: PaletteItem }) {
  if (item.kind === "command") {
    const Icon = GROUP_ICON[item.command.group];
    return (
      <>
        <Icon className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg">
          <Highlight text={item.command.title} marks={item.marks} />
        </span>
        <span className="shrink-0 text-[11px] text-subtle">{item.command.group}</span>
      </>
    );
  }
  if (item.kind === "ask") {
    return (
      <>
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg">
          {item.text ? `Ask Depo: “${item.text}”` : "Ask Depo about this project"}
        </span>
        <span className="shrink-0 text-[11px] text-subtle">
          {item.disabled
            ? item.text
              ? "Open a project first"
              : "Type your question"
            : "Answers in Chat, changes nothing"}
        </span>
      </>
    );
  }
  return <ResultBody r={item.result} />;
}

function ResultBody({ r }: { r: SearchResult }) {
  const Icon = SCOPE_ICON[r.scope];
  const isPath = r.scope === "files" || r.scope === "content";
  const cut = isPath ? r.title.lastIndexOf("/") + 1 : 0;
  return (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          {isPath ? (
            <span className="min-w-0 truncate">
              <span className="text-fg">
                <Highlight text={r.title.slice(cut)} marks={sliceMarks(r.titleMarks, cut, r.title.length)} />
              </span>
              {cut > 0 && (
                <span className="ml-1.5 text-[12px] text-subtle">
                  <Highlight text={r.title.slice(0, cut - 1)} marks={sliceMarks(r.titleMarks, 0, cut - 1)} />
                </span>
              )}
            </span>
          ) : (
            <span className={cn("min-w-0 truncate text-fg", r.scope === "logs" && "font-mono text-[12px]")}>
              <Highlight text={r.title} marks={r.titleMarks} />
            </span>
          )}
          {r.scope !== "files" && (
            <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11px] text-subtle">{r.detail}</span>
          )}
        </span>
        {r.snippet && (
          <span
            className={cn(
              "mt-0.5 block truncate text-[12px] text-muted",
              (r.scope === "content" || r.scope === "symbols") && "font-mono text-[11.5px]",
            )}
          >
            <Highlight text={r.snippet.text} marks={r.snippet.marks} />
          </span>
        )}
      </span>
      <span className="sr-only">, {SCOPE_LABEL[r.scope]}</span>
    </>
  );
}

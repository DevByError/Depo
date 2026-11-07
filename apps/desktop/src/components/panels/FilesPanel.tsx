import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeLines, type LineRange, SelectionBar } from "@/components/code/CodeView";
import { cn } from "@/lib/cn";
import { askText, changeText, type LineSelection, pathLine } from "@/lib/code-actions";
import { call } from "@/lib/engine";
import { languageForPath, languageLabel } from "@/lib/highlight/languages";
import { useHighlight } from "@/lib/highlight/use-highlight";
import { copyText } from "@/lib/open-url";
import { prefill } from "@/store/composer";
import { useEngine } from "@/store/engine";
import { useNav } from "@/store/nav";
import { useUi } from "@/store/ui";

/** "web/src/lib/cn.ts" -> ["web", "web/src", "web/src/lib"]: the folders to open to show a file. */
export function parentDirs(path: string): string[] {
  const parts = path.split("/").filter((p) => p && p !== ".");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function cleanPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(s)
    : s.replace(/["\\]/g, "\\$&");
}

/** Read-only project browser. Agents work on a copy; this always shows the real files. */
export function FilesPanel() {
  const projectId = useUi((s) => s.projectId);
  const request = useNav((s) => s.file);
  const [selected, setSelected] = useState<string | null>(request ? cleanPath(request.path) : null);
  const [goto, setGoto] = useState<{ line: number; seq: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    request ? new Set(parentDirs(cleanPath(request.path))) : new Set(),
  );
  const treeRef = useRef<HTMLElement>(null);
  // Set when a file was opened from elsewhere: the tree scrolls to it once its folders have loaded.
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);

  // A jump from search, the code map, a problem...: open that file (at that line, if given),
  // open the folders above it and scroll the tree to it.
  useEffect(() => {
    if (!request) return;
    const path = cleanPath(request.path);
    setSelected(path);
    setGoto(request.line ? { line: request.line, seq: request.seq } : null);
    setExpanded((cur) => {
      const want = parentDirs(path).filter((d) => !cur.has(d));
      return want.length ? new Set([...cur, ...want]) : cur;
    });
    setReveal({ path, seq: request.seq });
    useNav.getState().clearFile();
  }, [request]);

  useEffect(() => {
    if (!reveal) return;
    const started = Date.now();
    let timer = 0;
    const tick = () => {
      const el = treeRef.current?.querySelector<HTMLElement>(`[data-tree-path="${cssEscape(reveal.path)}"]`);
      if (el) {
        el.scrollIntoView?.({ block: "nearest" });
        return;
      }
      // Folders load one level at a time; give up quietly if the file is not there.
      if (Date.now() - started < 4000) timer = window.setTimeout(tick, 60);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [reveal]);

  const toggle = useCallback((dir: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-sm">
          <FolderTree className="mx-auto mb-3 size-6 text-muted" aria-hidden />
          <h2 className="text-[14px] font-semibold text-fg">No project open</h2>
          <p className="mt-1 text-[13px] text-muted">
            Open a project folder from the sidebar to browse its files.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <nav
        ref={treeRef}
        className="w-64 shrink-0 overflow-y-auto border-r border-border py-1"
        aria-label="Project files"
      >
        <Dir
          projectId={projectId}
          path="."
          depth={0}
          selected={selected}
          expanded={expanded}
          onToggle={toggle}
          onSelect={(p) => {
            setSelected(p);
            setGoto(null);
          }}
        />
      </nav>
      <section
        className="relative min-w-0 flex-1 overflow-auto focus-visible:-outline-offset-2"
        tabIndex={0}
        aria-label={selected ? `File ${selected}` : "File preview"}
      >
        {selected ? (
          <Viewer key={selected} projectId={projectId} path={selected} goto={goto} />
        ) : (
          <p className="p-4 text-xs text-muted">Choose a file to preview it.</p>
        )}
      </section>
    </div>
  );
}

function Dir({
  projectId,
  path,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  projectId: string;
  path: string;
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  onSelect: (p: string) => void;
}) {
  const enabled = useEngine((s) => s.status === "open");
  const q = useQuery({
    queryKey: ["files", projectId, path],
    queryFn: () => call("files.list", { projectId, path }),
    enabled,
  });
  if (q.isError) return <p className="px-2 text-[11px] text-danger">{String(q.error)}</p>;
  return (
    <ul>
      {(q.data?.entries ?? []).map((e) => {
        const isOpen = expanded.has(e.path);
        const pad = { paddingLeft: `${8 + depth * 12}px` };
        if (e.type === "dir") {
          return (
            <li key={e.path}>
              <button
                type="button"
                aria-expanded={isOpen}
                data-tree-path={e.path}
                onClick={() => onToggle(e.path)}
                style={pad}
                className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-muted hover:bg-hover hover:text-fg"
              >
                {isOpen ? (
                  <ChevronDown className="size-3" aria-hidden />
                ) : (
                  <ChevronRight className="size-3" aria-hidden />
                )}
                <Folder className="size-3.5 text-subtle" aria-hidden />
                <span className="truncate">{e.name}</span>
              </button>
              {isOpen && (
                <Dir
                  projectId={projectId}
                  path={e.path}
                  depth={depth + 1}
                  selected={selected}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              )}
            </li>
          );
        }
        return (
          <li key={e.path}>
            <button
              type="button"
              data-tree-path={e.path}
              onClick={() => onSelect(e.path)}
              aria-current={selected === e.path ? "true" : undefined}
              style={{ paddingLeft: `${20 + depth * 12}px` }}
              className={cn(
                "flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs",
                selected === e.path ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <File className="size-3.5 shrink-0 text-subtle" aria-hidden />
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Viewer({
  projectId,
  path,
  goto,
}: {
  projectId: string;
  path: string;
  goto: { line: number; seq: number } | null;
}) {
  const q = useQuery({
    queryKey: ["files", projectId, "read", path],
    queryFn: () => call("files.read", { projectId, path }),
  });
  const f = q.data;
  const text = f && !f.binary && f.text !== null ? f.text.replace(/\r\n?/g, "\n") : null;
  const lang = languageForPath(path);
  const hl = useHighlight(text, lang);
  const lines = useMemo(() => {
    const all = text === null ? [] : text.split("\n");
    if (all.at(-1) === "") all.pop();
    return all;
  }, [text]);

  if (q.isLoading) return <p className="p-4 text-xs text-muted">Loading…</p>;
  if (q.isError) return <p className="p-4 text-xs text-danger">{String(q.error)}</p>;
  if (!f) return null;
  if (f.binary || text === null)
    return <p className="p-4 text-xs text-muted">Binary file ({f.size} bytes).</p>;
  return (
    <FileLines
      projectId={projectId}
      path={f.path}
      lines={lines}
      tokens={hl.lines}
      langLabel={lang ? languageLabel(lang) : null}
      large={hl.state === "large"}
      truncated={f.truncated}
      goto={goto}
      onSelection={(range) => ({
        path: f.path,
        start: range.a,
        end: range.b,
        lines: lines.slice(range.a - 1, range.b),
        lang,
      })}
    />
  );
}

function FileLines({
  projectId,
  path,
  lines,
  tokens,
  langLabel,
  large,
  truncated,
  goto,
  onSelection,
}: {
  projectId: string;
  path: string;
  lines: string[];
  tokens: Parameters<typeof CodeLines>[0]["tokens"];
  langLabel: string | null;
  large: boolean;
  truncated: boolean;
  goto: { line: number; seq: number } | null;
  onSelection: (range: LineRange) => LineSelection;
}) {
  const qc = useQueryClient();
  const connected = useEngine((s) => s.status === "open");
  const [range, setRange] = useState<LineRange | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (copied === "idle") return;
    const t = window.setTimeout(() => setCopied("idle"), 2500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const clear = () => {
    setRange(null);
    // The bar goes away: keyboard focus goes back to the line it was on.
    requestAnimationFrame(() =>
      boxRef.current?.querySelector<HTMLButtonElement>('[data-gutter][tabindex="0"]')?.focus(),
    );
  };

  const ask = useMutation({
    mutationFn: (sel: LineSelection) => call("tasks.send", { projectId, text: askText(sel), mode: "ask" }),
    onSuccess: (task) => {
      const ui = useUi.getState();
      ui.setTaskId(task.id);
      ui.setCenterTab("chat");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const change = (sel: LineSelection) => {
    const { text, cursor } = changeText(sel);
    const ui = useUi.getState();
    ui.setTaskId(null);
    prefill(text, { cursor });
    ui.setCenterTab("chat");
  };

  return (
    <div ref={boxRef} className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex min-h-8 flex-wrap items-center gap-x-2 border-b border-border bg-bg/95 px-3 py-1 backdrop-blur">
        <span className="min-w-0 truncate font-mono text-xs text-fg">{path}</span>
        {langLabel && <span className="text-[11px] text-subtle">{langLabel}</span>}
        <span className="text-[11px] text-subtle tabular-nums">
          {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
        </span>
        {large && <span className="text-[11px] text-muted">Large file: shown without colours</span>}
      </header>
      <CodeLines
        lines={lines}
        tokens={tokens}
        goto={goto}
        range={range}
        onRange={(r) => {
          setRange(r);
          ask.reset();
          setCopied("idle");
        }}
      />
      {truncated && <p className="px-3 py-2 text-xs text-muted">Showing the first 512 KB.</p>}
      {range && (
        <SelectionBar
          range={range}
          busy={ask.isPending}
          error={ask.isError ? (ask.error as Error).message : null}
          canAsk={connected}
          copied={copied}
          onAsk={() => ask.mutate(onSelection(range))}
          onChange={() => change(onSelection(range))}
          onCopy={async () =>
            setCopied((await copyText(pathLine(path, range.a, range.b))) ? "copied" : "failed")
          }
          onClear={clear}
        />
      )}
    </div>
  );
}

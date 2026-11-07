import type { CodeMap, CodeMapNode } from "@depo/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, List, Loader2, Network, RefreshCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ErrorText } from "@/components/ui/modal";
import { AGENT_BG } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { AREA_LABEL, AREA_TONE, compactNumber, homeModules, moduleLabel, plural } from "@/lib/code-map";
import { call } from "@/lib/engine";
import { useEngine } from "@/store/engine";
import { FileDetails, HotSpots, ModuleFiles, PathText } from "./CodeMapDetails";
import { ModuleGraph, moduleSummary } from "./ModuleGraph";

type Shape = "graph" | "list";
const SHAPE_KEY = "depo.codemap.view";
/** Modules shown on the project home; the full view shows all of them (at most 40). */
export const COMPACT_MODULES = 18;

function readShape(): Shape {
  try {
    return localStorage.getItem(SHAPE_KEY) === "list" ? "list" : "graph";
  } catch {
    return "graph";
  }
}

function saveShape(s: Shape) {
  try {
    localStorage.setItem(SHAPE_KEY, s);
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
}

/**
 * The code map: modules as a graph (or a table), a module's files, a file's imports and
 * importers, hot spots, entry points and import cycles. `compact` is the project home version.
 */
export function CodeMapView({
  projectId,
  compact,
  disabled = false,
  action,
}: {
  projectId: string;
  compact: boolean;
  /** The code index is turned off for this project. */
  disabled?: boolean;
  action?: ReactNode;
}) {
  const enabled = useEngine((s) => s.status === "open") && !disabled;
  const map = useQuery({
    queryKey: ["codemap", projectId, "module"],
    queryFn: () => call("codemap.get", { projectId, level: "module" }),
    enabled,
    refetchInterval: (q) => (q.state.data?.indexing ? 2500 : false),
  });
  const [shape, setShape] = useState<Shape>(readShape);
  const [module, setModule] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project starts with nothing picked.
  useEffect(() => {
    setModule(null);
    setFile(null);
  }, [projectId]);

  const m = map.data;
  const all = useMemo(() => (m ? m.nodes.filter((n) => !n.outside) : []), [m]);
  const shown = useMemo(() => (compact ? homeModules(all, COMPACT_MODULES) : all), [all, compact]);
  const shownIds = useMemo(() => new Set(shown.map((n) => n.id)), [shown]);
  const edges = useMemo(
    () => (m ? m.edges.filter((e) => shownIds.has(e.from) && shownIds.has(e.to)) : []),
    [m, shownIds],
  );

  const pickShape = (s: Shape) => {
    setShape(s);
    saveShape(s);
  };
  const pickModule = (id: string | null) => {
    setModule(id);
    setFile(null);
  };

  let body: ReactNode;
  if (disabled) {
    body = (
      <Note>
        The code index is turned off for this project. Turn it on in the project settings to see the map.
      </Note>
    );
  } else if (map.isError) {
    body = <ErrorText error={map.error} />;
  } else if (!m) {
    body = (
      <Note>
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Reading the code…
      </Note>
    );
  } else if (all.length === 0) {
    body = (
      <Note>
        {m.indexing
          ? "The code index is still being built. The map appears when it is ready."
          : "No source files yet. The map fills in as code is added."}
      </Note>
    );
  } else {
    body = (
      <>
        {shape === "graph" ? (
          <ModuleGraph
            nodes={shown}
            edges={edges}
            selected={module}
            onSelect={pickModule}
            compact={compact}
          />
        ) : (
          <ModuleTable nodes={shown} selected={module} onSelect={pickModule} />
        )}
        {compact && all.length > shown.length && (
          <p className="text-[11px] text-subtle">
            Showing the {shown.length} busiest of {all.length} modules. The full map has them all, tests
            included.
          </p>
        )}
        <div
          className={cn(
            "grid grid-cols-1 gap-4",
            (module || file) && "@3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
          )}
        >
          {file ? (
            <FileDetails
              projectId={projectId}
              path={file}
              onFile={setFile}
              onBack={() => setFile(null)}
              backLabel={module !== null ? "Files" : "Back"}
            />
          ) : module !== null ? (
            <ModuleFiles
              projectId={projectId}
              module={module}
              onFile={setFile}
              onClose={() => pickModule(null)}
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-4">
            <HotSpots hotSpots={m.hotSpots} max={compact ? 3 : 8} onFile={setFile} />
            {!compact && <EntriesAndCycles map={m} onFile={setFile} />}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted">{m && all.length > 0 ? summaryLine(m) : ""}</p>
        {m && all.length > 0 && (
          <div
            role="radiogroup"
            aria-label="Code map view"
            className="flex rounded-md border border-border p-0.5"
          >
            <ShapeButton active={shape === "graph"} onClick={() => pickShape("graph")}>
              <Network className="size-3.5" aria-hidden /> Graph
            </ShapeButton>
            <ShapeButton active={shape === "list"} onClick={() => pickShape("list")}>
              <List className="size-3.5" aria-hidden /> List
            </ShapeButton>
          </div>
        )}
        {action}
      </div>
      {body}
    </div>
  );
}

function summaryLine(m: CodeMap): string {
  const s = m.summary;
  return [
    plural(s.files, "file"),
    `${compactNumber(s.lines)} lines`,
    plural(s.modules, "module"),
    plural(m.entryPoints.length, "entry point"),
    m.cycles.length ? plural(m.cycles.length, "import cycle") : "no import cycles",
    m.indexing ? "updating…" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ShapeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: segmented control; role and aria-checked are set.
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium",
        active ? "bg-accent-soft text-fg" : "text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** The list alternative to the graph: every module as a table row. */
function ModuleTable({
  nodes,
  selected,
  onSelect,
}: {
  nodes: CodeMapNode[];
  selected: string | null;
  onSelect(id: string | null): void;
}) {
  const rows = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return (
    <section
      tabIndex={0}
      aria-label="Modules table"
      className="overflow-x-auto rounded-lg border border-border"
    >
      <table aria-label="Modules" className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[11px] text-muted">
            <th scope="col" className="px-3 py-1.5 font-medium">
              Module
            </th>
            <th scope="col" className="px-2 py-1.5 font-medium">
              Area
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Files
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Lines
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              Imported by
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              Imports
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const isSel = selected === n.id;
            return (
              <tr
                key={n.id}
                className={cn("border-b border-border last:border-b-0", isSel && "bg-accent-soft")}
              >
                <th scope="row" className="px-1 py-0.5 text-left font-normal">
                  <button
                    type="button"
                    aria-pressed={isSel}
                    aria-label={moduleSummary(n)}
                    title={moduleLabel(n.id)}
                    onClick={() => onSelect(isSel ? null : n.id)}
                    className="flex min-h-6 w-full max-w-md items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-hover"
                  >
                    <span className="min-w-0 truncate font-mono text-[11px] text-fg">
                      {moduleLabel(n.id)}
                    </span>
                    {n.inCycle && <RefreshCcw className="size-3 shrink-0 text-danger" aria-hidden />}
                    {n.entry && <CircleDot className="size-3 shrink-0 text-muted" aria-hidden />}
                  </button>
                </th>
                <td className="whitespace-nowrap px-2 py-0.5 text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className={cn("size-2 rounded-sm", AGENT_BG[AREA_TONE[n.area]])} aria-hidden />
                    {AREA_LABEL[n.area]}
                  </span>
                </td>
                <td className="px-2 py-0.5 text-right text-fg tabular-nums">{n.files}</td>
                <td className="px-2 py-0.5 text-right text-muted tabular-nums">{compactNumber(n.lines)}</td>
                <td className="px-2 py-0.5 text-right text-muted tabular-nums">{n.importedBy}</td>
                <td className="px-3 py-0.5 text-right text-muted tabular-nums">{n.importsOut}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Where the code starts, and the import cycles worth untangling. */
function EntriesAndCycles({ map, onFile }: { map: CodeMap; onFile(path: string): void }) {
  return (
    <>
      {map.entryPoints.length > 0 && (
        <section aria-label="Entry points" className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold text-fg">Entry points</h3>
          <ul className="flex flex-col">
            {map.entryPoints.slice(0, 10).map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => onFile(e.path)}
                  title={e.path}
                  className="flex min-h-6 w-full items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-hover"
                >
                  <PathText path={e.path} />
                  <span className="shrink-0 text-[11px] text-subtle">{e.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Import cycles" className="min-w-0">
        <h3 className="mb-1 text-xs font-semibold text-fg">Import cycles</h3>
        {map.cycles.length === 0 ? (
          <p className="px-2 text-[11px] text-subtle">None. No files import each other in a loop.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {map.cycles.slice(0, 6).map((c) => (
              <li key={c.join(">")} className="flex flex-wrap items-center gap-x-1 px-2 text-[11px]">
                <RefreshCcw className="size-3 shrink-0 text-danger" aria-hidden />
                {c.slice(0, 6).map((p, i) => (
                  <span key={p} className="flex items-center gap-1">
                    {i > 0 && <span className="text-subtle">→</span>}
                    <button
                      type="button"
                      onClick={() => onFile(p)}
                      title={p}
                      className="min-h-6 rounded px-1 font-mono text-fg hover:bg-hover"
                    >
                      {p.split("/").pop()}
                    </button>
                  </span>
                ))}
                {c.length > 6 && <span className="text-subtle">and {c.length - 6} more</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {map.summary.libraries.length > 0 && (
        <section aria-label="Outside libraries" className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold text-fg">Outside libraries</h3>
          <ul className="flex flex-wrap gap-1.5 px-2">
            {map.summary.libraries.map((l) => (
              <li
                key={l.name}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
              >
                {l.name} <span className="text-subtle tabular-nums">{l.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-xs text-muted">{children}</p>;
}

import type { CodeArea, CodeMapEdge, CodeMapNode } from "@depo/shared";
import { CircleDot, RefreshCcw } from "lucide-react";
import { useMemo } from "react";
import { AGENT_BG, AGENT_TEXT } from "@/lib/agent-color";
import { cn } from "@/lib/cn";
import { AREA_LABEL, AREA_TONE, layoutModules, moduleLabel, plural, tailLabel } from "@/lib/code-map";

/** What a module's button says to a screen reader; it starts with the visible text. */
export function moduleSummary(n: CodeMapNode): string {
  const parts = [
    `${moduleLabel(n.id)}, ${plural(n.files, "file")}`,
    AREA_LABEL[n.area].toLowerCase(),
    n.importedBy ? `imported by ${plural(n.importedBy, "module")}` : "not imported by other modules",
    n.importsOut ? `imports ${plural(n.importsOut, "module")}` : null,
    n.inCycle ? "in an import cycle" : null,
    n.entry ? "holds an entry point" : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * Modules and their imports as a left-to-right graph: a module sits left of what it imports.
 * Boxes grow with the file count and take their area's colour; import cycles are red and dashed.
 * The boxes are real buttons in a list, so the graph works with the keyboard and screen readers.
 */
export function ModuleGraph({
  nodes,
  edges,
  selected,
  onSelect,
  maxHeight,
}: {
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  selected: string | null;
  onSelect(id: string | null): void;
  maxHeight?: number;
}) {
  const layout = useMemo(() => layoutModules(nodes, edges), [nodes, edges]);
  const box = useMemo(() => new Map(layout.boxes.map((b) => [b.id, b])), [layout]);
  const areas = useMemo(() => [...new Set(nodes.map((n) => n.area))].sort() as CodeArea[], [nodes]);
  const hasCycle = layout.edges.some((e) => e.cycle);
  const linked = (e: { from: string; to: string }) =>
    selected !== null && (e.from === selected || e.to === selected);
  // Draw the highlighted edges last so they sit on top.
  const ordered = [...layout.edges].sort(
    (a, b) => Number(linked(a)) - Number(linked(b)) || Number(a.cycle) - Number(b.cycle),
  );

  return (
    <div className="flex flex-col gap-2">
      <section
        tabIndex={0}
        aria-label="Module graph. Scroll to see every module."
        className="overflow-auto rounded-lg border border-border bg-bg"
        style={{
          maxHeight,
          backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
          >
            {ordered.map((e) => {
              const on = linked(e);
              const dim = selected !== null && !on;
              return (
                <g
                  key={`${e.from}>${e.to}`}
                  className={cn(
                    e.cycle
                      ? "fill-danger stroke-danger"
                      : on
                        ? "fill-accent stroke-accent"
                        : "fill-border-strong stroke-border-strong",
                    dim && "opacity-30",
                  )}
                >
                  <path
                    d={e.path}
                    fill="none"
                    strokeWidth={Math.min(3, 1 + Math.log2(e.weight) * 0.5) + (on ? 0.5 : 0)}
                    strokeDasharray={e.cycle ? "5 4" : undefined}
                    strokeLinecap="round"
                  />
                  <path
                    d={`M${e.x2 - 6} ${e.y2 - 3.5} L${e.x2} ${e.y2} L${e.x2 - 6} ${e.y2 + 3.5} Z`}
                    stroke="none"
                  />
                </g>
              );
            })}
          </svg>
          <ol aria-label="Modules in the graph">
            {nodes.map((n) => {
              const b = box.get(n.id);
              if (!b) return null;
              const tone = AREA_TONE[n.area];
              const isSel = selected === n.id;
              return (
                <li key={n.id} className="absolute" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
                  <button
                    type="button"
                    aria-pressed={isSel}
                    aria-label={moduleSummary(n)}
                    title={moduleLabel(n.id)}
                    onClick={() => onSelect(isSel ? null : n.id)}
                    className={cn(
                      "flex size-full items-stretch overflow-hidden rounded-lg border bg-panel text-left transition-[border-color,box-shadow] duration-150 hover:border-border-strong",
                      isSel
                        ? "border-accent ring-2 ring-accent/30"
                        : selected !== null && isNeighbour(n.id, selected, edges)
                          ? "border-accent/50"
                          : "border-border",
                    )}
                  >
                    <span className={cn("w-1 shrink-0", AGENT_BG[tone])} aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
                      <span className="truncate text-xs font-medium text-fg">{tailLabel(n.id)}</span>
                      <span className="flex items-center gap-1 truncate text-[11px] text-subtle">
                        {plural(n.files, "file")}
                        {n.inCycle && <RefreshCcw className="size-3 shrink-0 text-danger" aria-hidden />}
                        {n.entry && (
                          <CircleDot className={cn("size-3 shrink-0", AGENT_TEXT[tone])} aria-hidden />
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
      <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {areas.map((a) => (
          <li key={a} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-sm", AGENT_BG[AREA_TONE[a]])} aria-hidden />
            {AREA_LABEL[a]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <CircleDot className="size-3" aria-hidden />
          Entry point
        </li>
        {hasCycle && (
          <li className="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden className="stroke-danger">
              <path d="M1 3 H17" strokeWidth="1.5" strokeDasharray="4 3" />
            </svg>
            Import cycle
          </li>
        )}
        <li className="text-subtle">Arrows point to what a module imports.</li>
      </ul>
    </div>
  );
}

function isNeighbour(id: string, selected: string, edges: CodeMapEdge[]): boolean {
  return edges.some((e) => (e.from === selected && e.to === id) || (e.to === selected && e.from === id));
}

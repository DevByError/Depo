import type { CodeArea, CodeMapEdge, CodeMapNode, DepoEvent } from "@depo/shared";
import type { AgentTone } from "./agent-color";
import { layoutDag } from "./dag-layout";

/**
 * Pure helpers for the code map view and the project home: area colours, labels, the module graph
 * layout (importers on the left, what they import on the right) and the test run sparkline.
 */

/** Areas reuse the theme's family colours (lib/agent-color.ts). Red stays for import cycles. */
export const AREA_TONE: Record<CodeArea, AgentTone> = {
  ui: "design",
  server: "build",
  data: "data",
  tests: "quality",
  tooling: "ops",
  docs: "docs",
  core: "lead",
  other: "docs",
};

export const AREA_LABEL: Record<CodeArea, string> = {
  ui: "Interface",
  server: "Server",
  data: "Data",
  tests: "Tests",
  tooling: "Tooling",
  docs: "Docs",
  core: "Core",
  other: "Other",
};

export function moduleLabel(id: string): string {
  return id === "" ? "(top level)" : id;
}

/** The last folders of a path, for small boxes: "apps/desktop/src/lib" -> "…/src/lib". */
export function tailLabel(id: string, segments = 2): string {
  if (id === "") return "(top level)";
  const parts = id.split("/");
  return parts.length <= segments ? id : `…/${parts.slice(-segments).join("/")}`;
}

/** "a/b/c/d/e.ts" -> "a/…/d/e.ts" when it is longer than `max` characters. */
export function shortPath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  const last = parts.pop() ?? p;
  let tail = last;
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `${parts[i]}/${tail}`;
    if (next.length + (parts[0]?.length ?? 0) + 3 > max) break;
    tail = next;
  }
  if (tail === last && last.length >= max) return `…${last.slice(-(max - 1))}`;
  return parts[0] && !tail.startsWith(`${parts[0]}/`) ? `${parts[0]}/…/${tail}` : tail;
}

/** "a/b/c.ts" -> { name: "c.ts", dir: "a/b" }, so lists can lead with the file name. */
export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

/** 0.004 -> "<1%", 0.42 -> "42%". */
export function percent(share: number): string {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** 1234 -> "1.2k", 1_500_000 -> "1.5M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const busy = (n: CodeMapNode) => n.importedBy * 3 + n.importsOut * 2 + Math.log2(1 + n.files);

/** The busiest modules first (most imported, then most imports, then size), at most `max`. */
export function busiestModules(nodes: CodeMapNode[], max: number): CodeMapNode[] {
  return nodes
    .filter((n) => !n.outside)
    .sort((a, b) => busy(b) - busy(a) || a.id.localeCompare(b.id))
    .slice(0, max);
}

export interface GraphBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  path: string;
  x2: number;
  y2: number;
  cycle: boolean;
  weight: number;
}

export interface ModuleLayout {
  boxes: GraphBox[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export interface GraphGeometry {
  width: number;
  minHeight: number;
  maxHeight: number;
  colGap: number;
  rowGap: number;
  pad: number;
}

export const GRAPH_NODE: GraphGeometry = {
  width: 168,
  minHeight: 36,
  maxHeight: 58,
  colGap: 56,
  rowGap: 10,
  pad: 12,
};
/** Smaller boxes for the project home, so more of the graph fits at a glance. */
export const COMPACT_NODE: GraphGeometry = {
  width: 128,
  minHeight: 32,
  maxHeight: 46,
  colGap: 32,
  rowGap: 8,
  pad: 10,
};

/** Taller boxes for bigger modules (by the square root, so one huge folder does not dwarf the rest). */
export function nodeHeight(files: number, maxFiles: number, g: GraphGeometry = GRAPH_NODE): number {
  const { minHeight, maxHeight } = g;
  if (maxFiles <= 1) return minHeight;
  const t = Math.sqrt(Math.max(0, files - 1) / Math.max(1, maxFiles - 1));
  return Math.round(minHeight + (maxHeight - minHeight) * Math.min(1, t));
}

/**
 * The modules for the project home: the busiest, leaving out test folders (they import everything
 * and push the rest of the graph sideways) unless almost nothing else is left.
 */
export function homeModules(nodes: CodeMapNode[], max: number): CodeMapNode[] {
  const inside = nodes.filter((n) => !n.outside);
  const code = inside.filter((n) => n.area !== "tests");
  return busiestModules(code.length >= 2 ? code : inside, max);
}

/**
 * Lays modules out left to right: a module that imports another sits to its left, so entry points
 * and apps come first and shared code ends up on the right. Cycles are cut where they are found.
 */
export function layoutModules(
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
  g: GraphGeometry = GRAPH_NODE,
): ModuleLayout {
  const ids = new Set(nodes.map((n) => n.id));
  const importers = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const meta = new Map<string, CodeMapEdge>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    importers.get(e.to)?.push(e.from);
    meta.set(`${e.from}>${e.to}`, e);
  }
  const dag = layoutDag(
    nodes.map((n) => ({ id: n.id, deps: importers.get(n.id) ?? [] })),
    { nodeWidth: g.width, nodeHeight: g.maxHeight, colGap: g.colGap, rowGap: g.rowGap, pad: g.pad },
  );
  const maxFiles = Math.max(1, ...nodes.map((n) => n.files));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const boxes = dag.nodes.map((b) => {
    const h = nodeHeight(byId.get(b.id)?.files ?? 1, maxFiles, g);
    return { id: b.id, x: b.x, y: b.y + (g.maxHeight - h) / 2, w: g.width, h };
  });
  // layoutDag draws every edge (a cycle's back edge too) between box centres, so the edges still
  // meet the shorter boxes.
  const drawn = dag.edges.map((e) => {
    const m = meta.get(`${e.from}>${e.to}`);
    return { ...e, cycle: m?.cycle ?? false, weight: m?.weight ?? 1 };
  });
  return { boxes, edges: drawn, width: dag.width, height: dag.height };
}

export interface TestBar {
  id: string;
  at: string;
  passed: boolean;
  /** Share of tests that passed (1 when the run gave no counts). */
  ratio: number;
  text: string;
}

/** The last test runs as sparkline bars, oldest first. */
export function testBars(events: DepoEvent[], max = 20): TestBar[] {
  return events
    .filter((e) => e.type === "test_result")
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq)
    .slice(-max)
    .map((e) => {
      const passedCount = typeof e.details?.passed === "number" ? e.details.passed : null;
      const failedCount = typeof e.details?.failed === "number" ? e.details.failed : null;
      const total = (passedCount ?? 0) + (failedCount ?? 0);
      const passed = e.status === "succeeded";
      const ratio = total > 0 ? (passedCount ?? 0) / total : passed ? 1 : 0;
      return { id: e.id, at: e.ts, passed, ratio, text: e.text };
    });
}

/** Languages as shares of the lines, biggest first; the tail is folded into "Other". */
export function languageShares(
  languages: { name: string; files: number; lines: number }[],
  max = 4,
): { name: string; lines: number; share: number }[] {
  const total = languages.reduce((s, l) => s + l.lines, 0);
  if (total === 0) return [];
  const sorted = [...languages].sort((a, b) => b.lines - a.lines);
  const head = sorted.slice(0, max).map((l) => ({ name: l.name, lines: l.lines, share: l.lines / total }));
  const rest = sorted.slice(max).reduce((s, l) => s + l.lines, 0);
  if (rest > 0) head.push({ name: "Other", lines: rest, share: rest / total });
  return head;
}

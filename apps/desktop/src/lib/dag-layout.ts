/**
 * A small left-to-right layered layout for the task graph (no graph library needed).
 * Layers come from the longest dependency chain; rows inside a layer are ordered by the
 * barycentre of their neighbours to keep edges short and crossings few.
 */

export interface DagNodeInput {
  id: string;
  deps: string[];
}

export interface DagNodeBox {
  id: string;
  layer: number;
  row: number;
  x: number;
  y: number;
}

export interface DagEdge {
  from: string;
  to: string;
  /** SVG path data, from the right edge of `from` to the left edge of `to`. */
  path: string;
  /** Where the edge ends (the middle of the left side of `to`). */
  x2: number;
  y2: number;
}

export interface DagLayout {
  nodes: DagNodeBox[];
  edges: DagEdge[];
  width: number;
  height: number;
  layers: number;
}

export interface DagOptions {
  nodeWidth: number;
  nodeHeight: number;
  colGap: number;
  rowGap: number;
  pad: number;
}

export const DAG_DEFAULTS: DagOptions = { nodeWidth: 200, nodeHeight: 84, colGap: 48, rowGap: 14, pad: 12 };

/** Layer of every node: 0 for nodes without (known) dependencies, else 1 + the deepest dependency. */
export function dagLayers(nodes: DagNodeInput[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    // A cycle (should never come from the engine) is cut where it is found.
    if (visiting.has(id)) return -1;
    visiting.add(id);
    let l = 0;
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d) || d === id) continue;
      const dl = visit(d);
      if (dl >= 0) l = Math.max(l, dl + 1);
    }
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const n of nodes) visit(n.id);
  return layer;
}

export function layoutDag(nodes: DagNodeInput[], options: Partial<DagOptions> = {}): DagLayout {
  const o = { ...DAG_DEFAULTS, ...options };
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0, layers: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map(
    nodes.map((n) => [n.id, [...new Set(n.deps.filter((d) => ids.has(d) && d !== n.id))]]),
  );
  const dependents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [id, ds] of deps) for (const d of ds) dependents.get(d)?.push(id);
  const layerOf = dagLayers(nodes);
  const count = Math.max(...layerOf.values()) + 1;
  const inputIndex = new Map(nodes.map((n, i) => [n.id, i]));

  // Rows per layer, starting in the order the plan lists them.
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id) ?? 0]?.push(n.id);

  const rowOf = new Map<string, number>();
  const index = () => {
    for (const l of layers)
      l.forEach((id, i) => {
        rowOf.set(id, i);
      });
  };
  index();
  const bary = (id: string, side: Map<string, string[]>): number | null => {
    const ns = side.get(id) ?? [];
    if (ns.length === 0) return null;
    return ns.reduce((s, n) => s + (rowOf.get(n) ?? 0), 0) / ns.length;
  };
  const sortLayer = (l: string[], side: Map<string, string[]>) => {
    const keyed = l.map((id) => ({ id, b: bary(id, side) ?? rowOf.get(id) ?? 0 }));
    keyed.sort((a, b) => a.b - b.b || (inputIndex.get(a.id) ?? 0) - (inputIndex.get(b.id) ?? 0));
    l.splice(0, l.length, ...keyed.map((k) => k.id));
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < layers.length; i++) {
      sortLayer(layers[i] ?? [], deps);
      index();
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      sortLayer(layers[i] ?? [], dependents);
      index();
    }
  }

  const maxRows = Math.max(...layers.map((l) => l.length));
  const rowStep = o.nodeHeight + o.rowGap;
  const colStep = o.nodeWidth + o.colGap;
  const height = o.pad * 2 + maxRows * o.nodeHeight + (maxRows - 1) * o.rowGap;
  const width = o.pad * 2 + count * o.nodeWidth + (count - 1) * o.colGap;
  const boxes = new Map<string, DagNodeBox>();
  layers.forEach((l, li) => {
    // Each layer is centred vertically.
    const offset = ((maxRows - l.length) * rowStep) / 2;
    l.forEach((id, row) => {
      boxes.set(id, { id, layer: li, row, x: o.pad + li * colStep, y: o.pad + offset + row * rowStep });
    });
  });

  const edges: DagEdge[] = [];
  for (const n of nodes) {
    const to = boxes.get(n.id);
    if (!to) continue;
    for (const d of deps.get(n.id) ?? []) {
      const from = boxes.get(d);
      if (!from) continue;
      const x1 = from.x + o.nodeWidth;
      const y1 = from.y + o.nodeHeight / 2;
      const x2 = to.x;
      const y2 = to.y + o.nodeHeight / 2;
      const bend = Math.max(o.colGap * 0.6, (x2 - x1) * 0.35);
      edges.push({
        from: d,
        to: n.id,
        path: `M${round(x1)} ${round(y1)} C${round(x1 + bend)} ${round(y1)} ${round(x2 - bend)} ${round(y2)} ${round(x2)} ${round(y2)}`,
        x2: round(x2),
        y2: round(y2),
      });
    }
  }
  // Boxes in the input order, so callers can map them back to plan nodes easily.
  const ordered = nodes.map((n) => boxes.get(n.id)).filter((b): b is DagNodeBox => !!b);
  return { nodes: ordered, edges, width, height, layers: count };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

import { expect, test } from "vitest";
import { DAG_DEFAULTS, dagLayers, layoutDag } from "./dag-layout";

/** The full-system plan the Manager starts from (17 tasks, 14 steps). */
const FULL = [
  { id: "brief", deps: [] },
  { id: "options", deps: ["brief"] },
  { id: "critique", deps: ["options"] },
  { id: "design", deps: ["critique"] },
  { id: "diagrams", deps: ["critique"] },
  { id: "database", deps: ["critique"] },
  { id: "backend", deps: ["database"] },
  { id: "integration", deps: ["backend"] },
  { id: "frontend", deps: ["design", "integration"] },
  { id: "testing", deps: ["frontend"] },
  { id: "security", deps: ["testing"] },
  { id: "enhancement", deps: ["security"] },
  { id: "diagrams-final", deps: ["integration"] },
  { id: "ux-audit", deps: ["enhancement"] },
  { id: "deck", deps: ["ux-audit", "diagrams-final"] },
  { id: "final-review", deps: ["deck"] },
  { id: "docs", deps: ["final-review"] },
];

test("layers follow the longest dependency chain", () => {
  const l = dagLayers(FULL);
  expect(l.get("brief")).toBe(0);
  expect(l.get("design")).toBe(3);
  expect(l.get("database")).toBe(3);
  expect(l.get("frontend")).toBe(6);
  expect(l.get("deck")).toBe(11);
  expect(l.get("docs")).toBe(13);
});

test("every dependency sits in an earlier column, and no two cards overlap", () => {
  const out = layoutDag(FULL);
  expect(out.nodes).toHaveLength(17);
  expect(out.layers).toBe(14);
  const box = new Map(out.nodes.map((b) => [b.id, b]));
  for (const n of FULL) for (const d of n.deps) expect(box.get(d)?.x).toBeLessThan(box.get(n.id)?.x ?? 0);
  const { nodeWidth: w, nodeHeight: h } = DAG_DEFAULTS;
  for (const a of out.nodes)
    for (const b of out.nodes) {
      if (a.id === b.id) continue;
      const apart = a.x + w <= b.x || b.x + w <= a.x || a.y + h <= b.y || b.y + h <= a.y;
      expect(apart).toBe(true);
    }
  // Every card fits inside the canvas, which grows sideways (it scrolls) and stays short.
  for (const b of out.nodes) {
    expect(b.x + w).toBeLessThanOrEqual(out.width);
    expect(b.y + h).toBeLessThanOrEqual(out.height);
  }
  expect(out.width).toBeGreaterThan(out.height * 4);
  expect(out.edges).toHaveLength(FULL.reduce((s, n) => s + n.deps.length, 0));
});

test("edges run from the right side of a dependency to the left side of its task", () => {
  const out = layoutDag([
    { id: "a", deps: [] },
    { id: "b", deps: ["a"] },
  ]);
  const [a, b] = out.nodes;
  const [e] = out.edges;
  const { nodeWidth: w, nodeHeight: h } = DAG_DEFAULTS;
  expect(e?.path.startsWith(`M${(a?.x ?? 0) + w} ${(a?.y ?? 0) + h / 2} C`)).toBe(true);
  expect(e?.x2).toBe(b?.x);
  expect(e?.y2).toBe((b?.y ?? 0) + h / 2);
});

test("rows are ordered to keep children next to their parents", () => {
  const out = layoutDag([
    { id: "p1", deps: [] },
    { id: "p2", deps: [] },
    { id: "c2", deps: ["p2"] },
    { id: "c1", deps: ["p1"] },
  ]);
  const row = new Map(out.nodes.map((b) => [b.id, b.row]));
  expect(row.get("c1")).toBe(row.get("p1"));
  expect(row.get("c2")).toBe(row.get("p2"));
});

test("unknown dependencies, self references and cycles do not break the layout", () => {
  const out = layoutDag([
    { id: "a", deps: ["ghost", "a"] },
    { id: "b", deps: ["c"] },
    { id: "c", deps: ["b"] },
  ]);
  expect(out.nodes).toHaveLength(3);
  expect(out.nodes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y))).toBe(true);
  expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: 0, layers: 0 });
});

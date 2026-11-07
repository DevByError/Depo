import type { CodeMapEdge, CodeMapNode, DepoEvent } from "@depo/shared";
import { describe, expect, test } from "vitest";
import {
  AREA_TONE,
  busiestModules,
  COMPACT_NODE,
  compactNumber,
  GRAPH_NODE,
  homeModules,
  languageShares,
  layoutModules,
  nodeHeight,
  percent,
  shortPath,
  splitPath,
  tailLabel,
  testBars,
} from "./code-map";

function mod(id: string, over: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id,
    label: id,
    kind: "module",
    area: "core",
    files: 1,
    lines: 10,
    symbols: 1,
    branches: 0,
    importsOut: 0,
    importedBy: 0,
    inCycle: false,
    entry: false,
    module: null,
    outside: false,
    ...over,
  };
}

const edge = (from: string, to: string, cycle = false): CodeMapEdge => ({ from, to, weight: 1, cycle });

describe("code map helpers", () => {
  test("labels stay short and readable", () => {
    expect(tailLabel("apps/desktop/src/lib")).toBe("…/src/lib");
    expect(tailLabel("api/app")).toBe("api/app");
    expect(tailLabel("")).toBe("(top level)");
    expect(shortPath("src/a.ts")).toBe("src/a.ts");
    const long = shortPath("packages/engine/src/codeindex/very/deep/folder/codemap.ts", 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.startsWith("packages/…/")).toBe(true);
    expect(long.endsWith("codemap.ts")).toBe(true);
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1234)).toBe("1.2k");
    expect(compactNumber(52_000)).toBe("52k");
    expect(compactNumber(1_500_000)).toBe("1.5M");
  });

  test("paths lead with the file name; tiny shares read as under one percent", () => {
    expect(splitPath("web/src/lib/cn.ts")).toEqual({ name: "cn.ts", dir: "web/src/lib" });
    expect(splitPath("main.py")).toEqual({ name: "main.py", dir: "" });
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0)).toBe("0%");
    expect(percent(0.416)).toBe("42%");
  });

  test("the home leaves test folders out of the graph unless little else is left", () => {
    const nodes = [
      mod("engine/test", { area: "tests", importsOut: 9 }),
      mod("src/api", { importedBy: 1 }),
      mod("src/db"),
    ];
    expect(homeModules(nodes, 10).map((n) => n.id)).toEqual(["src/api", "src/db"]);
    const onlyTests = [mod("tests", { area: "tests" }), mod("src")];
    expect(homeModules(onlyTests, 10)).toHaveLength(2);
  });

  test("compact boxes are smaller than the full map's", () => {
    const nodes = [mod("a", { files: 9 }), mod("b")];
    const full = layoutModules(nodes, [edge("a", "b")]);
    const compact = layoutModules(nodes, [edge("a", "b")], COMPACT_NODE);
    expect(compact.width).toBeLessThan(full.width);
    expect(compact.boxes[0]?.w).toBe(COMPACT_NODE.width);
  });

  test("every area has a theme colour, and red is kept for cycles", () => {
    expect(Object.values(AREA_TONE)).not.toContain("security");
  });

  test("bigger modules get taller boxes, within limits", () => {
    expect(nodeHeight(1, 100)).toBe(GRAPH_NODE.minHeight);
    expect(nodeHeight(100, 100)).toBe(GRAPH_NODE.maxHeight);
    expect(nodeHeight(25, 100)).toBeGreaterThan(nodeHeight(5, 100));
    expect(nodeHeight(3, 1)).toBe(GRAPH_NODE.minHeight);
  });

  test("importers sit left of what they import; cycle edges keep their flag", () => {
    const nodes = [mod("web", { files: 12 }), mod("lib", { files: 3 }), mod("api"), mod("api/models")];
    const edges = [
      edge("web", "lib"),
      edge("api", "api/models", true),
      edge("api/models", "api", true),
      edge("web", "nowhere"),
    ];
    const l = layoutModules(nodes, edges);
    const box = new Map(l.boxes.map((b) => [b.id, b]));
    expect(l.boxes).toHaveLength(4);
    expect(box.get("web")?.x).toBeLessThan(box.get("lib")?.x ?? 0);
    expect(box.get("web")?.h).toBeGreaterThan(box.get("lib")?.h ?? 0);
    for (const b of l.boxes) {
      expect(b.x + b.w).toBeLessThanOrEqual(l.width);
      expect(b.y + b.h).toBeLessThanOrEqual(l.height);
    }
    // The unknown target is dropped; both directions of the cycle are drawn and flagged.
    expect(l.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      "api/models>api",
      "api>api/models",
      "web>lib",
    ]);
    expect(l.edges.filter((e) => e.cycle)).toHaveLength(2);
    expect(layoutModules([], []).boxes).toEqual([]);
  });

  test("the busiest modules come first and outside neighbours are left out", () => {
    const nodes = [
      mod("quiet", { files: 40 }),
      mod("shared", { importedBy: 6 }),
      mod("app", { importsOut: 4 }),
      mod("elsewhere", { outside: true, importedBy: 99 }),
    ];
    expect(busiestModules(nodes, 2).map((n) => n.id)).toEqual(["shared", "app"]);
  });

  test("test runs become sparkline bars, oldest first, with the share that passed", () => {
    const ev = (
      id: string,
      ts: string,
      status: DepoEvent["status"],
      details: DepoEvent["details"],
    ): DepoEvent => ({
      id,
      ts,
      seq: 1,
      projectId: "prj_1",
      taskId: null,
      agent: "coder@1.0.0",
      type: "test_result",
      text: "Tests",
      details,
      durationMs: 10,
      status,
      ephemeral: false,
    });
    const bars = testBars([
      ev("b", "2026-11-02T00:00:00Z", "failed", { passed: 3, failed: 1 }),
      ev("a", "2026-11-01T00:00:00Z", "succeeded", null),
      ev("c", "2026-11-03T00:00:00Z", "succeeded", { passed: 8, failed: 0 }),
    ]);
    expect(bars.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(bars.map((b) => b.ratio)).toEqual([1, 0.75, 1]);
    expect(bars[1]?.passed).toBe(false);
  });

  test("languages are shares of the lines, the tail folded into Other", () => {
    const shares = languageShares(
      [
        { name: "TypeScript", files: 10, lines: 600 },
        { name: "Python", files: 4, lines: 200 },
        { name: "CSS", files: 2, lines: 100 },
        { name: "HTML", files: 1, lines: 60 },
        { name: "Go", files: 1, lines: 40 },
      ],
      3,
    );
    expect(shares.map((s) => s.name)).toEqual(["TypeScript", "Python", "CSS", "Other"]);
    expect(shares[0]?.share).toBeCloseTo(0.6);
    expect(shares.reduce((s, l) => s + l.share, 0)).toBeCloseTo(1);
    expect(languageShares([])).toEqual([]);
  });
});

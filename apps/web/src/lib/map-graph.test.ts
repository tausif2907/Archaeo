import { describe, expect, it } from "vitest";
import type { MapData } from "@archaeo/shared";
import { buildGraph, buildTree, expandForHops, importDepths, initialExpanded, visibleIds, visibleNodeFor } from "./map-graph";

const file = (path: string, loc: number, churn = 1, complexity = 1) => ({
  path,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  language: "python",
  loc,
  churn,
  complexity,
  summary: null,
});

const data: MapData = {
  overview: null,
  modules: [{ path: "src/pkg", parentPath: "src", summary: "The package." }],
  files: [
    file("src/pkg/core.py", 3000, 200, 400),
    file("src/pkg/types.py", 1000, 50, 100),
    file("src/pkg/utils.py", 500, 30, 20),
    file("tests/test_core.py", 3800, 60, 10),
    file("tests/test_types.py", 1400, 20, 5),
    file("examples/demo/app.py", 50, 2, 1),
    file("setup.py", 20, 5, 0),
  ],
  edges: [
    { from: "tests/test_core.py", to: "src/pkg/core.py" },
    { from: "tests/test_types.py", to: "src/pkg/types.py" },
    { from: "src/pkg/core.py", to: "src/pkg/types.py" },
    { from: "examples/demo/app.py", to: "src/pkg/core.py" },
  ],
};

describe("map graph", () => {
  const tree = buildTree(data);

  it("rolls up folder stats", () => {
    expect(tree.stats.get("src")).toEqual({ loc: 4500, churn: 280, complexity: 520, files: 3 });
    expect(tree.stats.get("")!.files).toBe(7);
  });

  it("opens single-child chains and the biggest folder by default", () => {
    const expanded = initialExpanded(tree);
    expect([...expanded].sort()).toEqual(["", "src", "src/pkg"]);
    expect(visibleIds(tree, expanded)).toEqual(["examples", "src/pkg/core.py", "src/pkg/types.py", "src/pkg/utils.py", "tests", "setup.py"]);
  });

  it("maps files to their visible ancestor and aggregates edges", () => {
    const expanded = initialExpanded(tree);
    const visible = new Set(visibleIds(tree, expanded));
    expect(visibleNodeFor("tests/test_core.py", visible)).toBe("tests");
    expect(visibleNodeFor("examples/demo/app.py", visible)).toBe("examples");

    const { nodes, edges } = buildGraph(data, tree, expanded);
    expect(edges.map((e) => `${e.source}→${e.target}:${e.count}`).sort()).toEqual([
      "examples→src/pkg/core.py:1",
      "src/pkg/core.py→src/pkg/types.py:1",
      "tests→src/pkg/core.py:1",
      "tests→src/pkg/types.py:1",
    ]);
    const core = nodes.find((n) => n.id === "src/pkg/core.py")!;
    expect(core.data.heat).toBe(4);
    expect(core.data.hotspot).toBe(true);
    expect(core.width).toBeGreaterThan(nodes.find((n) => n.id === "setup.py")!.width);
    expect(nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("orders the grid from importers to foundations and keeps it compact", () => {
    expect(importDepths(["a", "b", "c", "d"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "b" }, // cycle is broken, not looped
    ])).toEqual(new Map([["c", 0], ["b", 1], ["a", 2], ["d", 0]]));

    const { nodes } = buildGraph(data, tree, initialExpanded(tree));
    const byY = [...nodes].sort((p, q) => p.y - q.y || p.x - q.x).map((n) => n.id);
    // Importers (tests, examples) come before the modules they import; types.py imports nothing.
    expect(byY.indexOf("tests")).toBeLessThan(byY.indexOf("src/pkg/core.py"));
    expect(byY.indexOf("src/pkg/core.py")).toBeLessThan(byY.indexOf("src/pkg/types.py"));
    const width = Math.max(...nodes.map((n) => n.x + n.width));
    const height = Math.max(...nodes.map((n) => n.y + n.height));
    expect(width / height).toBeGreaterThan(1);
  });

  it("collapsing a folder folds its edges into it", () => {
    const { edges } = buildGraph(data, tree, new Set(["", "src"]));
    expect(edges.map((e) => `${e.source}→${e.target}:${e.count}`).sort()).toEqual(["examples→src/pkg:1", "tests→src/pkg:2"]);
  });

  it("highlights request-flow hops, opening folders so they are visible", () => {
    const hops = [
      { step: 1, depth: 0, parentStep: null, qualifiedName: "test_main", kind: "function", path: "tests/test_core.py", startLine: 1, endLine: 5, callLine: null, explanation: "" },
      { step: 2, depth: 1, parentStep: 1, qualifiedName: "main", kind: "function", path: "src/pkg/core.py", startLine: 10, endLine: 40, callLine: 3, explanation: "" },
      { step: 3, depth: 2, parentStep: 2, qualifiedName: "util", kind: "function", path: "src/pkg/utils.py", startLine: 1, endLine: 4, callLine: 12, explanation: "" },
    ];
    const expanded = expandForHops(tree, initialExpanded(tree), hops);
    expect(expanded.has("tests")).toBe(true);
    const { nodes, edges } = buildGraph(data, tree, expanded, hops);
    expect(nodes.find((n) => n.id === "src/pkg/core.py")!.data.steps).toEqual([2]);
    const flow = edges.filter((e) => e.flow).map((e) => e.id).sort();
    expect(flow).toEqual(["src/pkg/core.py→src/pkg/utils.py", "tests/test_core.py→src/pkg/core.py"]);
  });
});

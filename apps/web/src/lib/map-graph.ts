import type { FlowHop, MapData, MapFile } from "@archaeo/shared";

export type MapNodeData = {
  id: string;
  kind: "folder" | "file";
  label: string;
  loc: number;
  churn: number;
  complexity: number;
  files: number;
  summary: string | null;
  /** 0 (cold) … 4 (hottest), by churn percentile among visible nodes */
  heat: number;
  hotspot: boolean;
  expanded: boolean;
  /** Request-flow steps that land in this node */
  steps: number[];
};

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: MapNodeData;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  /** Part of the traced request flow */
  flow: boolean;
}

export interface Tree {
  folders: Set<string>;
  subfolders: Map<string, string[]>;
  filesIn: Map<string, MapFile[]>;
  summaries: Map<string, string | null>;
  stats: Map<string, { loc: number; churn: number; complexity: number; files: number }>;
}

export function parentOf(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function buildTree(data: MapData): Tree {
  const folders = new Set<string>([""]);
  for (const f of data.files) for (let d = parentOf(f.path); d !== null; d = parentOf(d)) folders.add(d);
  const subfolders = new Map<string, string[]>();
  for (const d of [...folders].sort()) {
    const p = parentOf(d);
    if (p !== null) subfolders.set(p, [...(subfolders.get(p) ?? []), d]);
  }
  const filesIn = new Map<string, MapFile[]>();
  for (const f of data.files) filesIn.set(f.folder, [...(filesIn.get(f.folder) ?? []), f]);

  const stats = new Map<string, { loc: number; churn: number; complexity: number; files: number }>();
  const visit = (d: string): { loc: number; churn: number; complexity: number; files: number } => {
    const s = { loc: 0, churn: 0, complexity: 0, files: 0 };
    for (const f of filesIn.get(d) ?? []) {
      s.loc += f.loc;
      s.churn += f.churn;
      s.complexity += f.complexity;
      s.files++;
    }
    for (const sub of subfolders.get(d) ?? []) {
      const c = visit(sub);
      s.loc += c.loc;
      s.churn += c.churn;
      s.complexity += c.complexity;
      s.files += c.files;
    }
    stats.set(d, s);
    return s;
  };
  visit("");
  return { folders, subfolders, filesIn, summaries: new Map(data.modules.map((m) => [m.path, m.summary])), stats };
}

/** Folders a click on "expand" can open: root, then single-child chains, then the biggest folder if the map is still sparse. */
export function initialExpanded(tree: Tree): Set<string> {
  const expanded = new Set<string>([""]);
  const openChains = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of expanded) {
        const subs = tree.subfolders.get(d) ?? [];
        if (subs.length === 1 && !(tree.filesIn.get(d)?.length) && !expanded.has(subs[0]!)) {
          expanded.add(subs[0]!);
          changed = true;
        }
      }
    }
  };
  openChains();
  if (visibleIds(tree, expanded).length < 8) {
    // The biggest application folder: tests, docs and examples are rarely what the map is for.
    const support = /(^|\/)(tests?|__tests__|spec|docs?|examples?|benchmarks?|scripts)$/;
    const biggest = visibleIds(tree, expanded)
      .filter((id) => tree.folders.has(id) && !support.test(id))
      .sort((a, b) => tree.stats.get(b)!.loc - tree.stats.get(a)!.loc)[0];
    if (biggest !== undefined) {
      expanded.add(biggest);
      openChains();
    }
  }
  return expanded;
}

/** Visible node ids: children of expanded folders that are not themselves expanded. */
export function visibleIds(tree: Tree, expanded: Set<string>): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const sub of tree.subfolders.get(d) ?? []) {
      if (expanded.has(sub)) walk(sub);
      else out.push(sub);
    }
    for (const f of tree.filesIn.get(d) ?? []) out.push(f.path);
  };
  walk("");
  return out;
}

/** The visible node a file is drawn inside (itself, or its deepest collapsed ancestor). */
export function visibleNodeFor(path: string, visible: Set<string>): string | null {
  if (visible.has(path)) return path;
  for (let d = parentOf(path); d !== null; d = parentOf(d)) if (visible.has(d)) return d;
  return null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

const NODE_HEIGHT = 56;
const MAX_WIDTH = 250;
const GAP_X = 28;
const GAP_Y = 36;
/** Target width:height of the laid-out map (the canvas is wider than tall). */
const ASPECT = 1.6;

/**
 * Import depth: 0 for modules that import nothing visible, else 1 + the deepest module they import.
 * Cycles are broken by ignoring edges back into the current DFS path.
 */
export function importDepths(ids: string[], edges: { source: string; target: string }[]): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    onPath.add(id);
    let d = 0;
    for (const t of out.get(id) ?? []) if (!onPath.has(t)) d = Math.max(d, 1 + visit(t));
    onPath.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) visit(id);
  return depth;
}

export function buildGraph(data: MapData, tree: Tree, expanded: Set<string>, hops: FlowHop[] = []): { nodes: LaidOutNode[]; edges: MapEdge[] } {
  const ids = visibleIds(tree, expanded);
  const visible = new Set(ids);
  const fileByPath = new Map(data.files.map((f) => [f.path, f]));

  const raw = ids.map((id) => {
    const folder = tree.folders.has(id);
    const f = fileByPath.get(id);
    const s = folder ? tree.stats.get(id)! : { loc: f!.loc, churn: f!.churn, complexity: f!.complexity, files: 1 };
    return { id, folder, s, summary: folder ? (tree.summaries.get(id) ?? null) : (f?.summary ?? null) };
  });

  // Heat: churn percentile among visible nodes. Hotspot: top churn and top complexity together.
  const churns = [...raw.map((r) => r.s.churn)].sort((a, b) => a - b);
  const cx = [...raw.map((r) => r.s.complexity)].sort((a, b) => a - b);
  const pct = (sorted: number[], v: number) => (sorted.length <= 1 ? 0 : sorted.filter((x) => x < v).length / (sorted.length - 1));
  const maxLoc = Math.max(1, ...raw.map((r) => r.s.loc));

  const steps = new Map<string, number[]>();
  for (const h of hops) {
    const n = visibleNodeFor(h.path, visible);
    if (n) steps.set(n, [...(steps.get(n) ?? []), h.step]);
  }

  const sized = raw.map((r) => ({ ...r, width: Math.round(140 + (MAX_WIDTH - 140) * Math.sqrt(r.s.loc / maxLoc)) }));

  const counts = new Map<string, MapEdge>();
  for (const e of data.edges) {
    const from = visibleNodeFor(e.from, visible);
    const to = visibleNodeFor(e.to, visible);
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    const prev = counts.get(key);
    if (prev) prev.count++;
    else counts.set(key, { id: key, source: from, target: to, count: 1, flow: false });
  }
  // Request-flow hops become highlighted edges (added if no import edge exists).
  for (const h of hops) {
    const parent = hops.find((p) => p.step === h.parentStep);
    if (!parent) continue;
    const from = visibleNodeFor(parent.path, visible);
    const to = visibleNodeFor(h.path, visible);
    if (!from || !to || from === to) continue;
    const key = `${from}→${to}`;
    const prev = counts.get(key);
    if (prev) prev.flow = true;
    else counts.set(key, { id: key, source: from, target: to, count: 0, flow: true });
  }
  // Dependency-ordered grid: importers (entry points, tests) first, foundations last, wrapped into rows.
  const depths = importDepths(ids, [...counts.values()].filter((e) => e.count > 0));
  const order = [...sized].sort((a, b) => depths.get(b.id)! - depths.get(a.id)! || a.id.localeCompare(b.id));
  const cols = Math.max(1, Math.min(order.length, Math.round(Math.sqrt((order.length * ASPECT * (NODE_HEIGHT + GAP_Y)) / (MAX_WIDTH + GAP_X)))));
  const cell = new Map(order.map((r, i) => [r.id, { col: i % cols, row: Math.floor(i / cols) }]));

  const nodes = sized.map((r) => {
    const { col, row } = cell.get(r.id)!;
    const heatPct = pct(churns, r.s.churn);
    return {
      id: r.id,
      x: col * (MAX_WIDTH + GAP_X) + (MAX_WIDTH - r.width) / 2,
      y: row * (NODE_HEIGHT + GAP_Y),
      width: r.width,
      height: NODE_HEIGHT,
      data: {
        id: r.id,
        kind: r.folder ? ("folder" as const) : ("file" as const),
        label: basename(r.id),
        loc: r.s.loc,
        churn: r.s.churn,
        complexity: r.s.complexity,
        files: r.s.files,
        summary: r.summary,
        heat: Math.min(4, Math.floor(heatPct * 5)),
        hotspot: raw.length >= 5 && heatPct >= 0.85 && pct(cx, r.s.complexity) >= 0.75,
        expanded: false,
        steps: steps.get(r.id) ?? [],
      },
    };
  });
  return { nodes, edges: [...counts.values()] };
}

/** Folders to open so every hop's file is visible. */
export function expandForHops(tree: Tree, expanded: Set<string>, hops: FlowHop[]): Set<string> {
  const next = new Set(expanded);
  for (const h of hops) for (let d = parentOf(h.path); d !== null; d = parentOf(d)) if (tree.folders.has(d)) next.add(d);
  return next;
}

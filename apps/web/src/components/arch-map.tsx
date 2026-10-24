"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import type { FlowHop, FlowTrace, MapData, SymbolHit } from "@archaeo/shared";
import { api } from "@/lib/api";
import { buildGraph, buildTree, expandForHops, initialExpanded, type MapNodeData } from "@/lib/map-graph";
import { useCodeViewer } from "./code-viewer";
import { fmt } from "./repo-status";

const HEAT = [
  "bg-stone-50 border-stone-300 dark:bg-stone-900 dark:border-stone-700",
  "bg-amber-50 border-amber-200 dark:bg-amber-950/50 dark:border-amber-900",
  "bg-amber-100 border-amber-300 dark:bg-amber-900/50 dark:border-amber-800",
  "bg-orange-200 border-orange-400 dark:bg-orange-900/60 dark:border-orange-700",
  "bg-red-200 border-red-400 dark:bg-red-900/60 dark:border-red-700",
];

type MapNode = Node<MapNodeData & { selected: boolean; onToggle: (id: string) => void }, "module">;

const ModuleNode = memo(function ModuleNode({ data }: NodeProps<MapNode>) {
  return (
    <div
      className={`relative flex h-14 items-center gap-2 rounded-lg border px-2.5 text-left shadow-sm ${HEAT[data.heat]} ${data.selected ? "ring-2 ring-stone-900 dark:ring-stone-100" : ""} ${
        data.steps.length ? "outline outline-2 outline-offset-2 outline-sky-500" : ""
      }`}
      style={{ width: "100%" }}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-stone-400" />
      {data.kind === "folder" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(data.id);
          }}
          aria-label={`Expand ${data.label}`}
          className="nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded border border-stone-400 bg-white text-xs font-bold text-stone-700 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-200"
        >
          +
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-stone-900 dark:text-stone-100">
          {data.label}
          {data.kind === "folder" && "/"}
        </p>
        <p className="truncate text-[10px] tabular-nums text-stone-600 dark:text-stone-400">
          {fmt(data.loc)} loc{data.kind === "folder" ? ` · ${data.files} files` : ""} · {fmt(data.churn)} commits
        </p>
      </div>
      {data.hotspot && <span className="shrink-0 rounded bg-red-600 px-1 text-[9px] font-bold uppercase text-white">hot</span>}
      {data.steps.length > 0 && (
        <span className="absolute -right-2 -top-2 rounded-full bg-sky-600 px-1.5 text-[10px] font-bold text-white">{data.steps.slice(0, 3).join(",")}{data.steps.length > 3 ? "…" : ""}</span>
      )}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-stone-400" />
    </div>
  );
});

const nodeTypes = { module: ModuleNode };

function FlowPanel({ repoId, trace, onTrace }: { repoId: string; trace: FlowTrace | null; onTrace: (t: FlowTrace | null) => void }) {
  const viewer = useCodeViewer();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.searchSymbols(repoId, query.trim()).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [repoId, query]);

  async function trace_(hit?: SymbolHit) {
    const symbol = hit?.qualifiedName ?? query.trim();
    if (!symbol) return;
    setLoading(true);
    setError(null);
    setHits([]);
    try {
      onTrace(await api.flow(repoId, { symbol, ...(hit ? { path: hit.path } : {}) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Request-flow walkthrough</h3>
      <div className="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void trace_();
          }}
          className="flex gap-2"
        >
          <label htmlFor="flow-entry" className="sr-only">
            Entry point
          </label>
          <input
            id="flow-entry"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Entry point, e.g. main or Command.invoke"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-mono text-sm outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-900"
          />
          <button type="submit" disabled={loading || !query.trim()} className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900">
            {loading ? "Tracing…" : "Trace"}
          </button>
          {trace && (
            <button type="button" onClick={() => onTrace(null)} className="text-sm text-stone-500 hover:underline">
              Clear
            </button>
          )}
        </form>
        {hits.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-stone-200 bg-white text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900">
            {hits.map((h) => (
              <li key={`${h.path}:${h.startLine}`}>
                <button type="button" onClick={() => void trace_(h)} className="flex w-full justify-between gap-3 px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800">
                  <span className="truncate font-mono">{h.qualifiedName}</span>
                  <span className="shrink-0 truncate text-xs text-stone-500">{h.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {trace && (
        <ol className="space-y-1.5 text-sm">
          {trace.hops.map((h: FlowHop) => (
            <li key={h.step} className="flex gap-2" style={{ paddingLeft: `${h.depth * 14}px` }}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-[10px] font-bold text-white">{h.step}</span>
              <span className="min-w-0">
                <button
                  type="button"
                  onClick={() => viewer?.open({ path: h.path, startLine: h.startLine, endLine: h.endLine })}
                  className="font-mono font-medium text-sky-800 hover:underline dark:text-sky-300"
                >
                  {h.qualifiedName}
                </button>
                <span className="text-stone-500"> · {h.path}:{h.startLine}</span>
                <span className="block text-stone-700 dark:text-stone-300">{h.explanation}</span>
              </span>
            </li>
          ))}
          {trace.truncated && <li className="text-xs text-stone-500">Stopped at {trace.hops.length} hops.</li>}
          {trace.fallback && <li className="text-xs text-stone-500">Explanations taken from docstrings (no usable model output).</li>}
        </ol>
      )}
      {!trace && <p className="text-xs text-stone-500">Follows the static call graph from an entry point and highlights each hop on the map.</p>}
    </div>
  );
}

export function ArchitectureMap({ repoId }: { repoId: string }) {
  const viewer = useCodeViewer();
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<FlowTrace | null>(null);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [startedAt] = useState(() => performance.now());

  const tree = useMemo(() => (data ? buildTree(data) : null), [data]);

  useEffect(() => {
    api.map(repoId).then(
      (d) => {
        setData(d);
        setExpanded(initialExpanded(buildTree(d)));
      },
      (err: Error) => setError(err.message),
    );
  }, [repoId]);

  useEffect(() => {
    if (tree && trace) setExpanded((e) => expandForHops(tree, e, trace.hops));
  }, [tree, trace]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.has(id)) next.add(id);
      // Collapsing also collapses everything inside.
      else for (const d of [...next]) if (d === id || d.startsWith(`${id}/`)) next.delete(d);
      return next;
    });

  const graph = useMemo(() => (data && tree ? buildGraph(data, tree, expanded, trace?.hops ?? []) : null), [data, tree, expanded, trace]);

  const nodes: MapNode[] = useMemo(
    () =>
      (graph?.nodes ?? []).map((n) => ({
        id: n.id,
        type: "module" as const,
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        style: { width: n.width },
        data: { ...n.data, selected: n.id === selected, onToggle: toggle },
      })),
    [graph, selected],
  );
  const edges: Edge[] = useMemo(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.flow,
        style: {
          strokeWidth: e.flow ? 2.5 : Math.min(4, 1 + Math.log2(1 + e.count)),
          stroke: e.flow ? "#0284c7" : selected && (e.source === selected || e.target === selected) ? "#d97706" : undefined,
          // Dense graphs: fade everything not related to the selection or the traced flow.
          opacity: e.flow || (selected ? e.source === selected || e.target === selected : !trace) ? 1 : 0.15,
        },
        zIndex: e.flow || (selected && (e.source === selected || e.target === selected)) ? 1 : 0,
      })),
    [graph, trace, selected],
  );

  useEffect(() => {
    if (graph && renderMs === null) requestAnimationFrame(() => setRenderMs(Math.round(performance.now() - startedAt)));
  }, [graph, renderMs, startedAt]);

  const sel = graph?.nodes.find((n) => n.id === selected)?.data ?? null;
  const keyFiles = useMemo(() => {
    if (!data || !sel || sel.kind !== "folder") return [];
    return data.files
      .filter((f) => f.path.startsWith(`${sel.id}/`))
      .sort((a, b) => b.churn - a.churn || b.loc - a.loc)
      .slice(0, 6);
  }, [data, sel]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">Could not load the map: {error}</p>;
  if (!data || !graph) return <div className="h-[560px] animate-pulse rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900" />;

  return (
    <div className="space-y-4">
      {data.overview && <p className="line-clamp-3 text-sm text-stone-700 dark:text-stone-300" title={data.overview}>{data.overview}</p>}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="h-[560px] overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900" data-testid="arch-map" data-render-ms={renderMs ?? undefined}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            minZoom={0.1}
            nodesConnectable={false}
            colorMode="system"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="space-y-4 text-sm">
          {sel ? (
            <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{sel.kind}</p>
                <p className="break-all font-mono font-semibold">{sel.id}</p>
              </div>
              <p className="tabular-nums text-stone-600 dark:text-stone-400">
                {fmt(sel.loc)} lines · {fmt(sel.churn)} commits · complexity {fmt(sel.complexity)}
                {sel.kind === "folder" && ` · ${sel.files} files`}
              </p>
              {sel.summary && <p className="line-clamp-6 text-stone-700 dark:text-stone-300" title={sel.summary}>{sel.summary}</p>}
              {sel.kind === "folder" ? (
                <>
                  {keyFiles.length > 0 && (
                    <div>
                      <p className="mb-1 font-medium">Key files</p>
                      <ul className="space-y-1">
                        {keyFiles.map((f) => (
                          <li key={f.path} className="flex justify-between gap-2">
                            <button type="button" onClick={() => viewer?.open({ path: f.path, startLine: 1, endLine: 1 })} className="min-w-0 truncate font-mono text-sky-800 hover:underline dark:text-sky-300">
                              {f.path.slice(sel.id.length + 1)}
                            </button>
                            <span className="shrink-0 tabular-nums text-stone-500">{f.churn}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button type="button" onClick={() => toggle(sel.id)} className="rounded-lg border border-stone-300 px-3 py-1.5 font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800">
                    Expand folder
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => viewer?.open({ path: sel.id, startLine: 1, endLine: 1 })}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                >
                  Open code
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-dashed border-stone-300 p-4 text-stone-500 dark:border-stone-700">
              <p>Click a node for its summary. Use + to expand a folder.</p>
              <p className="text-xs">Width = lines of code · color = churn (commits) · arrows = imports.</p>
              <div className="flex gap-1">
                {HEAT.map((c, i) => (
                  <span key={i} className={`h-3 flex-1 rounded border ${c}`} title={["coldest", "", "", "", "hottest"][i]} />
                ))}
              </div>
            </div>
          )}
          {[...expanded].some((d) => d !== "") && (
            <div>
              <p className="mb-1 text-xs font-medium text-stone-500">Expanded folders</p>
              <div className="flex flex-wrap gap-1">
                {[...expanded]
                  .filter((d) => d !== "")
                  .sort()
                  .map((d) => (
                    <button key={d} type="button" onClick={() => toggle(d)} className="rounded-full border border-stone-300 px-2 py-0.5 font-mono text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800" title={`Collapse ${d}`}>
                      {d} −
                    </button>
                  ))}
              </div>
            </div>
          )}
          <FlowPanel repoId={repoId} trace={trace} onTrace={setTrace} />
        </aside>
      </div>
      {renderMs !== null && <p className="text-xs text-stone-500">Map ready in {renderMs} ms.</p>}
    </div>
  );
}

"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import type { FlowHop, FlowTrace, MapData, SymbolHit } from "@archaeo/shared";
import { api } from "@/lib/api";
import { buildGraph, buildTree, expandForHops, initialExpanded, type MapNodeData } from "@/lib/map-graph";
import { useCodeViewer } from "./code-viewer";
import { fmt } from "./repo-status";

// Churn, quiet to hot, on one amber ramp (commits are people's work).
const HEAT = [
  "bg-heat-0 border-heat-edge-0",
  "bg-heat-1 border-heat-edge-1",
  "bg-heat-2 border-heat-edge-2",
  "bg-heat-3 border-heat-edge-3",
  "bg-heat-4 border-heat-edge-4",
];

/** The first `max` characters, cut at a word, with an ellipsis. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text);

// The label face is monospaced (0.632em advance), so a node can shorten its label to fit instead of clipping it.
const LABEL_ADVANCE_PX = 12 * 0.632;
function fitLabel(label: string, nodeWidth: number | undefined, reservedPx: number): string {
  if (!nodeWidth) return label;
  const chars = Math.floor((nodeWidth - 26 - reservedPx) / LABEL_ADVANCE_PX);
  return label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label;
}

type MapNode = Node<MapNodeData & { selected: boolean; onToggle: (id: string) => void }, "module">;

const ModuleNode = memo(function ModuleNode({ data, width }: NodeProps<MapNode>) {
  const label = fitLabel(data.kind === "folder" ? `${data.label}/` : data.label, width, (data.kind === "folder" ? 32 : 0) + (data.hotspot ? 46 : 0));
  return (
    <div
      className={`relative flex h-14 items-center gap-2 rounded-pill border px-3 text-left ${HEAT[data.heat]} ${data.selected ? "ring-2 ring-ink" : ""} ${
        data.steps.length ? "outline-2 outline-offset-2 outline-cool" : ""
      }`}
      style={{ width: "100%" }}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-edge" />
      {data.kind === "folder" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(data.id);
          }}
          aria-label={`Expand ${data.label}`}
          className="nodrag flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-chip border border-edge bg-paper-3 text-sm font-medium text-ink transition-colors duration-200 hover:bg-paper-hover active:bg-paper-2"
        >
          +
        </button>
      )}
      <div className="@container min-w-0 flex-1">
        <p className="measured truncate text-xs font-medium text-ink" title={data.label}>
          {label}
        </p>
        <p className="measured truncate text-[11px] text-ink-2">
          <span>{fmt(data.loc)} loc</span>
          {data.kind === "folder" && <span className="ml-2 hidden @min-[15rem]:inline">{data.files} files</span>}
          <span className="ml-2 hidden @min-[10.5rem]:inline">{fmt(data.churn)} commits</span>
        </p>
      </div>
      {data.hotspot && (
        <span className="chip shrink-0" data-tone="bad">
          hot
        </span>
      )}
      {data.steps.length > 0 && (
        <span className="measured absolute -right-2 -top-2.5 rounded-chip bg-cool px-1.5 text-[11px] font-medium text-paper-3">
          {data.steps.slice(0, 3).join(",")}
          {data.steps.length > 3 ? "…" : ""}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-edge" />
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
    <div className="space-y-3 p-4">
      <h3>Request-flow walkthrough</h3>
      <div className="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void trace_();
          }}
        >
          <label htmlFor="flow-entry" className="label">
            Entry point
          </label>
          <div className="flex gap-2">
            <input
              id="flow-entry"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="main or Command.invoke"
              autoComplete="off"
              className="field measured flex-1"
            />
            <button type="submit" disabled={loading || !query.trim()} aria-busy={loading || undefined} className="btn btn--primary">
              {loading ? "Tracing…" : "Trace"}
            </button>
            {trace && (
              <button type="button" onClick={() => onTrace(null)} className="btn btn--ghost">
                Clear
              </button>
            )}
          </div>
        </form>
        {hits.length > 0 && (
          <ul className="panel absolute z-(--z-dropdown) mt-1 max-h-64 w-full overflow-auto py-1 text-sm">
            {hits.map((h) => (
              <li key={`${h.path}:${h.startLine}`}>
                <button
                  type="button"
                  onClick={() => void trace_(h)}
                  className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-3 px-3 text-left transition-colors duration-200 hover:bg-paper-hover active:bg-paper-3"
                >
                  <span className="measured truncate text-ink">{h.qualifiedName}</span>
                  <span className="measured shrink-0 truncate text-xs text-muted">{h.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {trace && (
        <ol className="space-y-3 text-sm">
          {trace.hops.map((h: FlowHop) => (
            <li key={h.step} className="flex gap-2.5" style={{ paddingLeft: `${h.depth * 14}px` }}>
              <span className="measured mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-chip bg-cool px-1 text-[11px] font-medium text-paper-3">{h.step}</span>
              <span className="min-w-0 space-y-0.5">
                <button type="button" onClick={() => viewer?.open({ path: h.path, startLine: h.startLine, endLine: h.endLine })} className="ref ref--instrument font-medium">
                  {h.qualifiedName}
                </button>
                <span className="measured block truncate text-xs text-muted">
                  {h.path}:{h.startLine}
                </span>
                <span className="block text-ink-2">{h.explanation}</span>
              </span>
            </li>
          ))}
          {trace.truncated && <li className="text-xs text-muted">Stopped at {trace.hops.length} hops.</li>}
          {trace.fallback && <li className="text-xs text-muted">Explanations taken from docstrings (no usable model output).</li>}
        </ol>
      )}
      {!trace && <p className="text-xs text-muted">Follows the static call graph from an entry point and highlights each hop on the map.</p>}
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
          stroke: e.flow ? "var(--color-cool)" : selected && (e.source === selected || e.target === selected) ? "var(--color-accent)" : undefined,
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

  if (error) return <p className="text-sm text-bad">Could not load the map: {error}</p>;
  if (!data || !graph) return <div className="skeleton h-[clamp(480px,68dvh,720px)] motion-safe:animate-pulse" aria-busy="true" aria-label="Loading the map" />;

  return (
    <div className="space-y-4">
      {data.overview && (
        <p className="max-w-[75ch] text-sm text-ink-2" title={data.overview}>
          {clip(data.overview, 320)}
        </p>
      )}
      <div className="panels lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[clamp(480px,68dvh,720px)] bg-paper-3" data-testid="arch-map" data-render-ms={renderMs ?? undefined}>
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
            edgesFocusable={false}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="divide-y divide-rule text-sm">
          {sel ? (
            <div className="space-y-4 p-4">
              <p className="measured break-all font-medium text-ink">{sel.id}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <dt className="text-xs text-muted">Kind</dt>
                  <dd className="text-ink">{sel.kind}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Lines</dt>
                  <dd className="measured text-ink">{fmt(sel.loc)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Commits</dt>
                  <dd className="measured text-ink">{fmt(sel.churn)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Complexity</dt>
                  <dd className="measured text-ink">{fmt(sel.complexity)}</dd>
                </div>
                {sel.kind === "folder" && (
                  <div>
                    <dt className="text-xs text-muted">Files</dt>
                    <dd className="measured text-ink">{sel.files}</dd>
                  </div>
                )}
              </dl>
              {sel.summary && (
                <p className="line-clamp-6 text-ink-2" title={sel.summary}>
                  {sel.summary}
                </p>
              )}
              {sel.kind === "folder" ? (
                <>
                  {keyFiles.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted">Key files</p>
                      <ul className="space-y-1">
                        {keyFiles.map((f) => (
                          <li key={f.path} className="flex justify-between gap-2">
                            <button type="button" onClick={() => viewer?.open({ path: f.path, startLine: 1, endLine: 1 })} className="ref ref--instrument min-w-0 truncate">
                              {f.path.slice(sel.id.length + 1)}
                            </button>
                            <span className="measured shrink-0 text-muted">{f.churn}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button type="button" onClick={() => toggle(sel.id)} className="btn">
                    Expand folder
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => viewer?.open({ path: sel.id, startLine: 1, endLine: 1 })} className="btn">
                  Open code
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3 p-4 text-ink-2">
              <p>Click a node for its summary. Use + to expand a folder.</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted">Width</dt>
                <dd>lines of code</dd>
                <dt className="text-muted">Color</dt>
                <dd>churn (commits)</dd>
                <dt className="text-muted">Arrows</dt>
                <dd>imports</dd>
              </dl>
              <div>
                <div className="flex gap-1" aria-hidden="true">
                  {HEAT.map((c, i) => (
                    <span key={i} className={`h-3 flex-1 rounded-chip border ${c}`} />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-xs text-muted">
                  <span>Coldest</span>
                  <span>Hottest</span>
                </div>
              </div>
            </div>
          )}
          {[...expanded].some((d) => d !== "") && (
            <div className="p-4">
              <p className="mb-2 text-xs font-medium text-muted">Expanded folders</p>
              <div className="flex flex-wrap gap-1.5">
                {[...expanded]
                  .filter((d) => d !== "")
                  .sort()
                  .map((d) => (
                    <button key={d} type="button" onClick={() => toggle(d)} className="btn measured min-h-8 px-2.5 text-xs font-normal" title={`Collapse ${d}`}>
                      {d} −
                    </button>
                  ))}
              </div>
            </div>
          )}
          <FlowPanel repoId={repoId} trace={trace} onTrace={setTrace} />
        </aside>
      </div>
      {renderMs !== null && (
        <p className="text-xs text-muted">
          Map ready in <span className="measured">{renderMs} ms</span>.
        </p>
      )}
    </div>
  );
}

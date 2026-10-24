import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@archaeo/db";
import { isTestPath } from "@archaeo/ingest";
import type { Models } from "@archaeo/models";
import type { FlowHop, FlowTrace } from "@archaeo/shared";
import { parseJsonObject } from "../past/json";
import { safeRepoPath } from "./tools";

export interface FlowDeps {
  prisma: PrismaClient;
  models: Pick<Models, "reason">;
  repoId: string;
  repoDir: string;
}

export interface FlowOptions {
  maxDepth?: number;
  maxHops?: number;
  /** Callees followed per function */
  maxChildren?: number;
}

export class FlowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 404,
  ) {
    super(message);
  }
}

interface Sym {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  path: string;
}

const SYSTEM = `You explain a request/command flow through a codebase, one hop at a time.
For each numbered hop, write one short sentence (max 20 words) saying what that function does in this flow. Use only the code shown.
Respond with JSON only: {"hops": [{"step": 1, "explanation": "..."}]}`;

/** First sentence of a Python docstring or JSDoc block for the symbol, if any. */
export function docSummary(lines: string[], startLine: number, endLine: number): string | null {
  // Python: a string literal right after the signature
  for (let i = startLine; i < Math.min(endLine, startLine + 15); i++) {
    const t = (lines[i] ?? "").trim();
    const m = /^[rRuU]?("""|''')(.*)$/.exec(t);
    if (m) {
      let text = m[2]!.replace(/("""|''').*$/, "").trim();
      if (!text) text = (lines[i + 1] ?? "").trim();
      return firstSentence(text);
    }
  }
  // JSDoc above the declaration
  if ((lines[startLine - 2] ?? "").trim().endsWith("*/")) {
    for (let i = startLine - 2; i >= Math.max(0, startLine - 30); i--) {
      if ((lines[i] ?? "").trim().startsWith("/**")) {
        const body = lines
          .slice(i, startLine - 1)
          .map((l) => l.trim().replace(/^\/\*\*|\*\/$|^\*/g, "").trim())
          .filter((l) => l && !l.startsWith("@"));
        return body.length ? firstSentence(body.join(" ")) : null;
      }
    }
  }
  return null;
}

function firstSentence(text: string): string | null {
  const s = text.split(/(?<=[.!?])\s/)[0]?.trim();
  return s ? s.replace(/\.$/, "") : null;
}

/**
 * Traces the call path from an entry point through the static call graph (depth-first, callees in the
 * order they are first called in the source), then explains each hop in one line.
 */
export async function traceFlow(deps: FlowDeps, input: { symbol: string; path?: string }, opts: FlowOptions = {}): Promise<FlowTrace> {
  const maxDepth = opts.maxDepth ?? 5;
  const maxHops = opts.maxHops ?? 12;
  const maxChildren = opts.maxChildren ?? 3;
  const { prisma, repoId } = deps;

  const rows = await prisma.symbol.findMany({
    where: { file: { repoId } },
    select: { id: true, name: true, qualifiedName: true, kind: true, startLine: true, endLine: true, file: { select: { path: true } } },
  });
  const symbols: Sym[] = rows.map((r) => ({ ...r, path: r.file.path }));
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const matches = symbols.filter((s) => (!input.path || s.path === input.path) && (s.qualifiedName === input.symbol || s.name === input.symbol));
  // Exact qualified name first, then non-classes; among equals (e.g. typing @overload stubs) the largest body.
  const rank = (s: Sym) => [Number(s.qualifiedName === input.symbol), Number(s.kind !== "class"), s.endLine - s.startLine];
  const entry = [...matches].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return rb[0]! - ra[0]! || rb[1]! - ra[1]! || rb[2]! - ra[2]!;
  })[0];
  if (!entry) throw new FlowError(`Entry point ${input.symbol} not found${input.path ? ` in ${input.path}` : ""}`);

  const edges = await prisma.edge.findMany({ where: { repoId, kind: "call" }, select: { fromSymbolId: true, toSymbolId: true } });
  const callees = new Map<string, string[]>();
  for (const e of edges) if (e.fromSymbolId && e.toSymbolId) callees.set(e.fromSymbolId, [...(callees.get(e.fromSymbolId) ?? []), e.toSymbolId]);

  const sources = new Map<string, string[]>();
  const linesOf = async (path: string) => {
    if (!sources.has(path)) {
      const full = safeRepoPath(deps.repoDir, path);
      sources.set(path, ((full ? await readFile(full, "utf8").catch(() => "") : "") || "").split("\n"));
    }
    return sources.get(path)!;
  };

  const entryIsTest = isTestPath(entry.path);
  const hops: FlowHop[] = [];
  // The most central callees of `sym`, in call order: the caller's own class first, then its file,
  // then body size and fan-out.
  const childrenOf = async (sym: Sym, taken: Set<string>) => {
    const src = await linesOf(sym.path);
    const cls = sym.kind === "method" ? sym.qualifiedName.slice(0, sym.qualifiedName.lastIndexOf(".")) : null;
    const weight = (c: Sym) =>
      (cls && c.qualifiedName.startsWith(`${cls}.`) ? 1000 : 0) + (c.path === sym.path ? 200 : 0) + c.endLine - c.startLine + 10 * (callees.get(c.id)?.length ?? 0);
    return (callees.get(sym.id) ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is Sym => !!c && !taken.has(c.id) && (entryIsTest || !isTestPath(c.path)))
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, maxChildren)
      .map((c) => {
        const re = new RegExp(`\\b${c.name.replace(/[$]/g, "\\$")}\\s*\\(`);
        let line: number | null = null;
        for (let i = sym.startLine; i < sym.endLine && line === null; i++) if (re.test(src[i] ?? "")) line = i + 1;
        return { c, line };
      })
      .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  };

  // Choose hops breadth-first so every level of the main path fits in the budget...
  interface TreeNode {
    sym: Sym;
    depth: number;
    callLine: number | null;
    children: TreeNode[];
  }
  const root: TreeNode = { sym: entry, depth: 0, callLine: null, children: [] };
  const taken = new Set([entry.id]);
  const queue = [root];
  let count = 1;
  let truncated = false;
  while (queue.length) {
    const node = queue.shift()!;
    if (node.depth >= maxDepth) continue;
    for (const { c, line } of await childrenOf(node.sym, taken)) {
      if (count >= maxHops) {
        truncated = true;
        break;
      }
      taken.add(c.id);
      const child = { sym: c, depth: node.depth + 1, callLine: line, children: [] };
      node.children.push(child);
      queue.push(child);
      count++;
    }
  }
  // ...then number and show them depth-first, as a call tree.
  const number = (node: TreeNode, parentStep: number | null) => {
    const step = hops.length + 1;
    const s = node.sym;
    hops.push({ step, depth: node.depth, parentStep, qualifiedName: s.qualifiedName, kind: s.kind, path: s.path, startLine: s.startLine, endLine: s.endLine, callLine: node.callLine, explanation: "" });
    for (const child of node.children) number(child, step);
  };
  number(root, null);

  // Explanations: model first, docstrings as the fallback.
  const docs = await Promise.all(hops.map(async (h) => docSummary(await linesOf(h.path), h.startLine, h.endLine)));
  let fallback = true;
  try {
    const snippets = await Promise.all(
      hops.map(async (h) => {
        const src = await linesOf(h.path);
        return `Hop ${h.step} (depth ${h.depth}): ${h.kind} ${h.qualifiedName} at ${h.path}:${h.startLine}-${h.endLine}\n${src.slice(h.startLine - 1, Math.min(h.endLine, h.startLine + 24)).join("\n")}`;
      }),
    );
    const step = await deps.models.reason([
      { role: "system", content: SYSTEM },
      { role: "user", content: `Flow starting at ${entry.qualifiedName}:\n\n${snippets.join("\n\n")}` },
    ]);
    const parsed = parseJsonObject(step.content)?.hops;
    if (Array.isArray(parsed)) {
      for (const item of parsed as { step?: unknown; explanation?: unknown }[]) {
        const hop = hops.find((h) => h.step === item.step);
        if (hop && typeof item.explanation === "string" && item.explanation.trim()) hop.explanation = item.explanation.trim();
      }
      fallback = hops.some((h) => !h.explanation);
    }
  } catch {
    // docstrings below
  }
  hops.forEach((h, i) => {
    if (!h.explanation) h.explanation = docs[i] ?? `${h.kind} ${h.qualifiedName}`;
  });
  return { entry: entry.qualifiedName, entryPath: entry.path, hops, fallback, truncated };
}

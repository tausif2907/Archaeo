import { isTestPath } from "@archaeo/ingest";
import type { StackFrame, Suspect } from "@archaeo/shared";
import { formatCodeRef } from "../present/code-refs";
import { searchCode, type ToolContext } from "../present/tools";

interface Candidate extends Suspect {
  fromTrace: boolean;
}

const FRAME_WEIGHT = 10;
const FRAME_DECAY = 0.75;
const NEIGHBOR_WEIGHT = 2;
const SEARCH_WEIGHT = 4;

/**
 * Ranks likely bug locations: stack frames in the repo (innermost strongest), then their call-graph
 * neighbors, then code similar to the bug description. Returns the top `limit` as suspects.
 */
export async function rankSuspects(ctx: ToolContext, input: { frames: StackFrame[]; text: string; exception: string | null }, limit = 5): Promise<Suspect[]> {
  const { prisma, repoId } = ctx;
  const candidates = new Map<string, Candidate>();
  const add = (c: Omit<Candidate, "score" | "reasons">, score: number, reason: string) => {
    const key = formatCodeRef(c);
    const prev = candidates.get(key);
    if (prev) {
      prev.score += score;
      if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
      prev.fromTrace ||= c.fromTrace;
    } else candidates.set(key, { ...c, score, reasons: [reason] });
  };

  // 1. Stack frames inside the repo, innermost first.
  const repoFrames = input.frames.filter((f): f is StackFrame & { path: string } => !!f.path);
  const frameSymbols: string[] = [];
  for (const [i, f] of repoFrames.entries()) {
    const sym = await prisma.symbol.findFirst({
      where: { file: { repoId, path: f.path }, startLine: { lte: f.line }, endLine: { gte: f.line } },
      orderBy: [{ startLine: "desc" }],
    });
    const weight = FRAME_WEIGHT * FRAME_DECAY ** i;
    const reason = `In the stack trace at ${f.path}:${f.line}${i === 0 ? " (innermost repo frame)" : ""}`;
    if (sym) {
      add({ path: f.path, startLine: sym.startLine, endLine: sym.endLine, symbol: sym.qualifiedName, fromTrace: true }, weight, reason);
      if (i < 2) frameSymbols.push(sym.id);
    } else {
      add({ path: f.path, startLine: Math.max(1, f.line - 5), endLine: f.line + 5, symbol: null, fromTrace: true }, weight, reason);
    }
  }

  // 2. Callers and callees of the two innermost frame symbols.
  if (frameSymbols.length) {
    const edges = await prisma.edge.findMany({
      where: { repoId, kind: "call", OR: [{ fromSymbolId: { in: frameSymbols } }, { toSymbolId: { in: frameSymbols } }] },
      include: { fromSymbol: { include: { file: true } }, toSymbol: { include: { file: true } } },
      take: 60,
    });
    for (const e of edges) {
      const callee = frameSymbols.includes(e.fromSymbolId ?? "");
      const other = callee ? e.toSymbol : e.fromSymbol;
      const anchor = callee ? e.fromSymbol : e.toSymbol;
      if (!other || !anchor || frameSymbols.includes(other.id)) continue;
      add(
        { path: other.file.path, startLine: other.startLine, endLine: other.endLine, symbol: other.qualifiedName, fromTrace: false },
        NEIGHBOR_WEIGHT,
        callee ? `Called by ${anchor.qualifiedName} from the stack trace` : `Calls ${anchor.qualifiedName} from the stack trace`,
      );
    }
  }

  // 3. Code similar to the bug description.
  const query = [input.exception, input.text].filter(Boolean).join("\n").slice(0, 600);
  if (query.trim()) {
    const hits = await searchCode(ctx, query, 10, { excludeTests: true });
    for (const [rank, h] of hits.entries()) {
      const symbol = h.header.replace(/^\S+:\d+-\d+\s*/, "").replace(/^(function|class|method)\s+/, "") || null;
      add({ path: h.path, startLine: h.startLine, endLine: h.endLine, symbol, fromTrace: false }, SEARCH_WEIGHT / (1 + rank * 0.5), `Matches the bug description (search rank ${rank + 1})`);
    }
  }

  // Suspects are where the bug may live: test code only counts when the stack trace runs through it.
  return [...candidates.values()]
    .filter((c) => c.fromTrace || !isTestPath(c.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ fromTrace: _fromTrace, ...s }) => ({ ...s, score: Math.round(s.score * 100) / 100 }));
}

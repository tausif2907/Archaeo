import { readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, posix, sep } from "node:path";
import type { PrismaClient } from "@archaeo/db";
import { blame, isTestPath } from "@archaeo/ingest";
import type { Models, ToolDefinition } from "@archaeo/models";
import type { CodeRef } from "@archaeo/shared";
import { formatCodeRef } from "./code-refs";

export interface ToolContext {
  prisma: PrismaClient;
  models: Pick<Models, "embed">;
  repoId: string;
  /** Local clone of the repo */
  repoDir: string;
}

export interface ToolResult {
  /** Text shown to the model */
  content: string;
  /** Code ranges the model has now seen (used for fallback answers) */
  refs: CodeRef[];
  /** One line for the UI's activity feed */
  summary: string;
}

export interface AgentTool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT_CHARS = 6000;
const MAX_READ_LINES = 200;

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : text;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = Number(args[key]);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Resolves a repo-relative path inside the clone, rejecting anything that escapes it or touches .git. */
export function safeRepoPath(repoDir: string, path: string): string | null {
  const rel = posix.normalize(path.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (rel.startsWith("..") || rel === ".git" || rel.startsWith(".git/")) return null;
  const full = normalize(join(repoDir, rel));
  return full === normalize(repoDir) || full.startsWith(normalize(repoDir) + sep) ? full : null;
}

// ---------------------------------------------------------------- search_code

const STOPWORDS = new Set(
  "the and for with that this from what where which when how does do did are was were is its into about there their they them then than have has had not but can could would should will just only also any all each some such who whom why use used using code file files function functions class method implemented implement handle handled handles work works get set".split(
    " ",
  ),
);

export function keywords(query: string, max = 12): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const w of raw) {
    const lower = w.toLowerCase();
    if (!STOPWORDS.has(lower)) out.add(lower);
  }
  return [...out].slice(0, max);
}

const MAX_TERMS = 12;
const MAX_CANDIDATE_TERMS = 30;

const SUFFIXES = ["ations", "ation", "ings", "ing", "ers", "er", "ed", "es", "s"];

/** Crude English stem for search terms: "confirmation" → "confirm", "validated" → "validat". */
export function stem(term: string): string {
  for (const s of SUFFIXES) if (term.endsWith(s) && term.length - s.length >= 4) return term.slice(0, -s.length);
  return term;
}

export interface SearchHit extends CodeRef {
  header: string;
  text: string;
  score: number;
}

interface ChunkRow {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** Hybrid retrieval: pgvector similarity + IDF-weighted keyword matches, fused with reciprocal rank. */
export async function searchCode(ctx: ToolContext, query: string, limit = 8, opts: { excludeTests?: boolean } = {}): Promise<SearchHit[]> {
  const { prisma, repoId } = ctx;
  const [vector] = await ctx.models.embed([query]);
  const literal = `[${(vector ?? []).join(",")}]`;
  const byVector = await prisma.$queryRaw<ChunkRow[]>`
    SELECT id, path, "startLine", "endLine", text FROM "Chunk"
    WHERE "repoId" = ${repoId} AND "sourceType" = 'code' AND embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector LIMIT 40`;

  // Long queries (bug reports) name more words than are useful; collect extra candidates and keep the most distinctive.
  const candidates = keywords(query, MAX_CANDIDATE_TERMS);
  let byKeyword: { row: ChunkRow; score: number }[] = [];
  if (candidates.length) {
    const patterns = candidates.map((t) => `%${t}%`);
    const rows = await prisma.$queryRaw<ChunkRow[]>`
      SELECT id, path, "startLine", "endLine", text FROM "Chunk"
      WHERE "repoId" = ${repoId} AND "sourceType" = 'code' AND (text ILIKE ANY(${patterns}) OR path ILIKE ANY(${patterns}))`;
    const total = Math.max(1, await prisma.chunk.count({ where: { repoId, sourceType: "code" } }));
    // Matches must start at an identifier boundary ("bar" never matches inside `progressbar`). Short terms
    // must match whole; longer ones match by stem, so "confirmation" finds `confirm` and "validated" `validate`.
    const matchers = new Map(candidates.map((t) => [t, t.length <= 4 ? new RegExp(`(?<![a-z0-9])${t}(?![a-z0-9])`, "g") : new RegExp(`(?<![a-z0-9])${stem(t)}`, "g")]));
    const count = (t: string, text: string) => text.match(matchers.get(t)!)?.length ?? 0;
    const lower = rows.map((r) => ({ row: r, text: r.text.toLowerCase(), header: r.text.split("\n", 1)[0]!.toLowerCase(), path: r.path.toLowerCase() }));
    const df = new Map(candidates.map((t) => [t, lower.filter((r) => count(t, r.text) || count(t, r.path)).length]));
    // The rarest terms that occur at all; a question with few terms keeps every one, as before.
    const terms = candidates
      .filter((t) => df.get(t)! > 0)
      .sort((a, b) => df.get(a)! - df.get(b)!)
      .slice(0, MAX_TERMS);
    const idf = new Map(terms.map((t) => [t, Math.log(1 + total / (1 + df.get(t)!))]));
    byKeyword = lower
      .map(({ row, text, header, path }) => {
        let score = 0;
        for (const t of terms) {
          const w = idf.get(t)!;
          if (count(t, header)) score += 3 * w;
          if (count(t, path)) score += 1.5 * w;
          const n = count(t, text);
          if (n) score += w * (1 + Math.log(n));
        }
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }

  // Reciprocal rank fusion; tests/examples rank lower unless the question is about them.
  const wantsTests = /\btest|example/i.test(query);
  const fused = new Map<string, { row: ChunkRow; score: number }>();
  const add = (row: ChunkRow, rank: number, weight: number) => {
    const prev = fused.get(row.id) ?? { row, score: 0 };
    prev.score += weight / (60 + rank);
    fused.set(row.id, prev);
  };
  byVector.forEach((row, i) => add(row, i, 1));
  byKeyword.forEach(({ row }, i) => add(row, i, 1.5));
  return [...fused.values()]
    .filter(({ row }) => !opts.excludeTests || !isTestPath(row.path))
    .map(({ row, score }) => ({ row, score: !wantsTests && /(^|\/)(tests?|examples?|docs)\//.test(row.path) ? score * 0.6 : score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      header: row.text.split("\n", 1)[0] ?? "",
      text: row.text.split("\n").slice(1).join("\n"),
      score,
    }));
}

const searchTool: AgentTool = {
  definition: {
    name: "search_code",
    description: "Find code relevant to a natural-language query or identifier. Returns ranked snippets with path:start-end.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, e.g. 'where are environment variables read for options'" }, limit: { type: "integer", minimum: 1, maximum: 15 } },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const query = str(args, "query");
    if (!query) return { content: "Error: query is required.", refs: [], summary: "search_code: missing query" };
    const hits = await searchCode(ctx, query, Math.min(int(args, "limit") ?? 8, 15));
    const lines = hits.map((h, i) => {
      const label = h.header.replace(/^\S+:\d+-\d+\s*/, "");
      const preview = h.text.split("\n").slice(0, 8).join("\n");
      return `${i + 1}. ${formatCodeRef(h)} ${label}\n${preview}`;
    });
    return {
      content: clip(hits.length ? lines.join("\n\n") : "No matches."),
      refs: hits.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
      summary: `Searched for "${query}" (${hits.length} results)`,
    };
  },
};

// ---------------------------------------------------------------- read_file

const readFileTool: AgentTool = {
  definition: {
    name: "read_file",
    description: `Read lines of a file (max ${MAX_READ_LINES} per call). Lines are numbered.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const path = str(args, "path");
    const full = safeRepoPath(ctx.repoDir, path);
    const content = full ? await readFile(full, "utf8").catch(() => null) : null;
    if (content === null) return { content: `Error: file not found: ${path}`, refs: [], summary: `read_file: ${path} not found` };
    const lines = content.split("\n");
    const start = Math.min(int(args, "startLine") ?? 1, lines.length);
    const end = Math.min(int(args, "endLine") ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1, lines.length);
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
    const ref = { path: posix.normalize(path.replace(/^\/+/, "")), startLine: start, endLine: end };
    return { content: clip(`${formatCodeRef(ref)} (file has ${lines.length} lines)\n${body}`), refs: [ref], summary: `Read ${formatCodeRef(ref)}` };
  },
};

// ---------------------------------------------------------------- callers / callees

async function findSymbols(ctx: ToolContext, symbol: string, path?: string) {
  return ctx.prisma.symbol.findMany({
    where: { file: { repoId: ctx.repoId, ...(path ? { path } : {}) }, OR: [{ qualifiedName: symbol }, { name: symbol }, { qualifiedName: { endsWith: `.${symbol}` } }] },
    include: { file: { select: { path: true } } },
    take: 10,
  });
}

function callTool(direction: "callers" | "callees"): AgentTool {
  return {
    definition: {
      name: direction === "callers" ? "get_callers" : "get_callees",
      description: direction === "callers" ? "List functions/methods that call a symbol (from the static call graph)." : "List functions/methods/classes a symbol calls (from the static call graph).",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "Name or qualified name, e.g. Context.invoke" }, path: { type: "string", description: "Optional file to disambiguate" } },
        required: ["symbol"],
      },
    },
    async run(args, ctx) {
      const symbol = str(args, "symbol");
      const syms = await findSymbols(ctx, symbol, str(args, "path") || undefined);
      if (!syms.length) return { content: `No symbol named ${symbol}.`, refs: [], summary: `${direction} of ${symbol}: not found` };
      const ids = syms.map((s) => s.id);
      const edges = await ctx.prisma.edge.findMany({
        where: { repoId: ctx.repoId, kind: "call", ...(direction === "callers" ? { toSymbolId: { in: ids } } : { fromSymbolId: { in: ids } }) },
        include: {
          fromSymbol: { include: { file: { select: { path: true } } } },
          toSymbol: { include: { file: { select: { path: true } } } },
        },
        take: 40,
      });
      const others = edges.map((e) => (direction === "callers" ? e.fromSymbol : e.toSymbol)).filter((s): s is NonNullable<typeof s> => !!s);
      const refs = others.map((s) => ({ path: s.file.path, startLine: s.startLine, endLine: s.endLine }));
      const target = syms.map((s) => `${s.qualifiedName} (${formatCodeRef({ path: s.file.path, startLine: s.startLine, endLine: s.endLine })})`).join(", ");
      const list = others.map((s, i) => `- ${s.kind} ${s.qualifiedName} ${formatCodeRef(refs[i]!)}`).join("\n");
      return {
        content: clip(`${direction === "callers" ? "Callers of" : "Called by"} ${target}:\n${list || "(none found in the static call graph)"}`),
        refs,
        summary: `${others.length} ${direction} of ${symbol}`,
      };
    },
  };
}

// ---------------------------------------------------------------- git_blame

const blameTool: AgentTool = {
  definition: {
    name: "git_blame",
    description: "Who last changed a line, when, in which commit and PR.",
    parameters: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path", "line"] },
  },
  async run(args, ctx) {
    const path = str(args, "path");
    const line = int(args, "line");
    if (!line || !safeRepoPath(ctx.repoDir, path)) return { content: "Error: valid path and line are required.", refs: [], summary: "git_blame: bad arguments" };
    const shares = await blame(ctx.repoDir, path, line, line).catch(() => []);
    const b = shares[0];
    if (!b) return { content: `No blame for ${path}:${line}.`, refs: [], summary: `git_blame ${path}:${line}: nothing` };
    const prs = await ctx.prisma.pullRequest.findMany({ where: { repoId: ctx.repoId, linkedCommitShas: { has: b.sha } }, select: { number: true, title: true } });
    const pr = prs.map((p) => ` in PR #${p.number} "${p.title}"`).join("");
    return {
      content: `${path}:${line} was last changed by ${b.author} on ${b.date.toISOString().slice(0, 10)} in commit ${b.sha.slice(0, 7)} "${b.summary}"${pr}.`,
      refs: [{ path, startLine: line, endLine: line }],
      summary: `Blamed ${path}:${line} → ${b.sha.slice(0, 7)}`,
    };
  },
};

// ---------------------------------------------------------------- list_dir

const listDirTool: AgentTool = {
  definition: {
    name: "list_dir",
    description: "List a directory of the repo (default: root) with file sizes and summaries where known.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
  },
  async run(args, ctx) {
    const path = str(args, "path").replace(/\/+$/, "");
    const full = safeRepoPath(ctx.repoDir, path || ".");
    const entries = full ? await readdir(full, { withFileTypes: true }).catch(() => null) : null;
    if (!entries) return { content: `Error: not a directory: ${path || "/"}`, refs: [], summary: `list_dir ${path || "/"}: not found` };
    const prefix = path ? `${path}/` : "";
    const files = await ctx.prisma.file.findMany({ where: { repoId: ctx.repoId, path: { startsWith: prefix } }, select: { path: true, loc: true, summary: true } });
    const known = new Map(files.map((f) => [f.path, f]));
    const rows: string[] = [];
    for (const e of entries.filter((e) => e.name !== ".git").sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) {
        rows.push(`${rel}/`);
        continue;
      }
      const f = known.get(rel);
      const size = f ? `${f.loc} loc` : `${Math.round(((await stat(join(full!, e.name)).catch(() => null))?.size ?? 0) / 1024)} KB`;
      rows.push(`${rel} (${size})${f?.summary ? ` — ${f.summary.slice(0, 160)}` : ""}`);
    }
    return { content: clip(rows.join("\n") || "(empty)"), refs: [], summary: `Listed ${path || "/"} (${rows.length} entries)` };
  },
};

export const CODE_TOOLS: AgentTool[] = [searchTool, readFileTool, callTool("callers"), callTool("callees"), blameTool, listDirTool];

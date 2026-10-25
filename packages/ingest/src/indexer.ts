import { chunksMissingEmbedding, setChunkEmbeddings, type PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import { buildCallEdges, symbolKey } from "./callgraph";
import { codeChunks } from "./chunk";
import { createParser } from "./parser";
import { buildImportEdges, ImportResolver } from "./resolve";
import type { ParsedFile, SourceFile } from "./types";

export interface IndexDeps {
  prisma: PrismaClient;
  log: (msg: string) => void;
}

/**
 * Builds the code index for a repo: File rows (by content hash), symbols, code chunks, and import/call edges.
 * Unchanged files are skipped unless `reindexAll`; edges are always rebuilt. Also used for eval snapshots.
 */
export async function indexCode({ prisma, log }: IndexDeps, repoId: string, sources: SourceFile[], reindexAll = false): Promise<void> {
  const parser = await createParser();
  const parsed: ParsedFile[] = [];
  const parsedByPath = new Map<string, ParsedFile>();
  for (const src of sources) {
    const p = parser.parse(src.path, src.content);
    if (!p) continue;
    parsed.push(p);
    parsedByPath.set(src.path, p);
  }

  const existing = await prisma.file.findMany({ where: { repoId }, select: { id: true, path: true, hash: true } });
  const existingByPath = new Map(existing.map((f) => [f.path, f]));
  const current = new Set(sources.map((s) => s.path));

  const stale = existing.filter((f) => !current.has(f.path));
  if (stale.length) {
    await prisma.chunk.deleteMany({ where: { repoId, sourceType: "code", path: { in: stale.map((f) => f.path) } } });
    await prisma.file.deleteMany({ where: { id: { in: stale.map((f) => f.id) } } });
  }

  const changed = sources.filter((s) => reindexAll || existingByPath.get(s.path)?.hash !== s.hash);
  log(`  ${sources.length} source files, ${changed.length} ${reindexAll ? "re-indexed (index version changed)" : "new or changed"}, ${stale.length} removed`);

  for (const src of changed) {
    const p = parsedByPath.get(src.path);
    if (!p) continue;
    await prisma.$transaction(async (tx) => {
      const file = await tx.file.upsert({
        where: { repoId_path: { repoId, path: src.path } },
        create: { repoId, path: src.path, language: src.language, hash: src.hash, loc: src.loc, complexity: p.complexity },
        // Keep the summary unless the content itself changed.
        update: { language: src.language, hash: src.hash, loc: src.loc, complexity: p.complexity, ...(existingByPath.get(src.path)?.hash !== src.hash ? { summary: null } : {}) },
      });
      await tx.symbol.deleteMany({ where: { fileId: file.id } });
      await tx.chunk.deleteMany({ where: { repoId, sourceType: "code", path: src.path } });

      const symbols = await tx.symbol.createManyAndReturn({
        data: p.symbols.map((s) => ({
          fileId: file.id,
          kind: s.kind,
          name: s.name,
          qualifiedName: s.qualifiedName,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
        select: { id: true, qualifiedName: true, startLine: true },
      });
      const symbolIds = new Map(symbols.map((s) => [symbolKey(src.path, s), s.id]));

      const chunks = codeChunks(src, p);
      await tx.chunk.createMany({
        data: chunks.map((c) => ({
          repoId,
          sourceType: "code" as const,
          sourceId: symbolIds.get(c.sourceKey) ?? file.id,
          path: c.path,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
        })),
      });
    });
  }

  // Edges are cheap to rebuild and depend on every file, so always rebuild them in full.
  const files = await prisma.file.findMany({ where: { repoId }, select: { id: true, path: true } });
  const fileIds = new Map(files.map((f) => [f.path, f.id]));
  const symbols = await prisma.symbol.findMany({
    where: { file: { repoId } },
    select: { id: true, qualifiedName: true, startLine: true, file: { select: { path: true } } },
  });
  const symbolIds = new Map(symbols.map((s) => [symbolKey(s.file.path, s), s.id]));

  const importEdges = buildImportEdges(parsed, new ImportResolver(parsed.map((p) => p.path)));
  const callEdges = buildCallEdges(parsed, importEdges);

  await prisma.$transaction([
    prisma.edge.deleteMany({ where: { repoId } }),
    prisma.edge.createMany({
      data: importEdges.flatMap((e) => {
        const fromFileId = fileIds.get(e.from);
        const toFileId = fileIds.get(e.to);
        return fromFileId && toFileId ? [{ repoId, kind: "import" as const, fromFileId, toFileId }] : [];
      }),
    }),
    prisma.edge.createMany({
      data: callEdges.flatMap((e) => {
        const fromSymbolId = symbolIds.get(e.from);
        const toSymbolId = symbolIds.get(e.to);
        return fromSymbolId && toSymbolId ? [{ repoId, kind: "call" as const, fromSymbolId, toSymbolId }] : [];
      }),
    }),
  ]);
  log(`  ${importEdges.length} import edges, ${callEdges.length} call edges`);
}

/** Embeds every chunk of the repo that has no embedding yet, in batches. */
export async function embedPendingChunks({ prisma, models, log, batchSize = 64 }: IndexDeps & { models: Pick<Models, "embed">; batchSize?: number }, repoId: string): Promise<void> {
  let total = 0;
  for (;;) {
    const rows = await chunksMissingEmbedding(prisma, repoId, batchSize);
    if (rows.length === 0) break;
    const vectors = await models.embed(rows.map((r) => r.text));
    if (vectors.length !== rows.length) throw new Error(`embed returned ${vectors.length} vectors for ${rows.length} texts`);
    await setChunkEmbeddings(
      prisma,
      rows.map((r, i) => ({ id: r.id, embedding: vectors[i]! })),
    );
    total += rows.length;
  }
  log(`  embedded ${total} chunks`);
}

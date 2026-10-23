import { PrismaClient } from "@prisma/client";
import type { CallRecorder, ModelCallRecord } from "@archaeo/models";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Shared Prisma client. Reused across hot reloads in dev. */
export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Persists every model call to the ModelCall table. Failures are logged, never thrown. */
export class PrismaCallRecorder implements CallRecorder {
  constructor(private readonly client: PrismaClient = prisma) {}

  async record(call: ModelCallRecord): Promise<void> {
    try {
      await this.client.modelCall.create({
        data: {
          runId: call.runId ?? null,
          task: call.task,
          model: call.model,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          latencyMs: call.latencyMs,
          cost: call.cost,
        },
      });
    } catch (err) {
      console.warn("[db] failed to record model call", err);
    }
  }
}

// ---------------------------------------------------------------- pgvector helpers (Prisma can't type vector columns)

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Chunks of a repo that still need an embedding. */
export function chunksMissingEmbedding(client: PrismaClient, repoId: string, limit: number): Promise<{ id: string; text: string }[]> {
  return client.$queryRaw`SELECT id, text FROM "Chunk" WHERE "repoId" = ${repoId} AND embedding IS NULL ORDER BY id LIMIT ${limit}`;
}

export async function setChunkEmbeddings(client: PrismaClient, rows: { id: string; embedding: number[] }[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const vectors = rows.map((r) => toVectorLiteral(r.embedding));
  await client.$executeRaw`
    UPDATE "Chunk" AS c SET embedding = v.e::vector
    FROM unnest(${ids}::text[], ${vectors}::text[]) AS v(id, e)
    WHERE c.id = v.id`;
}

export async function countEmbeddedChunks(client: PrismaClient, repoId: string): Promise<number> {
  const [row] = await client.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Chunk" WHERE "repoId" = ${repoId} AND embedding IS NOT NULL`;
  return row?.n ?? 0;
}

/** Live counts for progress and stats. */
export async function repoCounts(client: PrismaClient, repoId: string) {
  const [files, loc, symbols, importEdges, callEdges, commits, pullRequests, issues, chunks, embedded, summarizedFiles, summarizedCommits] =
    await Promise.all([
      client.file.count({ where: { repoId } }),
      client.file.aggregate({ where: { repoId }, _sum: { loc: true } }).then((r) => r._sum.loc ?? 0),
      client.symbol.count({ where: { file: { repoId } } }),
      client.edge.count({ where: { repoId, kind: "import" } }),
      client.edge.count({ where: { repoId, kind: "call" } }),
      client.commit.count({ where: { repoId } }),
      client.pullRequest.count({ where: { repoId } }),
      client.issue.count({ where: { repoId } }),
      client.chunk.count({ where: { repoId } }),
      countEmbeddedChunks(client, repoId),
      client.file.count({ where: { repoId, summary: { not: null } } }),
      client.commit.count({ where: { repoId, summary: { not: null } } }),
    ]);
  return { files, loc, symbols, importEdges, callEdges, commits, pullRequests, issues, chunks, embedded, summarizedFiles, summarizedCommits };
}

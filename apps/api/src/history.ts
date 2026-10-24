import { explainWhy } from "@archaeo/agent";
import type { PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { EraDto, EraStats, WhyResult } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import type { HistoryService } from "./app";

const WHY_CACHE_SIZE = 200;

/** Prisma + git backed HistoryService. Why answers are cached per repo HEAD. */
export function createHistoryService(prisma: PrismaClient, models: Pick<Models, "reason">, enqueueEras: (repoId: string) => Promise<void>): HistoryService {
  const whyCache = new Map<string, WhyResult>();

  return {
    async eras(repoId) {
      const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId }, select: { erasStatus: true, erasMessage: true } });
      const eras = await prisma.era.findMany({ where: { repoId }, orderBy: { startDate: "asc" } });
      const shas = eras.flatMap((e) => e.keyCommitShas);
      const numbers = eras.flatMap((e) => e.keyPrNumbers);
      const [commits, prs] = await Promise.all([
        prisma.commit.findMany({ where: { repoId, sha: { in: shas } }, select: { sha: true, message: true, author: true, date: true } }),
        prisma.pullRequest.findMany({ where: { repoId, number: { in: numbers } }, select: { number: true, title: true, mergedAt: true } }),
      ]);
      const commitBySha = new Map(commits.map((c) => [c.sha, c]));
      const prByNumber = new Map(prs.map((p) => [p.number, p]));

      const dtos: EraDto[] = eras.map((e) => ({
        id: e.id,
        title: e.title,
        startDate: e.startDate.toISOString(),
        endDate: e.endDate.toISOString(),
        narrative: e.narrative,
        stats: e.stats as EraStats | null,
        keyCommits: e.keyCommitShas.flatMap((sha) => {
          const c = commitBySha.get(sha);
          return c ? [{ sha, shortSha: sha.slice(0, 7), subject: c.message.split("\n", 1)[0] ?? "", author: c.author, date: c.date.toISOString() }] : [];
        }),
        keyPrs: e.keyPrNumbers.flatMap((n) => {
          const p = prByNumber.get(n);
          return p ? [{ number: n, title: p.title, mergedAt: p.mergedAt?.toISOString() ?? null }] : [];
        }),
      }));
      return { status: repo.erasStatus, message: repo.erasMessage, eras: dtos };
    },

    async regenerateEras(repoId) {
      await prisma.repo.update({ where: { id: repoId }, data: { erasStatus: "pending", erasMessage: null } });
      await enqueueEras(repoId);
    },

    async files(repoId) {
      return prisma.file.findMany({ where: { repoId }, select: { path: true, language: true, loc: true }, orderBy: { path: "asc" } });
    },

    async symbols(repoId, path) {
      return prisma.symbol.findMany({
        where: { file: { repoId, path } },
        select: { name: true, qualifiedName: true, kind: true, startLine: true, endLine: true },
        orderBy: { startLine: "asc" },
      });
    },

    async why(repo, input) {
      const key = `${repo.id}:${repo.headSha}:${JSON.stringify(input)}`;
      const hit = whyCache.get(key);
      if (hit) return hit;
      const result = await explainWhy({ prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name) }, input);
      whyCache.set(key, result);
      if (whyCache.size > WHY_CACHE_SIZE) whyCache.delete(whyCache.keys().next().value!);
      return result;
    },
  };
}

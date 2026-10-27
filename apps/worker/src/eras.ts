import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildEraEvidence,
  detectEras,
  eraFingerprint,
  loadCitationIndex,
  writeEraNarrative,
  type EvidenceCommit,
  type EraNarrative,
} from "@archaeo/agent";
import type { Prisma, PrismaClient } from "@archaeo/db";
import { readTags, releaseTags } from "@archaeo/ingest";
import { loadModelConfig, routeId, type Models } from "@archaeo/models";
import type { EraStats } from "@archaeo/shared";
import type { IngestConfig } from "./config";

export interface ErasDeps {
  prisma: PrismaClient;
  models: Pick<Models, "reason">;
  config: IngestConfig;
  log: (msg: string) => void;
}

const CONCURRENCY = 3;

/**
 * Detects eras from stored commits and release tags, then writes a cited narrative per era.
 * Narratives are reused for eras whose evidence fingerprint is unchanged and that the current model wrote without
 * falling back, unless `force`.
 */
export async function runEras(repoId: string, { prisma, models, config, log }: ErasDeps, force = false): Promise<void> {
  const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId } });
  await prisma.repo.update({ where: { id: repoId }, data: { erasStatus: "running", erasMessage: "Detecting eras" } });
  const reasonModel = routeId(loadModelConfig(), "reason");

  const rows = await prisma.commit.findMany({ where: { repoId }, select: { sha: true, date: true, author: true, message: true, filesChanged: true } });
  const commits = rows.map((r) => {
    const files = (r.filesChanged as { path: string; additions: number; deletions: number }[] | null) ?? [];
    return { ...r, files };
  });
  const dir = join(config.workspaceDir, repo.owner, repo.name);
  const releases = existsSync(dir) ? releaseTags(await readTags(dir)) : [];

  const drafts = detectEras(
    commits.map((c) => ({ sha: c.sha, date: c.date, author: c.author, files: c.files.map((f) => f.path) })),
    releases,
  );
  log(`[${repo.owner}/${repo.name}] ${drafts.length} eras from ${commits.length} commits and ${releases.length} release tags`);

  const commitsBySha = new Map<string, EvidenceCommit>(
    commits.map((c) => [
      c.sha,
      { sha: c.sha, message: c.message, author: c.author, date: c.date, linesChanged: c.files.reduce((s, f) => s + f.additions + f.deletions, 0) },
    ]),
  );
  const prs = await prisma.pullRequest.findMany({
    where: { repoId, mergedAt: { not: null } },
    select: { number: true, title: true, body: true, mergedAt: true, linkedCommitShas: true },
  });
  const index = await loadCitationIndex(prisma, repoId);
  const previous = await prisma.era.findMany({ where: { repoId } });
  const previousByFingerprint = new Map(previous.filter((e) => e.fingerprint && e.narrative).map((e) => [e.fingerprint!, e]));

  const evidence = drafts.map((d) => buildEraEvidence(d, prs, commitsBySha));
  const narratives: (EraNarrative & { reused: boolean })[] = new Array(drafts.length);
  let next = 0;
  let written = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, drafts.length) }, async () => {
      while (next < drafts.length) {
        const i = next++;
        const ev = evidence[i]!;
        // Reuse only what this model wrote, and retry narratives that fell back to evidence.
        const prev = force ? undefined : previousByFingerprint.get(eraFingerprint(ev));
        const prevStats = prev?.stats as EraStats | null | undefined;
        if (prev && prevStats?.model === reasonModel && !prevStats.fallback) {
          narratives[i] = { title: prev.title, narrative: prev.narrative!, fallback: false, invalidCitations: [], reused: true };
        } else {
          narratives[i] = { ...(await writeEraNarrative(models, ev, index)), reused: false };
          written++;
          await prisma.repo.update({ where: { id: repoId }, data: { erasMessage: `Writing era narratives (${written} written)` } });
        }
      }
    }),
  );

  await prisma.$transaction([
    prisma.era.deleteMany({ where: { repoId } }),
    prisma.era.createMany({
      data: drafts.map((d, i) => {
        const ev = evidence[i]!;
        const n = narratives[i]!;
        const stats: EraStats = {
          commits: ev.commitCount,
          contributors: ev.contributors,
          topAuthors: ev.topAuthors,
          topAreas: ev.topAreas,
          releases: ev.releases,
          fallback: n.fallback,
          model: reasonModel,
        };
        return {
          repoId,
          title: n.title,
          startDate: d.start,
          endDate: d.end,
          narrative: n.narrative,
          keyCommitShas: ev.keyCommits.map((c) => index.resolveSha(c.sha)).filter((s): s is string => !!s),
          keyPrNumbers: ev.keyPrs.map((p) => p.number),
          stats: stats as unknown as Prisma.InputJsonValue,
          fingerprint: eraFingerprint(ev),
        };
      }),
    }),
  ]);

  const fallbacks = narratives.filter((n) => n.fallback).length;
  const dropped = narratives.reduce((s, n) => s + n.invalidCitations.length, 0);
  const notes = [
    fallbacks ? `${fallbacks} of ${drafts.length} narratives were assembled from evidence because the model output was unusable.` : "",
    dropped ? `${dropped} invalid citations were removed.` : "",
  ].filter(Boolean);
  await prisma.repo.update({ where: { id: repoId }, data: { erasStatus: "ready", erasMessage: notes.join(" ") || null } });
  log(`  eras ready: ${written} written, ${drafts.length - written} reused, ${fallbacks} from evidence, ${dropped} citations dropped`);
}

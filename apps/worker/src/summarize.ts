import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoCounts, type Prisma, type PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { RepoStats, SummarizeJobData } from "@archaeo/shared";
import type { IngestConfig } from "./config";

const FILE_INSTRUCTION =
  "You summarize source files for developers new to a codebase. In 1-3 sentences, say what this file is responsible for and its key functions or classes. No preamble.";
const COMMIT_INSTRUCTION =
  "Summarize this git commit in one sentence: what changed and, if the message says so, why. No preamble.";
const MAX_FILE_CHARS = 12_000;
const CONCURRENCY = 4;

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export interface SummarizeDeps {
  prisma: PrismaClient;
  models: Pick<Models, "summarizeCheap">;
  config: IngestConfig;
}

/** One BullMQ job: summarize a batch of files or commits that still lack a summary. */
export async function summarizeBatch(job: SummarizeJobData, { prisma, models, config }: SummarizeDeps): Promise<number> {
  let done = 0;
  if (job.kind === "file") {
    const repo = await prisma.repo.findUniqueOrThrow({ where: { id: job.repoId }, select: { owner: true, name: true } });
    const dir = join(config.workspaceDir, repo.owner, repo.name);
    const files = await prisma.file.findMany({ where: { id: { in: job.ids }, summary: null }, select: { id: true, path: true } });
    await pool(files, CONCURRENCY, async (f) => {
      const content = await readFile(join(dir, f.path), "utf8").catch(() => null);
      if (content === null) return;
      const summary = await models.summarizeCheap({ instruction: FILE_INSTRUCTION, text: `File: ${f.path}\n\n${content.slice(0, MAX_FILE_CHARS)}`, maxWords: 60 });
      await prisma.file.update({ where: { id: f.id }, data: { summary } });
      done++;
    });
  } else {
    const commits = await prisma.commit.findMany({ where: { id: { in: job.ids }, summary: null }, select: { id: true, message: true, filesChanged: true } });
    await pool(commits, CONCURRENCY, async (c) => {
      const files = ((c.filesChanged as { path: string }[] | null) ?? []).slice(0, 20).map((f) => f.path);
      const summary = await models.summarizeCheap({ instruction: COMMIT_INSTRUCTION, text: `${c.message}\n\nFiles: ${files.join(", ")}`, maxWords: 40 });
      await prisma.commit.update({ where: { id: c.id }, data: { summary } });
      done++;
    });
  }
  return done;
}

/** Flow parent: runs after every summarize batch has finished (or failed). */
export async function finalizeIngest(repoId: string, prisma: PrismaClient): Promise<void> {
  const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId } });
  const counts = await repoCounts(prisma, repoId);
  const prev = (repo.stats as RepoStats | null) ?? {};
  const warnings = prev.warnings ?? [];
  const summarized = counts.summarizedFiles + counts.summarizedCommits;
  if (prev.summarizeTotal && summarized < prev.summarizeTotal) {
    warnings.push(`${prev.summarizeTotal - summarized} files/commits could not be summarized.`);
  }
  const stats: RepoStats = { ...prev, warnings, counts };
  await prisma.repo.update({
    where: { id: repoId },
    data: {
      status: "ready",
      stage: "done",
      stats: stats as Prisma.InputJsonValue,
      statusMessage: warnings.length ? warnings.join(" ") : null,
    },
  });
}

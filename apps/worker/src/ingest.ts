import { join } from "node:path";
import type { Prisma, PrismaClient } from "@archaeo/db";
import {
  cloneOrUpdate,
  commitChunkText,
  computeChurn,
  createOctokit,
  embedPendingChunks,
  fetchIssues,
  fetchMergedPullRequests,
  indexCode,
  linkPullRequests,
  listTrackedFiles,
  prChunkText,
  readGitLog,
  scanSourceFiles,
  type CommitInfo,
  type SourceFile,
} from "@archaeo/ingest";
import type { Models } from "@archaeo/models";
import type { IngestStage, RepoStats, SummarizeJobData } from "@archaeo/shared";
import type { IngestConfig } from "./config";

export interface IngestDeps {
  prisma: PrismaClient;
  models: Pick<Models, "embed">;
  config: IngestConfig;
  log: (msg: string) => void;
}

export interface IngestResult {
  summarizeJobs: SummarizeJobData[];
}

/**
 * Bump when parsing or chunking changes: the next ingest rebuilds symbols, chunks and embeddings for
 * every file (summaries are kept for files whose content is unchanged).
 */
export const INDEX_VERSION = 2;

/** Commits stored per commit row are capped so a giant vendoring commit doesn't bloat the JSON column. */
const MAX_FILES_PER_COMMIT = 300;

/**
 * The ingest pipeline: clone → parse → history → embed → summarize (the summarize stage only plans
 * jobs; the caller enqueues them). Every stage is idempotent, so a re-run only does new work.
 */
export async function runIngest(repoId: string, deps: IngestDeps): Promise<IngestResult> {
  const { prisma, config, log } = deps;
  const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId } });
  // Cached answers were built from the previous index, which this run may change even at the same HEAD.
  await prisma.resultCache.deleteMany({ where: { repoId } });
  const warnings: string[] = [];
  const durationsMs: Partial<Record<IngestStage, number>> = {};

  const stage = async <T>(name: IngestStage, message: string, fn: () => Promise<T>): Promise<T> => {
    await prisma.repo.update({ where: { id: repoId }, data: { status: "ingesting", stage: name, statusMessage: message } });
    log(`[${repo.owner}/${repo.name}] ${message}`);
    const started = Date.now();
    const result = await fn();
    durationsMs[name] = Date.now() - started;
    return result;
  };

  const dir = join(config.workspaceDir, repo.owner, repo.name);
  const clone = await stage("clone", `Cloning ${repo.owner}/${repo.name}`, () => cloneOrUpdate(repo.url, dir));

  const sources = await stage("parse", "Parsing source files", async () => {
    const files = await scanSourceFiles(dir, await listTrackedFiles(dir), { maxLoc: config.maxLoc });
    const stale = ((repo.stats as RepoStats | null)?.indexVersion ?? 1) < INDEX_VERSION;
    await indexCode(deps, repoId, files, stale);
    return files;
  });

  const language = dominantLanguage(sources);
  await prisma.repo.update({ where: { id: repoId }, data: { defaultBranch: clone.defaultBranch, headSha: clone.headSha, language } });

  await stage("history", "Reading commit history and GitHub PRs and issues", async () => {
    const commits = await readGitLog(dir, config.maxCommits);
    await writeCommits(deps, repoId, commits);
    await writeChurn(prisma, repoId, commits);
    const warning = await syncGitHub(deps, repoId, repo.owner, repo.name, repo.githubSyncedAt);
    if (warning) warnings.push(warning);
    await relinkPullRequests(deps, repoId, commits);
  });

  await stage("embed", "Embedding code, commits and PRs", () => embedPendingChunks({ ...deps, batchSize: config.embedBatchSize }, repoId));

  const summarizeJobs = await stage("summarize", "Summarizing files and commits", () => planSummaries(deps, repoId));

  const stats: RepoStats = {
    ...((repo.stats as RepoStats | null) ?? {}),
    warnings,
    durationsMs,
    summarizeTotal: await summarizeTotal(prisma, repoId, config.summarizeMaxCommits),
    indexVersion: INDEX_VERSION,
  };
  await prisma.repo.update({ where: { id: repoId }, data: { stats: stats as Prisma.InputJsonValue } });
  return { summarizeJobs };
}

function dominantLanguage(files: SourceFile[]): string | null {
  const byLang = new Map<string, number>();
  for (const f of files) byLang.set(f.language, (byLang.get(f.language) ?? 0) + f.loc);
  return [...byLang].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---------------------------------------------------------------- history

async function writeCommits({ prisma, log }: IngestDeps, repoId: string, commits: CommitInfo[]): Promise<void> {
  const known = new Set((await prisma.commit.findMany({ where: { repoId }, select: { sha: true } })).map((c) => c.sha));
  const fresh = commits.filter((c) => !known.has(c.sha));
  log(`  ${commits.length} commits in history, ${fresh.length} new`);

  for (let i = 0; i < fresh.length; i += 1000) {
    const batch = fresh.slice(i, i + 1000);
    const rows = await prisma.commit.createManyAndReturn({
      data: batch.map((c) => ({
        repoId,
        sha: c.sha,
        author: c.author,
        date: c.date,
        message: c.message,
        filesChanged: c.files.slice(0, MAX_FILES_PER_COMMIT) as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
      select: { id: true, sha: true },
    });
    const bySha = new Map(batch.map((c) => [c.sha, c]));
    await prisma.chunk.createMany({
      data: rows.map((r) => ({ repoId, sourceType: "commit" as const, sourceId: r.id, text: commitChunkText(bySha.get(r.sha)!) })),
    });
  }
}

async function writeChurn(prisma: PrismaClient, repoId: string, commits: CommitInfo[]): Promise<void> {
  const churn = computeChurn(commits);
  const paths = [...churn.keys()];
  const counts = paths.map((p) => churn.get(p)!);
  await prisma.$executeRaw`
    UPDATE "File" AS f SET churn = COALESCE(v.c, 0)
    FROM "File" AS f2 LEFT JOIN unnest(${paths}::text[], ${counts}::int[]) AS v(p, c) ON v.p = f2.path
    WHERE f.id = f2.id AND f."repoId" = ${repoId}`;
}

/** Fetches PRs and issues updated since the last sync. Returns a warning instead of throwing (e.g. rate limits). */
async function syncGitHub(
  { prisma, config, log }: IngestDeps,
  repoId: string,
  owner: string,
  name: string,
  since: Date | null,
): Promise<string | null> {
  const startedAt = new Date();
  const octokit = createOctokit(config.githubToken);
  try {
    // One-time backfill: PRs stored before mergeCommitSha existed need a full refetch.
    const missingMergeSha = await prisma.pullRequest.count({ where: { repoId, mergedAt: { not: null }, mergeCommitSha: null } });
    const prSince = missingMergeSha > 0 ? null : since;
    const prs = await fetchMergedPullRequests(octokit, owner, name, { since: prSince, max: config.maxPullRequests });
    const issues = await fetchIssues(octokit, owner, name, { since, max: config.maxIssues });
    log(`  GitHub: ${prs.length} merged PRs and ${issues.length} issues updated${since ? ` since ${since.toISOString()}` : ""}`);

    const existingPrs = new Map(
      (await prisma.pullRequest.findMany({ where: { repoId }, select: { id: true, number: true, title: true, body: true } })).map((p) => [p.number, p]),
    );
    for (const pr of prs) {
      const data = { title: pr.title, body: pr.body, mergedAt: pr.mergedAt, mergeCommitSha: pr.mergeCommitSha };
      const existing = existingPrs.get(pr.number);
      const row = existing
        ? await prisma.pullRequest.update({ where: { id: existing.id }, data })
        : await prisma.pullRequest.create({ data: { repoId, number: pr.number, ...data } });
      // Only re-chunk (and so re-embed) when the text changed.
      if (existing && existing.title === pr.title && existing.body === pr.body) continue;
      await prisma.chunk.deleteMany({ where: { repoId, sourceType: "pr", sourceId: row.id } });
      await prisma.chunk.create({ data: { repoId, sourceType: "pr", sourceId: row.id, text: prChunkText(pr) } });
    }

    for (const issue of issues) {
      const data = { title: issue.title, body: issue.body, state: issue.state, labels: issue.labels };
      await prisma.issue.upsert({
        where: { repoId_number: { repoId, number: issue.number } },
        create: { repoId, number: issue.number, ...data },
        update: data,
      });
    }
    await prisma.repo.update({ where: { id: repoId }, data: { githubSyncedAt: startedAt } });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = config.githubToken ? "" : " Set GITHUB_TOKEN to raise the GitHub API rate limit.";
    log(`  GitHub sync failed: ${message}`);
    return `GitHub PRs and issues were not fully fetched: ${message}.${hint}`;
  }
}

/** Recomputes PR → commit links for every stored PR (cheap, in memory) and writes only the ones that changed. */
async function relinkPullRequests({ prisma, log }: IngestDeps, repoId: string, commits: CommitInfo[]): Promise<void> {
  const prs = await prisma.pullRequest.findMany({ where: { repoId }, select: { id: true, number: true, mergeCommitSha: true, linkedCommitShas: true } });
  const links = linkPullRequests(prs, commits);
  let changed = 0;
  for (const pr of prs) {
    const next = links.get(pr.number) ?? [];
    if (next.length === pr.linkedCommitShas.length && next.every((s) => pr.linkedCommitShas.includes(s))) continue;
    await prisma.pullRequest.update({ where: { id: pr.id }, data: { linkedCommitShas: next } });
    changed++;
  }
  log(`  linked ${links.size} PRs to commits (${changed} updated)`);
}

// ---------------------------------------------------------------- embed + summarize

async function recentCommitIds(prisma: PrismaClient, repoId: string, max: number) {
  return prisma.commit.findMany({ where: { repoId }, orderBy: { date: "desc" }, take: max, select: { id: true, summary: true } });
}

async function summarizeTotal(prisma: PrismaClient, repoId: string, maxCommits: number): Promise<number> {
  const [files, commits] = await Promise.all([prisma.file.count({ where: { repoId } }), prisma.commit.count({ where: { repoId } })]);
  return files + Math.min(commits, maxCommits);
}

/** Plans summarize batches for files and recent commits that don't have a summary yet. */
async function planSummaries({ prisma, config }: IngestDeps, repoId: string): Promise<SummarizeJobData[]> {
  const files = await prisma.file.findMany({ where: { repoId, summary: null }, select: { id: true }, orderBy: { path: "asc" } });
  const commits = (await recentCommitIds(prisma, repoId, config.summarizeMaxCommits)).filter((c) => c.summary === null);

  const jobs: SummarizeJobData[] = [];
  const size = config.summarizeBatchSize;
  for (let i = 0; i < files.length; i += size) jobs.push({ repoId, kind: "file", ids: files.slice(i, i + size).map((f) => f.id) });
  for (let i = 0; i < commits.length; i += size) jobs.push({ repoId, kind: "commit", ids: commits.slice(i, i + size).map((c) => c.id) });
  return jobs;
}

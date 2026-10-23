import { join } from "node:path";
import { chunksMissingEmbedding, setChunkEmbeddings, type Prisma, type PrismaClient } from "@archaeo/db";
import {
  buildCallEdges,
  buildImportEdges,
  cloneOrUpdate,
  codeChunks,
  commitChunkText,
  computeChurn,
  createOctokit,
  createParser,
  fetchIssues,
  fetchMergedPullRequests,
  ImportResolver,
  linkPullRequests,
  listTrackedFiles,
  prChunkText,
  readGitLog,
  scanSourceFiles,
  symbolKey,
  type CommitInfo,
  type ParsedFile,
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

/** Commits stored per commit row are capped so a giant vendoring commit doesn't bloat the JSON column. */
const MAX_FILES_PER_COMMIT = 300;

/**
 * The ingest pipeline: clone → parse → history → embed → summarize (the summarize stage only plans
 * jobs; the caller enqueues them). Every stage is idempotent, so a re-run only does new work.
 */
export async function runIngest(repoId: string, deps: IngestDeps): Promise<IngestResult> {
  const { prisma, config, log } = deps;
  const repo = await prisma.repo.findUniqueOrThrow({ where: { id: repoId } });
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
    await writeCode(deps, repoId, files);
    return files;
  });

  const language = dominantLanguage(sources);
  await prisma.repo.update({ where: { id: repoId }, data: { defaultBranch: clone.defaultBranch, headSha: clone.headSha, language } });

  await stage("history", "Reading commit history and GitHub PRs and issues", async () => {
    const commits = await readGitLog(dir, config.maxCommits);
    await writeCommits(deps, repoId, commits);
    await writeChurn(prisma, repoId, commits);
    const warning = await syncGitHub(deps, repoId, repo.owner, repo.name, repo.githubSyncedAt, commits);
    if (warning) warnings.push(warning);
  });

  await stage("embed", "Embedding code, commits and PRs", () => embedPending(deps, repoId));

  const summarizeJobs = await stage("summarize", "Summarizing files and commits", () => planSummaries(deps, repoId));

  const stats: RepoStats = {
    ...((repo.stats as RepoStats | null) ?? {}),
    warnings,
    durationsMs,
    summarizeTotal: await summarizeTotal(prisma, repoId, config.summarizeMaxCommits),
  };
  await prisma.repo.update({ where: { id: repoId }, data: { stats: stats as Prisma.InputJsonValue } });
  return { summarizeJobs };
}

function dominantLanguage(files: SourceFile[]): string | null {
  const byLang = new Map<string, number>();
  for (const f of files) byLang.set(f.language, (byLang.get(f.language) ?? 0) + f.loc);
  return [...byLang].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---------------------------------------------------------------- parse

async function writeCode({ prisma, log }: IngestDeps, repoId: string, sources: SourceFile[]): Promise<void> {
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

  const changed = sources.filter((s) => existingByPath.get(s.path)?.hash !== s.hash);
  log(`  ${sources.length} source files, ${changed.length} new or changed, ${stale.length} removed`);

  for (const src of changed) {
    const p = parsedByPath.get(src.path);
    if (!p) continue;
    await prisma.$transaction(async (tx) => {
      const file = await tx.file.upsert({
        where: { repoId_path: { repoId, path: src.path } },
        create: { repoId, path: src.path, language: src.language, hash: src.hash, loc: src.loc, complexity: p.complexity },
        update: { language: src.language, hash: src.hash, loc: src.loc, complexity: p.complexity, summary: null },
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
  commits: CommitInfo[],
): Promise<string | null> {
  const startedAt = new Date();
  const octokit = createOctokit(config.githubToken);
  try {
    const prs = await fetchMergedPullRequests(octokit, owner, name, { since, max: config.maxPullRequests });
    const issues = await fetchIssues(octokit, owner, name, { since, max: config.maxIssues });
    log(`  GitHub: ${prs.length} merged PRs and ${issues.length} issues updated${since ? ` since ${since.toISOString()}` : ""}`);

    const links = linkPullRequests(prs, commits);
    const existingPrs = new Map(
      (await prisma.pullRequest.findMany({ where: { repoId }, select: { id: true, number: true } })).map((p) => [p.number, p.id]),
    );
    for (const pr of prs) {
      const data = { title: pr.title, body: pr.body, mergedAt: pr.mergedAt, linkedCommitShas: links.get(pr.number) ?? [] };
      const existingId = existingPrs.get(pr.number);
      const row = existingId
        ? await prisma.pullRequest.update({ where: { id: existingId }, data })
        : await prisma.pullRequest.create({ data: { repoId, number: pr.number, ...data } });
      await prisma.chunk.deleteMany({ where: { repoId, sourceType: "pr", sourceId: row.id } });
      await prisma.chunk.create({ data: { repoId, sourceType: "pr", sourceId: row.id, text: prChunkText(pr) } });
    }

    // Older PRs referenced by commits we only just saw (not refetched this run)
    const fetched = new Set(prs.map((p) => p.number));
    for (const [number, shas] of links) {
      if (fetched.has(number) || !existingPrs.has(number)) continue;
      await prisma.pullRequest.update({ where: { id: existingPrs.get(number)! }, data: { linkedCommitShas: shas } });
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

// ---------------------------------------------------------------- embed + summarize

async function embedPending({ prisma, models, config, log }: IngestDeps, repoId: string): Promise<void> {
  let total = 0;
  for (;;) {
    const rows = await chunksMissingEmbedding(prisma, repoId, config.embedBatchSize);
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

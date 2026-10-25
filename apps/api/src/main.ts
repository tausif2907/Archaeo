import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma, repoCounts } from "@archaeo/db";
import { GitHubForkPublisher, loadAgentLimits } from "@archaeo/agent";
import { createOctokit } from "@archaeo/ingest";
import { configureModels, loadModelConfig } from "@archaeo/models";
import { QUEUES, type ErasJobData, type FixJobData, type IngestJobData } from "@archaeo/shared";
import { buildApp } from "./app";
import { createResultCache, modelCacheKey } from "./cache";
import { createHistoryService } from "./history";
import { createFutureService } from "./future";
import { createPresentService } from "./present";

const models = configureModels({ recorder: new PrismaCallRecorder() });
const cache = createResultCache(prisma, modelCacheKey(loadModelConfig()));

const redis = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestJobData>(QUEUES.ingest, { connection: redis });
const erasQueue = new Queue<ErasJobData>(QUEUES.eras, { connection: redis });
const fixQueue = new Queue<FixJobData>(QUEUES.fix, { connection: redis });
const limits = loadAgentLimits();
const githubToken = process.env.GITHUB_TOKEN || undefined;
const publishTarget = process.env.PR_TARGET === "upstream" ? "upstream" : "fork";
const publicDemo = process.env.PUBLIC_DEMO === "true";
// Without a token there is no publisher, and approval reports that publishing isn't configured. A public demo never publishes.
const publisher = githubToken && !publicDemo
  ? new GitHubForkPublisher({ token: githubToken, target: publishTarget, authorName: process.env.PR_AUTHOR_NAME || undefined, authorEmail: process.env.PR_AUTHOR_EMAIL || undefined })
  : null;
const jobOpts = { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 } as const;

const app = await buildApp({
  webOrigin: process.env.WEB_ORIGIN,
  publicDemo,
  repos: {
    findByUrl: (url) => prisma.repo.findUnique({ where: { url } }),
    findById: (id) => prisma.repo.findUnique({ where: { id } }),
    create: (data) => prisma.repo.create({ data }),
    // Eval snapshots (a repo indexed at a historical commit, url ending "#eval@<sha>") are temporary.
    list: () => prisma.repo.findMany({ where: { NOT: { url: { contains: "#eval@" } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    markQueued: (id) => prisma.repo.update({ where: { id }, data: { status: "queued", stage: null, statusMessage: null } }),
    counts: (id) => repoCounts(prisma, id),
  },
  history: createHistoryService(prisma, models, async (repoId) => {
    await erasQueue.add("eras", { repoId, force: true }, jobOpts);
  }, cache),
  present: createPresentService(prisma, models, limits, cache),
  future: createFutureService(prisma, models, {
    limits,
    enqueueFix: async (runId) => {
      await fixQueue.add("fix", { runId }, { attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
    },
    publisher,
    publishTarget,
    sandboxProvider: process.env.SANDBOX_PROVIDER || "docker",
    octokit: createOctokit(githubToken),
    cache,
  }),
  enqueueIngest: async (repoId) => {
    await ingestQueue.add("ingest", { repoId }, jobOpts);
  },
  healthChecks: {
    db: () => prisma.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
  },
});

const port = Number(process.env.API_PORT) || 4000;
await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await Promise.all([ingestQueue.close(), erasQueue.close(), fixQueue.close()]);
    redis.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

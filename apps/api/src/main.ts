import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma, repoCounts } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { QUEUES, type ErasJobData, type IngestJobData } from "@archaeo/shared";
import { buildApp } from "./app";
import { createHistoryService } from "./history";
import { createPresentService } from "./present";
import { loadAgentLimits } from "@archaeo/agent";

const models = configureModels({ recorder: new PrismaCallRecorder() });

const redis = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestJobData>(QUEUES.ingest, { connection: redis });
const erasQueue = new Queue<ErasJobData>(QUEUES.eras, { connection: redis });
const jobOpts = { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 } as const;

const app = await buildApp({
  webOrigin: process.env.WEB_ORIGIN,
  repos: {
    findByUrl: (url) => prisma.repo.findUnique({ where: { url } }),
    findById: (id) => prisma.repo.findUnique({ where: { id } }),
    create: (data) => prisma.repo.create({ data }),
    list: () => prisma.repo.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    markQueued: (id) => prisma.repo.update({ where: { id }, data: { status: "queued", stage: null, statusMessage: null } }),
    counts: (id) => repoCounts(prisma, id),
  },
  history: createHistoryService(prisma, models, async (repoId) => {
    await erasQueue.add("eras", { repoId, force: true }, jobOpts);
  }),
  present: createPresentService(prisma, models, loadAgentLimits()),
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
    await Promise.all([ingestQueue.close(), erasQueue.close()]);
    redis.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma, repoCounts } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { QUEUES, type IngestJobData } from "@archaeo/shared";
import { buildApp } from "./app";

configureModels({ recorder: new PrismaCallRecorder() });

const redis = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestJobData>(QUEUES.ingest, { connection: redis });

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
  enqueueIngest: async (repoId) => {
    await ingestQueue.add("ingest", { repoId }, { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 });
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
    await ingestQueue.close();
    redis.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

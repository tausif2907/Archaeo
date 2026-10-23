import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { QUEUES, type IngestJobData } from "@archaeo/shared";

configureModels({ recorder: new PrismaCallRecorder() });

const connection = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });

const ingestWorker = new Worker<IngestJobData>(
  QUEUES.ingest,
  async (job) => {
    const { repoId } = job.data;
    await prisma.repo.update({ where: { id: repoId }, data: { status: "ingesting", statusMessage: "Starting ingest" } });
    // Phase 1 replaces this with the real pipeline: clone, parse, history, embed, summarize.
    await prisma.repo.update({
      where: { id: repoId },
      data: { status: "queued", statusMessage: "Ingest pipeline not implemented yet (Phase 1)" },
    });
  },
  { connection, concurrency: 2 },
);

ingestWorker.on("ready", () => console.log(`[worker] listening on queue "${QUEUES.ingest}"`));
ingestWorker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await ingestWorker.close();
    connection.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

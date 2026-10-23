import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { FlowProducer, UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma } from "@archaeo/db";
import { RepoTooLargeError } from "@archaeo/ingest";
import { configureModels } from "@archaeo/models";
import { QUEUES, type IngestJobData, type SummarizeJobData } from "@archaeo/shared";
import { loadIngestConfig } from "./config";
import { runIngest } from "./ingest";
import { finalizeIngest, summarizeBatch } from "./summarize";

const models = configureModels({ recorder: new PrismaCallRecorder() });
const config = loadIngestConfig();
const connection = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const flows = new FlowProducer({ connection });
const log = (msg: string) => console.log(`[worker] ${msg}`);

async function handleIngest(job: Job<IngestJobData>): Promise<void> {
  const { repoId } = job.data;
  if (job.name === "finalize") {
    await finalizeIngest(repoId, prisma);
    log(`repo ${repoId} ready`);
    return;
  }

  try {
    const { summarizeJobs } = await runIngest(repoId, { prisma, models, config, log });
    // Summaries run as child jobs; the "finalize" parent marks the repo ready once all of them finish.
    await flows.add({
      name: "finalize",
      queueName: QUEUES.ingest,
      data: { repoId },
      children: summarizeJobs.map((data) => ({
        name: "summarize",
        queueName: QUEUES.summarize,
        data,
        opts: { attempts: 3, backoff: { type: "exponential", delay: 2000 }, ignoreDependencyOnFailure: true, removeOnComplete: { age: 3600 } },
      })),
    });
    log(`queued ${summarizeJobs.length} summarize batches for repo ${repoId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = err instanceof RepoTooLargeError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.repo.update({
      where: { id: repoId },
      data: final ? { status: "failed", statusMessage: message } : { statusMessage: `Retrying after error: ${message}` },
    });
    if (err instanceof RepoTooLargeError) throw new UnrecoverableError(message);
    throw err;
  }
}

const ingestWorker = new Worker<IngestJobData>(QUEUES.ingest, handleIngest, { connection, concurrency: 2, lockDuration: 120_000 });
const summarizeWorker = new Worker<SummarizeJobData>(QUEUES.summarize, (job) => summarizeBatch(job.data, { prisma, models, config }), {
  connection,
  concurrency: 4,
});

ingestWorker.on("ready", () => log(`listening on queues "${QUEUES.ingest}" and "${QUEUES.summarize}"`));
for (const w of [ingestWorker, summarizeWorker]) {
  w.on("failed", (job, err) => console.error(`[worker] ${w.name} job ${job?.id} failed:`, err.message));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await Promise.all([ingestWorker.close(), summarizeWorker.close(), flows.close()]);
    connection.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

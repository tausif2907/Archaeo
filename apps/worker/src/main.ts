import "@archaeo/shared/load-env";
import { requireEnv } from "@archaeo/shared/env";
import { FlowProducer, Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { PrismaCallRecorder, prisma } from "@archaeo/db";
import { RepoTooLargeError } from "@archaeo/ingest";
import { configureModels } from "@archaeo/models";
import { createSandboxProvider } from "@archaeo/sandbox";
import { QUEUES, type ErasJobData, type FixJobData, type IngestJobData, type SummarizeJobData } from "@archaeo/shared";
import { loadIngestConfig } from "./config";
import { runEras } from "./eras";
import { runFix } from "./fix";
import { runIngest } from "./ingest";
import { finalizeIngest, summarizeBatch } from "./summarize";

const models = configureModels({ recorder: new PrismaCallRecorder() });
const config = loadIngestConfig();
const connection = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const flows = new FlowProducer({ connection });
const erasQueue = new Queue<ErasJobData>(QUEUES.eras, { connection });
const log = (msg: string) => console.log(`[worker] ${msg}`);

async function handleIngest(job: Job<IngestJobData>): Promise<void> {
  const { repoId } = job.data;
  if (job.name === "finalize") {
    await finalizeIngest(repoId, prisma, models);
    log(`repo ${repoId} ready`);
    await prisma.repo.update({ where: { id: repoId }, data: { erasStatus: "pending", erasMessage: null } });
    await erasQueue.add("eras", { repoId }, { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 });
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

async function handleEras(job: Job<ErasJobData>): Promise<void> {
  try {
    await runEras(job.data.repoId, { prisma, models, config, log }, job.data.force);
  } catch (err) {
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (final) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.repo.update({ where: { id: job.data.repoId }, data: { erasStatus: "failed", erasMessage: message } });
    }
    throw err;
  }
}

const erasWorker = new Worker<ErasJobData>(QUEUES.eras, handleEras, { connection, concurrency: 1, lockDuration: 300_000 });

const sandbox = createSandboxProvider();
const fixMaxAttempts = Number(process.env.FIX_MAX_ATTEMPTS) || 3;

async function handleFix(job: Job<FixJobData>): Promise<void> {
  try {
    await runFix(job.data.runId, { prisma, models, config, sandbox, log, maxAttempts: fixMaxAttempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = await prisma.agentRun.findUnique({ where: { id: job.data.runId } });
    await prisma.agentRun.update({
      where: { id: job.data.runId },
      data: { status: "failed", output: { ...((run?.output as object | null) ?? {}), phase: "Failed", error: message } },
    });
    throw err;
  }
}

// One fix at a time: each runs a container test suite several times.
const fixWorker = new Worker<FixJobData>(QUEUES.fix, handleFix, { connection, concurrency: 1, lockDuration: 120_000 });

ingestWorker.on("ready", () => log(`listening on queues "${QUEUES.ingest}", "${QUEUES.summarize}", "${QUEUES.eras}" and "${QUEUES.fix}" (sandbox: ${sandbox.name})`));
for (const w of [ingestWorker, summarizeWorker, erasWorker, fixWorker]) {
  w.on("failed", (job, err) => console.error(`[worker] ${w.name} job ${job?.id} failed:`, err.message));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await Promise.all([ingestWorker.close(), summarizeWorker.close(), erasWorker.close(), fixWorker.close(), flows.close(), erasQueue.close()]);
    connection.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}

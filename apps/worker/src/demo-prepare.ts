import "@archaeo/shared/load-env";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@archaeo/db";
import { parseGitHubUrl, QUEUES, type IngestJobData } from "@archaeo/shared";
import { findRepoRoot, requireEnv } from "@archaeo/shared/env";

/**
 * `pnpm demo:prepare`: gets a deployment demo-ready. Ingests every repo in demo/demo.json straight through the
 * database and job queue (a public demo refuses to add repos over HTTP), waits for the timeline, then sends each
 * warm-up request through the API once so the demo answers come from the result cache.
 */
interface WarmItem {
  repo: string;
  kind: "ask" | "why" | "flow" | "trace";
  input: Record<string, unknown>;
}

const POLL_MS = 5000;
const config = JSON.parse(await readFile(join(findRepoRoot(), "demo", "demo.json"), "utf8")) as { repos: string[]; warm: WarmItem[] };
const apiUrl = process.env.API_URL || `http://localhost:${process.env.API_PORT || 4000}`;
const redis = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestJobData>(QUEUES.ingest, { connection: redis });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;

const ids = new Map<string, string>();
for (const url of config.repos) {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new Error(`Not a GitHub repository URL: ${url}`);
  let repo = await prisma.repo.findUnique({ where: { url: ref.url } });
  if (!repo) {
    repo = await prisma.repo.create({ data: { url: ref.url, owner: ref.owner, name: ref.name } });
    await ingestQueue.add("ingest", { repoId: repo.id }, { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 });
    console.log(`${ref.owner}/${ref.name}: queued for ingest`);
  }
  ids.set(ref.url, repo.id);

  // The worker marks the repo ready, then generates the timeline; wait for both.
  let last = "";
  for (;;) {
    repo = await prisma.repo.findUniqueOrThrow({ where: { id: repo.id } });
    const line = repo.status === "ready" ? `timeline ${repo.erasStatus ?? "not started"}` : `${repo.status}${repo.statusMessage ? `: ${repo.statusMessage}` : ""}`;
    if (line !== last) console.log(`${ref.owner}/${ref.name}: ${line}`);
    last = line;
    if (repo.status === "failed") throw new Error(`${ref.owner}/${ref.name} failed to ingest: ${repo.statusMessage}`);
    if (repo.status === "ready" && (repo.erasStatus === "ready" || repo.erasStatus === "failed")) break;
    await sleep(POLL_MS);
  }
}

for (const item of config.warm) {
  const ref = parseGitHubUrl(item.repo);
  const id = ref && ids.get(ref.url);
  if (!id) throw new Error(`Warm-up repo ${item.repo} is not in demo.json "repos"`);
  const started = Date.now();
  const res = await fetch(`${apiUrl}/repos/${id}/${item.kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item.input) });
  const text = await res.text();
  // Streamed kinds end with a done event; an error event means nothing was cached.
  const error = !res.ok ? text.slice(0, 200) : /^event: error$/m.test(text) ? /^data: (.*)$/m.exec(text.split("event: error")[1] ?? "")?.[1] : null;
  const fallback = /"fallback":true/.test(text);
  if (error) failed = true;
  console.log(`${item.kind} ${JSON.stringify(item.input)}: ${error ? `FAILED ${error}` : fallback ? "answered with a fallback (not cached; check the model keys)" : "cached"} (${Date.now() - started} ms)`);
}

await ingestQueue.close();
redis.disconnect();
await prisma.$disconnect();
process.exit(failed ? 1 : 0);

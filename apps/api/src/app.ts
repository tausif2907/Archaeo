import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { WhyError } from "@archaeo/agent";
import type { Repo } from "@archaeo/db";
import {
  CreateRepoInput,
  parseGitHubUrl,
  WhyInput,
  type ErasResponse,
  type FileEntry,
  type RepoCounts,
  type RepoDto,
  type RepoProgressDto,
  type SymbolEntry,
  type WhyResult,
} from "@archaeo/shared";
import { buildStages } from "./progress";

/** Narrow persistence + queue surface the routes need, so tests can swap in fakes. */
export interface RepoStore {
  findByUrl(url: string): Promise<Repo | null>;
  findById(id: string): Promise<Repo | null>;
  create(data: { url: string; owner: string; name: string }): Promise<Repo>;
  list(): Promise<Repo[]>;
  markQueued(id: string): Promise<Repo>;
  counts(id: string): Promise<RepoCounts>;
}

/** "The Past": eras and why-does-this-exist. */
export interface HistoryService {
  eras(repoId: string): Promise<ErasResponse>;
  /** Queue era detection + narratives with `force` (rewrite even unchanged eras) */
  regenerateEras(repoId: string): Promise<void>;
  files(repoId: string): Promise<FileEntry[]>;
  symbols(repoId: string, path: string): Promise<SymbolEntry[]>;
  /** Throws WhyError for bad targets */
  why(repo: Repo, input: WhyInput): Promise<WhyResult>;
}

export interface AppDeps {
  repos: RepoStore;
  history: HistoryService;
  enqueueIngest(repoId: string): Promise<void>;
  healthChecks?: Record<string, () => Promise<unknown>>;
  webOrigin?: string;
}

export function toRepoDto(repo: Repo): RepoDto {
  return {
    id: repo.id,
    url: repo.url,
    owner: repo.owner,
    name: repo.name,
    status: repo.status,
    stage: repo.stage,
    statusMessage: repo.statusMessage,
    defaultBranch: repo.defaultBranch,
    language: repo.language,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && !process.env.VITEST });
  await app.register(cors, { origin: deps.webOrigin ?? true });

  app.get("/health", async (_req, reply) => {
    const results: Record<string, "ok" | string> = {};
    for (const [name, check] of Object.entries(deps.healthChecks ?? {})) {
      try {
        await check();
        results[name] = "ok";
      } catch (err) {
        results[name] = err instanceof Error ? err.message : String(err);
      }
    }
    const healthy = Object.values(results).every((r) => r === "ok");
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", checks: results });
  });

  app.post("/repos", async (req, reply) => {
    const parsed = CreateRepoInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const ref = parseGitHubUrl(parsed.data.url)!;
    const existing = await deps.repos.findByUrl(ref.url);
    if (existing) return reply.code(200).send(toRepoDto(existing));

    const repo = await deps.repos.create({ url: ref.url, owner: ref.owner, name: ref.name });
    await deps.enqueueIngest(repo.id);
    return reply.code(201).send(toRepoDto(repo));
  });

  app.get("/repos", async () => (await deps.repos.list()).map(toRepoDto));

  app.get<{ Params: { id: string } }>("/repos/:id", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    return toRepoDto(repo);
  });

  app.get<{ Params: { id: string } }>("/repos/:id/progress", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    const counts = await deps.repos.counts(repo.id);
    const body: RepoProgressDto = { repo: toRepoDto(repo), stages: buildStages(repo, counts), counts };
    return body;
  });

  /** Re-run ingest. Safe to repeat: unchanged files, known commits and existing embeddings are skipped. */
  app.post<{ Params: { id: string } }>("/repos/:id/ingest", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    if (repo.status === "ingesting" || repo.status === "queued") {
      return reply.code(409).send({ error: "Ingest already in progress" });
    }
    const queued = await deps.repos.markQueued(repo.id);
    await deps.enqueueIngest(repo.id);
    return reply.code(202).send(toRepoDto(queued));
  });

  // ------------------------------------------------------------ The Past

  app.get<{ Params: { id: string } }>("/repos/:id/eras", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    return deps.history.eras(repo.id);
  });

  app.post<{ Params: { id: string } }>("/repos/:id/eras", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    if (repo.status !== "ready") return reply.code(409).send({ error: "Repo is not ingested yet" });
    if (repo.erasStatus === "pending" || repo.erasStatus === "running") return reply.code(409).send({ error: "Eras are already being generated" });
    await deps.history.regenerateEras(repo.id);
    return reply.code(202).send({ status: "pending" });
  });

  app.get<{ Params: { id: string } }>("/repos/:id/files", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    return deps.history.files(repo.id);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/repos/:id/symbols", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    if (!req.query.path) return reply.code(400).send({ error: "path is required" });
    return deps.history.symbols(repo.id, req.query.path);
  });

  app.post<{ Params: { id: string } }>("/repos/:id/why", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    if (repo.status !== "ready") return reply.code(409).send({ error: "Repo is not ingested yet" });
    const input = WhyInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Invalid input" });
    try {
      return await deps.history.why(repo, input.data);
    } catch (err) {
      if (err instanceof WhyError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  return app;
}

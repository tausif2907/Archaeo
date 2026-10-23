import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Repo } from "@archaeo/db";
import { CreateRepoInput, parseGitHubUrl, type RepoDto } from "@archaeo/shared";

/** Narrow persistence + queue surface the routes need, so tests can swap in fakes. */
export interface RepoStore {
  findByUrl(url: string): Promise<Repo | null>;
  findById(id: string): Promise<Repo | null>;
  create(data: { url: string; owner: string; name: string }): Promise<Repo>;
  list(): Promise<Repo[]>;
}

export interface AppDeps {
  repos: RepoStore;
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
    statusMessage: repo.statusMessage,
    defaultBranch: repo.defaultBranch,
    language: repo.language,
    createdAt: repo.createdAt.toISOString(),
    updatedAt: repo.updatedAt.toISOString(),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
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

  return app;
}

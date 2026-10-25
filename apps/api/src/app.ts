import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ApprovalError, FlowError, WhyError } from "@archaeo/agent";
import type { Repo } from "@archaeo/db";
import {
  AskInput,
  CreateRepoInput,
  FlowInput,
  parseGitHubUrl,
  TraceInput,
  WhyInput,
  type AgentEvent,
  type AppConfigDto,
  type BugReport,
  type FixRunDto,
  type TraceEvent,
  type TraceRunDto,
  type AskResult,
  type CodeFile,
  type FlowTrace,
  type MapData,
  type SymbolHit,
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

/** "The Present": architecture map, code viewer, Q&A agent, request-flow walkthrough. */
export interface PresentService {
  map(repoId: string): Promise<MapData>;
  file(repo: Repo, path: string): Promise<CodeFile | null>;
  searchSymbols(repoId: string, q: string): Promise<SymbolHit[]>;
  ask(repo: Repo, question: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<AskResult>;
  /** Throws FlowError for unknown entry points */
  flow(repo: Repo, input: FlowInput): Promise<FlowTrace>;
}

export class FutureError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

/** "The Future": bug tracing, sandboxed fix runs, approval-gated PRs. */
export interface FutureService {
  config(): AppConfigDto;
  trace(repo: Repo, input: TraceInput, onEvent: (e: TraceEvent) => void, signal: AbortSignal): Promise<{ runId: string; report: BugReport }>;
  cases(repoId: string): Promise<TraceRunDto[]>;
  run(repoId: string, runId: string): Promise<TraceRunDto | FixRunDto | null>;
  /** Queues sandboxed fix attempts for a finished trace. Never publishes. */
  startFix(repo: Repo, traceRunId: string): Promise<FixRunDto>;
  /** The only publishing path: explicit approval of the offered passing patch. */
  approve(repo: Repo, attemptId: string): Promise<{ prUrl: string; branch: string }>;
}

export interface AppDeps {
  repos: RepoStore;
  history: HistoryService;
  present: PresentService;
  future: FutureService;
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

  // ------------------------------------------------------------ The Present

  /** Loads a repo that must be ingested; sends the error reply itself and returns null otherwise. */
  const readyRepo = async (id: string, reply: FastifyReply): Promise<Repo | null> => {
    const repo = await deps.repos.findById(id);
    if (!repo) {
      reply.code(404).send({ error: "Repo not found" });
      return null;
    }
    if (repo.status !== "ready") {
      reply.code(409).send({ error: "Repo is not ingested yet" });
      return null;
    }
    return repo;
  };

  app.get<{ Params: { id: string } }>("/repos/:id/map", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    return repo ? deps.present.map(repo.id) : reply;
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/repos/:id/file", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    if (!req.query.path) return reply.code(400).send({ error: "path is required" });
    const file = await deps.present.file(repo, req.query.path);
    return file ?? reply.code(404).send({ error: `File not found: ${req.query.path}` });
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/repos/:id/symbols/search", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    const q = req.query.q?.trim() ?? "";
    return q.length < 2 ? [] : deps.present.searchSymbols(repo.id, q);
  });

  app.post<{ Params: { id: string } }>("/repos/:id/flow", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    const input = FlowInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Invalid input" });
    try {
      return await deps.present.flow(repo, input.data);
    } catch (err) {
      if (err instanceof FlowError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  /** Q&A agent, streamed as Server-Sent Events (run, thinking, tool_call, tool_result, limit, answer, error, done). */
  app.post<{ Params: { id: string } }>("/repos/:id/ask", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    const input = AskInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Invalid input" });

    await streamEvents(req, reply, deps.webOrigin, (send, signal) => deps.present.ask(repo, input.data.question, send, signal));
  });

  // ------------------------------------------------------------ The Future

  app.get("/config", async () => deps.future.config());

  /** Bug tracer, streamed as Server-Sent Events (run, tool activity, limit, report, error, done). */
  app.post<{ Params: { id: string } }>("/repos/:id/trace", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    const input = TraceInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Invalid input" });
    await streamEvents(req, reply, deps.webOrigin, (send, signal) => deps.future.trace(repo, input.data, send, signal));
  });

  app.get<{ Params: { id: string } }>("/repos/:id/cases", async (req, reply) => {
    const repo = await deps.repos.findById(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Repo not found" });
    return deps.future.cases(repo.id);
  });

  app.get<{ Params: { id: string; runId: string } }>("/repos/:id/runs/:runId", async (req, reply) => {
    const run = await deps.future.run(req.params.id, req.params.runId);
    return run ?? reply.code(404).send({ error: "Run not found" });
  });

  app.post<{ Params: { id: string; runId: string } }>("/repos/:id/runs/:runId/fix", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    try {
      return reply.code(202).send(await deps.future.startFix(repo, req.params.runId));
    } catch (err) {
      if (err instanceof FutureError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  /** Explicit human approval: the only route that pushes code or opens a pull request. */
  app.post<{ Params: { id: string; attemptId: string } }>("/repos/:id/fix-attempts/:attemptId/approve", async (req, reply) => {
    const repo = await readyRepo(req.params.id, reply);
    if (!repo) return reply;
    try {
      return await deps.future.approve(repo, req.params.attemptId);
    } catch (err) {
      if (err instanceof ApprovalError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  return app;
}

/** Streams events as SSE until `run` settles; aborts `run` when the client disconnects. */
async function streamEvents<E extends { type: string }>(
  req: FastifyRequest,
  reply: FastifyReply,
  webOrigin: string | undefined,
  run: (send: (e: E) => void, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": webOrigin ?? req.headers.origin ?? "*",
    vary: "Origin",
  });
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  };
  try {
    await run((e) => send(e.type, e), abort.signal);
  } catch (err) {
    send("error", { type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    send("done", {});
    reply.raw.end();
  }
}

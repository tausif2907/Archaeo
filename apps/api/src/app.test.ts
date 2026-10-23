import { describe, expect, it } from "vitest";
import type { Repo } from "@archaeo/db";
import type { RepoCounts } from "@archaeo/shared";
import { buildApp, type RepoStore } from "./app";
import { buildStages } from "./progress";

const ZERO: RepoCounts = {
  files: 0,
  loc: 0,
  symbols: 0,
  importEdges: 0,
  callEdges: 0,
  commits: 0,
  pullRequests: 0,
  issues: 0,
  chunks: 0,
  embedded: 0,
  summarizedFiles: 0,
  summarizedCommits: 0,
};

function memoryStore(): RepoStore & { rows: Repo[] } {
  const rows: Repo[] = [];
  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  return {
    rows,
    findByUrl: async (url) => rows.find((r) => r.url === url) ?? null,
    findById: async (id) => find(id),
    list: async () => rows,
    counts: async () => ({ ...ZERO, files: 3 }),
    markQueued: async (id) => Object.assign(find(id)!, { status: "queued", stage: null, statusMessage: null }),
    create: async (data) => {
      const now = new Date();
      const repo: Repo = {
        id: `repo${rows.length + 1}`,
        ...data,
        defaultBranch: null,
        language: null,
        status: "queued",
        stage: null,
        statusMessage: null,
        headSha: null,
        githubSyncedAt: null,
        stats: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(repo);
      return repo;
    },
  };
}

describe("api", () => {
  it("creates a repo once and enqueues ingest", async () => {
    const repos = memoryStore();
    const enqueued: string[] = [];
    const app = await buildApp({ repos, enqueueIngest: async (id) => void enqueued.push(id) });

    const first = await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/pallets/click.git" } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ owner: "pallets", name: "click", status: "queued", url: "https://github.com/pallets/click" });

    const again = await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/pallets/click" } });
    expect(again.statusCode).toBe(200);
    expect(repos.rows).toHaveLength(1);
    expect(enqueued).toEqual(["repo1"]);

    const got = await app.inject({ method: "GET", url: "/repos/repo1" });
    expect(got.json().name).toBe("click");
    expect((await app.inject({ method: "GET", url: "/repos/nope" })).statusCode).toBe(404);
  });

  it("rejects non-GitHub URLs", async () => {
    const app = await buildApp({ repos: memoryStore(), enqueueIngest: async () => {} });
    const res = await app.inject({ method: "POST", url: "/repos", payload: { url: "https://example.com/x" } });
    expect(res.statusCode).toBe(400);
  });

  it("re-ingests only when no ingest is in flight", async () => {
    const repos = memoryStore();
    const enqueued: string[] = [];
    const app = await buildApp({ repos, enqueueIngest: async (id) => void enqueued.push(id) });
    await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/a/b" } });

    expect((await app.inject({ method: "POST", url: "/repos/repo1/ingest" })).statusCode).toBe(409);
    repos.rows[0]!.status = "ready";
    const res = await app.inject({ method: "POST", url: "/repos/repo1/ingest" });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("queued");
    expect(enqueued).toEqual(["repo1", "repo1"]);
  });

  it("returns stage progress with counts", async () => {
    const repos = memoryStore();
    const app = await buildApp({ repos, enqueueIngest: async () => {} });
    await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/a/b" } });
    Object.assign(repos.rows[0]!, { status: "ingesting", stage: "history" });

    const res = await app.inject({ method: "GET", url: "/repos/repo1/progress" });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.files).toBe(3);
    expect(res.json().stages.map((s: { state: string }) => s.state)).toEqual(["done", "done", "active", "pending", "pending"]);
  });

  it("reports degraded health when a check fails", async () => {
    const app = await buildApp({
      repos: memoryStore(),
      enqueueIngest: async () => {},
      healthChecks: { db: async () => 1, redis: async () => Promise.reject(new Error("down")) },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", checks: { db: "ok", redis: "down" } });
  });
});

describe("buildStages", () => {
  const counts = { ...ZERO, files: 10, commits: 50, chunks: 100, embedded: 40, summarizedFiles: 5, summarizedCommits: 5 };

  it("marks everything done when ready", () => {
    const stages = buildStages({ status: "ready", stage: "done", stats: { summarizeTotal: 60 } }, counts);
    expect(stages.every((s) => s.state === "done")).toBe(true);
    expect(stages.find((s) => s.name === "summarize")).toEqual({ name: "summarize", state: "done", done: 10, total: 60 });
  });

  it("flags the failed stage and leaves later stages pending", () => {
    const stages = buildStages({ status: "failed", stage: "embed", stats: null }, counts);
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "pending"]);
    expect(stages.find((s) => s.name === "embed")).toMatchObject({ done: 40, total: 100 });
  });

  it("is all pending before the worker picks the job up", () => {
    expect(buildStages({ status: "queued", stage: null, stats: null }, ZERO).every((s) => s.state === "pending")).toBe(true);
  });
});

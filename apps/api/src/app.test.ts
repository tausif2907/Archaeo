import { describe, expect, it } from "vitest";
import type { Repo } from "@archaeo/db";
import { buildApp, type RepoStore } from "./app";

function memoryStore(): RepoStore & { rows: Repo[] } {
  const rows: Repo[] = [];
  return {
    rows,
    findByUrl: async (url) => rows.find((r) => r.url === url) ?? null,
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    list: async () => rows,
    create: async (data) => {
      const now = new Date();
      const repo: Repo = {
        id: `repo${rows.length + 1}`,
        ...data,
        defaultBranch: null,
        language: null,
        status: "queued",
        statusMessage: null,
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

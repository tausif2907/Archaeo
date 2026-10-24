import { describe, expect, it } from "vitest";
import type { Repo } from "@archaeo/db";
import type { RepoCounts } from "@archaeo/shared";
import { FlowError, WhyError } from "@archaeo/agent";
import { buildApp, type HistoryService, type PresentService, type RepoStore } from "./app";
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
        erasStatus: null,
        erasMessage: null,
        stats: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(repo);
      return repo;
    },
  };
}

function fakeHistory(): HistoryService & { regenerated: string[] } {
  const regenerated: string[] = [];
  return {
    regenerated,
    eras: async () => ({ status: "ready", message: null, eras: [] }),
    regenerateEras: async (id) => void regenerated.push(id),
    files: async () => [{ path: "src/a.py", language: "python", loc: 3 }],
    symbols: async () => [],
    why: async (_repo, input) => {
      if (input.path === "missing.py") throw new WhyError("File not found: missing.py", 404);
      return { answer: `because [abc1234]`, target: { path: input.path } } as never;
    },
  };
}

function fakePresent(): PresentService {
  return {
    map: async () => ({ overview: "A CLI library.", modules: [], files: [], edges: [] }),
    file: async (_repo, path) => (path === "src/a.py" ? { path, language: "python", lines: ["x = 1"], totalLines: 1, truncated: false } : null),
    searchSymbols: async () => [],
    flow: async (_repo, input) => {
      if (input.symbol === "nope") throw new FlowError("Entry point nope not found");
      return { entry: input.symbol, entryPath: "src/a.py", hops: [], fallback: true, truncated: false };
    },
    ask: async (_repo, question, onEvent) => {
      onEvent({ type: "run", runId: "run1" });
      onEvent({ type: "tool_call", id: "c1", name: "search_code", args: { query: question } });
      onEvent({ type: "tool_result", id: "c1", name: "search_code", summary: "1 result", refs: [] });
      const result = { status: "succeeded" as const, answer: "In [src/a.py:1]", refs: [{ path: "src/a.py", startLine: 1, endLine: 1 }], fallback: false, invalidCitations: [], limitReason: null, toolCalls: [], costUsd: 0, steps: 2 };
      onEvent({ type: "answer", result });
      return result;
    },
  };
}

describe("api", () => {
  it("creates a repo once and enqueues ingest", async () => {
    const repos = memoryStore();
    const enqueued: string[] = [];
    const app = await buildApp({ history: fakeHistory(), present: fakePresent(), repos, enqueueIngest: async (id) => void enqueued.push(id) });

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
    const app = await buildApp({ history: fakeHistory(), present: fakePresent(), repos: memoryStore(), enqueueIngest: async () => {} });
    const res = await app.inject({ method: "POST", url: "/repos", payload: { url: "https://example.com/x" } });
    expect(res.statusCode).toBe(400);
  });

  it("re-ingests only when no ingest is in flight", async () => {
    const repos = memoryStore();
    const enqueued: string[] = [];
    const app = await buildApp({ history: fakeHistory(), present: fakePresent(), repos, enqueueIngest: async (id) => void enqueued.push(id) });
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
    const app = await buildApp({ history: fakeHistory(), present: fakePresent(), repos, enqueueIngest: async () => {} });
    await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/a/b" } });
    Object.assign(repos.rows[0]!, { status: "ingesting", stage: "history" });

    const res = await app.inject({ method: "GET", url: "/repos/repo1/progress" });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.files).toBe(3);
    expect(res.json().stages.map((s: { state: string }) => s.state)).toEqual(["done", "done", "active", "pending", "pending"]);
  });

  it("reports degraded health when a check fails", async () => {
    const app = await buildApp({
      history: fakeHistory(), present: fakePresent(),
      repos: memoryStore(),
      enqueueIngest: async () => {},
      healthChecks: { db: async () => 1, redis: async () => Promise.reject(new Error("down")) },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", checks: { db: "ok", redis: "down" } });
  });
});

describe("the past", () => {
  async function readyApp() {
    const repos = memoryStore();
    const history = fakeHistory();
    const app = await buildApp({ history, present: fakePresent(), repos, enqueueIngest: async () => {} });
    await app.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/a/b" } });
    return { app, repos, history };
  }

  it("only answers why-questions once the repo is ingested, and validates input", async () => {
    const { app, repos } = await readyApp();
    const ask = (payload: object) => app.inject({ method: "POST", url: "/repos/repo1/why", payload });
    expect((await ask({ path: "src/a.py" })).statusCode).toBe(409);
    repos.rows[0]!.status = "ready";
    expect((await ask({ path: "" })).statusCode).toBe(400);
    expect((await ask({ path: "src/a.py", startLine: 3 })).json().error).toBe("startLine and endLine go together");
    const missing = await ask({ path: "missing.py" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("File not found: missing.py");
    const ok = await ask({ path: "src/a.py", symbol: "main" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().answer).toBe("because [abc1234]");
  });

  it("regenerates eras unless a run is already pending", async () => {
    const { app, repos, history } = await readyApp();
    repos.rows[0]!.status = "ready";
    expect((await app.inject({ method: "POST", url: "/repos/repo1/eras" })).statusCode).toBe(202);
    expect(history.regenerated).toEqual(["repo1"]);
    repos.rows[0]!.erasStatus = "running";
    expect((await app.inject({ method: "POST", url: "/repos/repo1/eras" })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/repos/repo1/eras" })).json()).toEqual({ status: "ready", message: null, eras: [] });
    expect((await app.inject({ method: "GET", url: "/repos/repo1/symbols" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/repos/repo1/files" })).json()).toHaveLength(1);
  });
});

describe("the present", () => {
  async function app(ready = true) {
    const repos = memoryStore();
    const a = await buildApp({ history: fakeHistory(), present: fakePresent(), repos, enqueueIngest: async () => {} });
    await a.inject({ method: "POST", url: "/repos", payload: { url: "https://github.com/a/b" } });
    if (ready) repos.rows[0]!.status = "ready";
    return a;
  }

  it("streams agent events over SSE and ends with done", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/repos/repo1/ask", payload: { question: "Where is x defined?" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body
      .trim()
      .split("\n\n")
      .map((block) => block.split("\n")[0]!.replace("event: ", ""));
    expect(events).toEqual(["run", "tool_call", "tool_result", "answer", "done"]);
    expect(res.body).toContain('"answer":"In [src/a.py:1]"');
  });

  it("guards the agent and map behind a ready repo and validates input", async () => {
    const notReady = await app(false);
    expect((await notReady.inject({ method: "POST", url: "/repos/repo1/ask", payload: { question: "Where is x?" } })).statusCode).toBe(409);
    expect((await notReady.inject({ method: "GET", url: "/repos/repo1/map" })).statusCode).toBe(409);
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/repos/repo1/ask", payload: { question: "x" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/repos/repo1/map" })).json().overview).toBe("A CLI library.");
  });

  it("serves files and flow traces with clear errors", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/repos/repo1/file?path=src/a.py" })).json().lines).toEqual(["x = 1"]);
    expect((await a.inject({ method: "GET", url: "/repos/repo1/file?path=missing.py" })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/repos/repo1/file" })).statusCode).toBe(400);
    const missing = await a.inject({ method: "POST", url: "/repos/repo1/flow", payload: { symbol: "nope" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Entry point nope not found");
    expect((await a.inject({ method: "POST", url: "/repos/repo1/flow", payload: { symbol: "main" } })).json().entry).toBe("main");
    expect((await a.inject({ method: "GET", url: "/repos/repo1/symbols/search?q=m" })).json()).toEqual([]);
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

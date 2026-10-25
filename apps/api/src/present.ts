import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { answerQuestion, safeRepoPath, traceFlow, type AgentLimits } from "@archaeo/agent";
import type { Prisma, PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { AgentEvent, AskResult, FlowTrace } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import type { PresentService } from "./app";
import type { ResultCache } from "./cache";

const MAX_VIEW_LINES = 5000;

/** Prisma + git backed PresentService. Flow traces and answers are cached per repo HEAD and model. */
export function createPresentService(prisma: PrismaClient, models: Pick<Models, "reason" | "embed">, limits: AgentLimits, cache: ResultCache): PresentService {
  return {
    async map(repoId) {
      const [modules, files, edges] = await Promise.all([
        prisma.module.findMany({ where: { repoId }, select: { path: true, parentPath: true, summary: true }, orderBy: { path: "asc" } }),
        prisma.file.findMany({ where: { repoId }, select: { path: true, language: true, loc: true, churn: true, complexity: true, summary: true }, orderBy: { path: "asc" } }),
        prisma.edge.findMany({ where: { repoId, kind: "import" }, select: { fromFile: { select: { path: true } }, toFile: { select: { path: true } } } }),
      ]);
      return {
        overview: modules.find((m) => m.path === "")?.summary ?? null,
        modules,
        files: files.map((f) => ({ ...f, folder: posix.dirname(f.path) === "." ? "" : posix.dirname(f.path) })),
        edges: edges.flatMap((e) => (e.fromFile && e.toFile ? [{ from: e.fromFile.path, to: e.toFile.path }] : [])),
      };
    },

    async file(repo, path) {
      const full = safeRepoPath(repoCloneDir(repo.owner, repo.name), path);
      const text = full ? await readFile(full, "utf8").catch(() => null) : null;
      if (text === null) return null;
      const lines = text.split("\n");
      const known = await prisma.file.findUnique({ where: { repoId_path: { repoId: repo.id, path } }, select: { language: true } });
      return { path, language: known?.language ?? null, lines: lines.slice(0, MAX_VIEW_LINES), totalLines: lines.length, truncated: lines.length > MAX_VIEW_LINES };
    },

    async searchSymbols(repoId, q) {
      const rows = await prisma.symbol.findMany({
        where: { file: { repoId }, qualifiedName: { contains: q, mode: "insensitive" } },
        select: { qualifiedName: true, kind: true, startLine: true, endLine: true, file: { select: { path: true } } },
        take: 100,
      });
      // One entry per definition name and file: the largest (typing @overload stubs repeat a name).
      const unique = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const key = `${r.file.path}:${r.qualifiedName}`;
        const prev = unique.get(key);
        if (!prev || r.endLine - r.startLine > prev.endLine - prev.startLine) unique.set(key, r);
      }
      const lower = q.toLowerCase();
      return [...unique.values()]
        .map((r) => ({ qualifiedName: r.qualifiedName, kind: r.kind, path: r.file.path, startLine: r.startLine }))
        .sort(
          (a, b) =>
            Number(b.qualifiedName.toLowerCase() === lower) - Number(a.qualifiedName.toLowerCase() === lower) ||
            Number(/(^|\/)(tests?|examples?)\//.test(a.path)) - Number(/(^|\/)(tests?|examples?)\//.test(b.path)) ||
            a.qualifiedName.length - b.qualifiedName.length,
        )
        .slice(0, 20);
    },

    async ask(repo, question, onEvent, signal) {
      // A repeat question replays the original run: same run id, tool steps and answer, without model calls.
      const cached = await cache.get<{ runId: string; events: AgentEvent[]; result: AskResult }>(repo, "ask", { question });
      if (cached) {
        onEvent({ type: "run", runId: cached.runId });
        for (const e of cached.events) onEvent(e);
        return cached.result;
      }

      const run = await prisma.agentRun.create({ data: { repoId: repo.id, kind: "chat", input: { question } } });
      onEvent({ type: "run", runId: run.id });
      const events: AgentEvent[] = [];
      const record = (e: AgentEvent) => {
        events.push(e);
        onEvent(e);
      };
      try {
        const result = await answerQuestion(
          { prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name), repoName: `${repo.owner}/${repo.name}` },
          question,
          { limits, onEvent: record, runId: run.id, signal },
        );
        await prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: result.status,
            toolCalls: result.toolCalls as unknown as Prisma.InputJsonValue,
            output: { answer: result.answer, refs: result.refs, fallback: result.fallback, invalidCitations: result.invalidCitations } as unknown as Prisma.InputJsonValue,
            costEstimate: result.costUsd,
          },
        });
        if (result.status === "succeeded" && !result.fallback) await cache.set(repo, "ask", { question }, { runId: run.id, events, result });
        return result;
      } catch (err) {
        await prisma.agentRun.update({ where: { id: run.id }, data: { status: "failed", output: { error: err instanceof Error ? err.message : String(err) } } });
        throw err;
      }
    },

    async flow(repo, input) {
      const hit = await cache.get<FlowTrace>(repo, "flow", input);
      if (hit) return hit;
      const trace = await traceFlow({ prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name) }, input);
      if (!trace.fallback) await cache.set(repo, "flow", input, trace);
      return trace;
    },
  };
}

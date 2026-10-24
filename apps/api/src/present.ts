import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { answerQuestion, safeRepoPath, traceFlow, type AgentLimits } from "@archaeo/agent";
import type { Prisma, PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { FlowTrace } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import type { PresentService } from "./app";

const MAX_VIEW_LINES = 5000;
const FLOW_CACHE_SIZE = 100;

/** Prisma + git backed PresentService. */
export function createPresentService(prisma: PrismaClient, models: Pick<Models, "reason" | "embed">, limits: AgentLimits): PresentService {
  const flowCache = new Map<string, FlowTrace>();

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
      const run = await prisma.agentRun.create({ data: { repoId: repo.id, kind: "chat", input: { question } } });
      onEvent({ type: "run", runId: run.id });
      try {
        const result = await answerQuestion(
          { prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name), repoName: `${repo.owner}/${repo.name}` },
          question,
          { limits, onEvent, runId: run.id, signal },
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
        return result;
      } catch (err) {
        await prisma.agentRun.update({ where: { id: run.id }, data: { status: "failed", output: { error: err instanceof Error ? err.message : String(err) } } });
        throw err;
      }
    },

    async flow(repo, input) {
      const key = `${repo.id}:${repo.headSha}:${input.symbol}:${input.path ?? ""}`;
      const hit = flowCache.get(key);
      if (hit) return hit;
      const trace = await traceFlow({ prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name) }, input);
      flowCache.set(key, trace);
      if (flowCache.size > FLOW_CACHE_SIZE) flowCache.delete(flowCache.keys().next().value!);
      return trace;
    },
  };
}

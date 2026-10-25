import type { Octokit } from "@octokit/rest";
import { approveFixAttempt, traceBug, type AgentLimits, type Publisher } from "@archaeo/agent";
import type { AgentRun, FixAttempt, Prisma, PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { AppConfigDto, BugReport, FixAttemptDto, FixRunDto, TestRunSummary, TraceInput, TraceRunDto } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import { FutureError, type FutureService } from "./app";

const OUTPUT_TAIL = 4000;

interface FixOutput {
  phase?: string;
  baseSha?: string;
  baseline?: TestRunSummary | null;
  offeredAttemptId?: string | null;
  error?: string | null;
}

function attemptDto(a: FixAttempt): FixAttemptDto {
  return {
    id: a.id,
    attempt: a.attempt,
    patch: a.patch,
    applied: a.applied,
    applyError: a.applyError,
    passed: a.passed,
    testSummary: a.testSummary,
    testOutputTail: a.testOutput ? a.testOutput.slice(-OUTPUT_TAIL) : null,
    newFailures: a.newFailures,
    regressionTest: a.regressionTest,
    reproduced: a.reproduced,
    durationMs: a.durationMs,
    approvedAt: a.approvedAt?.toISOString() ?? null,
    branch: a.branch,
    prUrl: a.prUrl,
  };
}

function fixDto(run: AgentRun, attempts: FixAttempt[]): FixRunDto {
  const out = (run.output as FixOutput | null) ?? {};
  return {
    id: run.id,
    traceRunId: run.parentRunId,
    status: run.status,
    phase: out.phase ?? null,
    baseSha: out.baseSha ?? null,
    baseline: out.baseline ?? null,
    attempts: attempts.sort((a, b) => a.attempt - b.attempt).map(attemptDto),
    offeredAttemptId: out.offeredAttemptId ?? null,
    error: out.error ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

function traceDto(run: AgentRun, fixRunId: string | null): TraceRunDto {
  const out = (run.output as { report?: BugReport; error?: string } | null) ?? {};
  return { id: run.id, status: run.status, input: run.input as TraceInput, report: out.report ?? null, error: out.error ?? null, createdAt: run.createdAt.toISOString(), fixRunId };
}

export interface FutureOptions {
  limits: AgentLimits;
  enqueueFix: (runId: string) => Promise<void>;
  publisher: Publisher | null;
  publishTarget: "fork" | "upstream";
  sandboxProvider: string;
  octokit?: Octokit;
}

/** Prisma-backed FutureService: bug tracing, fix runs, and approval-gated publishing. */
export function createFutureService(prisma: PrismaClient, models: Pick<Models, "reason" | "embed">, opts: FutureOptions): FutureService {
  const latestFix = async (traceRunId: string) =>
    (await prisma.agentRun.findFirst({ where: { parentRunId: traceRunId, kind: "fix" }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;

  return {
    config(): AppConfigDto {
      return { publishing: { enabled: !!opts.publisher, target: opts.publishTarget }, sandbox: { provider: opts.sandboxProvider } };
    },

    async trace(repo, input, onEvent, signal) {
      const run = await prisma.agentRun.create({ data: { repoId: repo.id, kind: "trace", input: input as Prisma.InputJsonValue } });
      onEvent({ type: "run", runId: run.id });
      try {
        const report = await traceBug(
          { prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name), repoName: `${repo.owner}/${repo.name}`, octokit: opts.octokit },
          input,
          { limits: opts.limits, onEvent, runId: run.id, signal },
        );
        await prisma.agentRun.update({
          where: { id: run.id },
          data: { status: "succeeded", output: { report } as unknown as Prisma.InputJsonValue, toolCalls: report.toolCalls as unknown as Prisma.InputJsonValue, costEstimate: report.costUsd },
        });
        return { runId: run.id, report };
      } catch (err) {
        await prisma.agentRun.update({ where: { id: run.id }, data: { status: "failed", output: { error: err instanceof Error ? err.message : String(err) } } });
        throw err;
      }
    },

    async cases(repoId) {
      const runs = await prisma.agentRun.findMany({ where: { repoId, kind: "trace" }, orderBy: { createdAt: "desc" }, take: 20 });
      return Promise.all(runs.map(async (r) => traceDto(r, await latestFix(r.id))));
    },

    async run(repoId, runId) {
      const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { fixAttempts: true } });
      if (!run || run.repoId !== repoId || (run.kind !== "trace" && run.kind !== "fix")) return null;
      return run.kind === "fix" ? fixDto(run, run.fixAttempts) : traceDto(run, await latestFix(run.id));
    },

    async startFix(repo, traceRunId) {
      const trace = await prisma.agentRun.findUnique({ where: { id: traceRunId } });
      if (!trace || trace.repoId !== repo.id || trace.kind !== "trace") throw new FutureError("Bug trace not found", 404);
      if (trace.status !== "succeeded") throw new FutureError("The bug trace did not finish", 409);
      const running = await prisma.agentRun.findFirst({ where: { parentRunId: traceRunId, kind: "fix", status: "running" } });
      if (running) throw new FutureError("A fix is already running for this bug", 409);
      const run = await prisma.agentRun.create({
        data: { repoId: repo.id, kind: "fix", parentRunId: traceRunId, input: { traceRunId }, output: { phase: "Queued", baseSha: repo.headSha } },
      });
      await opts.enqueueFix(run.id);
      return fixDto(run, []);
    },

    approve(repo, attemptId) {
      return approveFixAttempt({ prisma, publisher: opts.publisher, repoDir: repoCloneDir(repo.owner, repo.name) }, repo, attemptId);
    },
  };
}

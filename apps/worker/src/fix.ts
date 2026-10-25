import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runFixLoop, safeRepoPath, type FixEnvironment } from "@archaeo/agent";
import type { Prisma, PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import { detectSandboxConfig, type SandboxProvider } from "@archaeo/sandbox";
import type { BugReport, SandboxConfig } from "@archaeo/shared";
import type { IngestConfig } from "./config";

export interface FixDeps {
  prisma: PrismaClient;
  models: Pick<Models, "writeCode">;
  config: IngestConfig;
  sandbox: SandboxProvider;
  log: (msg: string) => void;
  maxAttempts: number;
}

/**
 * Fix job: sandbox at the repo's ingested commit → baseline tests → up to N patch attempts. Stores every
 * attempt. Never publishes; a passing attempt is only marked as offered for human approval.
 */
export async function runFix(fixRunId: string, deps: FixDeps): Promise<void> {
  const { prisma, log } = deps;
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixRunId }, include: { repo: true } });
  const repo = run.repo;
  const trace = run.parentRunId ? await prisma.agentRun.findUnique({ where: { id: run.parentRunId } }) : null;
  const report = (trace?.output as { report?: BugReport } | null)?.report;
  if (!report) throw new Error("The trace report for this fix run is missing");
  if (!repo.headSha) throw new Error("Repo has no ingested commit");

  let output: Record<string, unknown> = { phase: "Starting", baseSha: repo.headSha, baseline: null, offeredAttemptId: null, error: null };
  const save = async (patch: Record<string, unknown>) => {
    output = { ...output, ...patch };
    await prisma.agentRun.update({ where: { id: fixRunId }, data: { output: output as Prisma.InputJsonValue } });
  };
  const setPhase = (phase: string) => {
    log(`[fix ${fixRunId}] ${phase}`);
    void save({ phase });
  };

  const repoDir = join(deps.config.workspaceDir, repo.owner, repo.name);
  setPhase("Detecting how to run the tests");
  const detected = await detectSandboxConfig(repoDir, repo.headSha, Number(process.env.SANDBOX_TIMEOUT_SECONDS) || 600);
  if (!detected) throw new Error("Could not work out how to run this repo's tests (no pyproject/setup or package.json)");
  const config: SandboxConfig = { ...detected.config, ...((repo.sandboxConfig as Partial<SandboxConfig> | null) ?? {}) };

  const session = await deps.sandbox.prepare({ repoDir, sha: repo.headSha, repoName: `${repo.owner}/${repo.name}`, config, files: detected.files }, setPhase);
  try {
    const env: FixEnvironment = {
      runTests: (files) => session.runTests(files),
      applyPatch: (diff) => session.applyPatch(diff),
      reset: () => session.reset(),
      async readFile(path) {
        const full = safeRepoPath(session.dir, path);
        return full ? await readFile(full, "utf8").catch(() => null) : null;
      },
      async exists(path) {
        const full = safeRepoPath(session.dir, path);
        return full ? (await stat(full).catch(() => null))?.isFile() === true : false;
      },
    };
    const result = await runFixLoop({
      models: deps.models,
      env,
      report,
      repoName: `${repo.owner}/${repo.name}`,
      maxAttempts: deps.maxAttempts,
      runId: fixRunId,
      onPhase: setPhase,
      onAttempt: async (a) => {
        await prisma.fixAttempt.create({
          data: {
            runId: fixRunId,
            attempt: a.attempt,
            baseSha: repo.headSha,
            patch: a.patch,
            applied: a.applied,
            applyError: a.applyError,
            testOutput: a.test?.outputTail ?? null,
            testSummary: a.test ? `${a.verdict} — ${a.test.summary}` : a.verdict,
            newFailures: a.newFailures,
            passed: a.passed,
            regressionTest: a.regressionTest,
            reproduced: a.reproduced,
            durationMs: a.durationMs,
          },
        });
      },
    });
    const offered = result.offered ? await prisma.fixAttempt.findFirst({ where: { runId: fixRunId, attempt: result.offered.attempt } }) : null;
    const { outputTail: _tail, ...baseline } = result.baseline;
    await save({ phase: offered ? "Passing patch ready for review" : "Finished without a passing patch", baseline, offeredAttemptId: offered?.id ?? null, error: result.error });
    await prisma.agentRun.update({ where: { id: fixRunId }, data: { status: offered ? "succeeded" : "failed" } });
  } finally {
    await session.dispose();
  }
}

import type { PrismaClient, Repo } from "@archaeo/db";
import type { BugReport, TestRunSummary } from "@archaeo/shared";
import { buildPrContent, type Publisher } from "./publish";

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

/** Why an attempt can't be approved, or null when it can. Only the offered, passing, unpublished attempt qualifies. */
export function approvalProblem(attempt: { id: string; passed: boolean; prUrl: string | null }, offeredAttemptId: string | null): string | null {
  if (!attempt.passed) return "Only a patch that passed the tests can be approved";
  if (offeredAttemptId !== attempt.id) return "This attempt was not offered for approval";
  if (attempt.prUrl) return "This patch was already published";
  return null;
}

interface FixRunOutput {
  offeredAttemptId?: string | null;
  baseline?: TestRunSummary | null;
}

/**
 * The only path that publishes anything: an explicit approval of an offered patch. Records the
 * approval, then pushes the patch to a fork and opens a PR through `publisher`.
 */
export async function approveFixAttempt(deps: { prisma: PrismaClient; publisher: Publisher | null; repoDir: string }, repo: Repo, attemptId: string): Promise<{ prUrl: string; branch: string }> {
  const { prisma } = deps;
  const attempt = await prisma.fixAttempt.findUnique({ where: { id: attemptId }, include: { run: true } });
  if (!attempt || attempt.run.repoId !== repo.id || attempt.run.kind !== "fix") throw new ApprovalError("Fix attempt not found", 404);
  const output = (attempt.run.output as FixRunOutput | null) ?? {};
  const problem = approvalProblem(attempt, output.offeredAttemptId ?? null);
  if (problem) throw new ApprovalError(problem, 409);
  if (!deps.publisher) throw new ApprovalError("Publishing is not configured: set GITHUB_TOKEN (with permission to fork and open pull requests)", 409);
  if (!attempt.baseSha) throw new ApprovalError("Attempt has no base commit", 409);

  const trace = attempt.run.parentRunId ? await prisma.agentRun.findUnique({ where: { id: attempt.run.parentRunId } }) : null;
  const report = (trace?.output as { report?: BugReport } | null)?.report;
  if (!report) throw new ApprovalError("The bug report for this fix is missing", 409);

  const content = buildPrContent({ report, attempt, baseline: output.baseline ?? null, baseSha: attempt.baseSha });
  await prisma.fixAttempt.update({ where: { id: attempt.id }, data: { approvedAt: new Date() } });
  try {
    const result = await deps.publisher.publish({
      repo: { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch ?? "main" },
      repoDir: deps.repoDir,
      baseSha: attempt.baseSha,
      patch: attempt.patch,
      content,
    });
    await prisma.fixAttempt.update({ where: { id: attempt.id }, data: { prUrl: result.prUrl, branch: result.branch } });
    return result;
  } catch (err) {
    // Publishing failed: clear the approval so it can be retried.
    await prisma.fixAttempt.update({ where: { id: attempt.id }, data: { approvedAt: null } });
    throw err;
  }
}

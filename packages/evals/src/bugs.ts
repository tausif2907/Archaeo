import { approvalProblem, approveFixAttempt, loadAgentLimits, runFixLoop, traceBug, type Publisher, type PublishInput } from "@archaeo/agent";
import { prisma, type Prisma } from "@archaeo/db";
import { configureModels, createModels, loadModelConfig, MockProvider, type Models } from "@archaeo/models";
import { createSandboxProvider, detectSandboxConfig, exec } from "@archaeo/sandbox";
import type { BugReport } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import { flag, loadDataset, sandboxEnv } from "./common";
import { requireReadyRepo } from "./repo";
import { withSnapshot } from "./snapshot";
import type { Bug } from "./suites";

const replay = process.argv.includes("--replay");
/** `pnpm eval:bugs [--repo click] [--replay]`: --replay checks the fix pipeline with the real fix; `pnpm eval` measures. */
const dataset = await loadDataset<{ bugs: Bug[] }>(flag("repo", "click")!, "bugs");
if (!dataset) throw new Error("No bug dataset for that repo");
const repo = await requireReadyRepo(dataset.repo);
const repoDir = repoCloneDir(repo.owner, repo.name);
const repoName = `${repo.owner}/${repo.name}`;
const models = configureModels();
const sandbox = createSandboxProvider();

/** Stands in for GitHub in the eval: records what would be published, publishes nothing. */
class RecordingPublisher implements Publisher {
  calls: PublishInput[] = [];
  async publish(input: PublishInput) {
    this.calls.push(input);
    return { prUrl: `dry-run://${input.repo.owner}/${input.repo.name}/pull/${input.content.branch}`, branch: input.content.branch };
  }
}

let top1 = 0;
let top3 = 0;
let fixed = 0;
let failed = false;
for (const bug of dataset.bugs) {
  console.log(`\n== ${bug.id}: ${bug.title}`);

  // 1. Trace from the symptom-only report, against an index of the pre-fix commit.
  const report: BugReport = await withSnapshot({ prisma, models }, repo, repoDir, bug.preFixSha, (snap) =>
    traceBug({ prisma, models, repoId: snap.repoId, repoDir: snap.dir, repoName }, { text: bug.report }, { limits: loadAgentLimits() }),
  );
  const files = report.suspects.map((s) => s.path);
  const rank = files.findIndex((f) => bug.fixFiles.includes(f));
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 3) top3++;
  console.log(`trace: real fix file ${rank >= 0 ? `ranked #${rank + 1}` : "not in suspects"}; top suspects: ${report.suspects.slice(0, 3).map((s) => `${s.symbol ?? s.path} (${s.path})`).join(", ")}${report.fallback ? " [fallback report]" : ""}`);

  // 2. Fix at the pre-fix commit in the sandbox.
  const detected = (await detectSandboxConfig(repoDir, bug.preFixSha))!;
  const session = await sandbox.prepare({ repoDir, sha: bug.preFixSha, repoName, ...detected }, (p) => console.log(`  ${p}`));
  const env = sandboxEnv(session);

  let fixModels: Pick<Models, "writeCode"> = models;
  if (replay) {
    // Pipeline check: a wrong patch first, then the real historical fix (source + its regression tests).
    const realFix = (await exec("git", ["-C", repoDir, "diff", bug.preFixSha, bug.fixSha, "--", "src", "tests"])).output;
    const script = [bug.replayWrongPatch, realFix].filter((d): d is string => !!d).map((d) => ({ content: `\`\`\`diff\n${d}\`\`\``, toolCalls: [], finishReason: "stop" as const }));
    fixModels = createModels({ config: loadModelConfig({}), providers: { mock: new MockProvider({ script }) } });
  }
  const result = await (async () => {
    try {
      return await runFixLoop({ models: fixModels, env, report, repoName, maxAttempts: replay ? 2 : 3, onPhase: (p) => console.log(`  ${p}`) });
    } finally {
      await session.dispose();
    }
  })();
  console.log(`baseline: ${result.baseline.summary}`);
  for (const a of result.attempts) {
    console.log(`attempt ${a.attempt}: ${a.passed ? "PASSED" : "failed"} — ${a.applyError ?? a.verdict}${a.test ? ` (${a.test.summary})` : ""}${a.regressionTest ? `; regression test reproduces bug: ${a.reproduced}` : ""}`);
  }
  if (result.offered) fixed++;
  console.log(result.offered ? `offered for approval: attempt ${result.offered.attempt}` : `nothing offered: ${result.error}`);
  if (result.offered && !result.offered.passed) failed = true;

  // 3. Replay only: store the run like the worker does and exercise the approval gate with a recording publisher.
  if (replay) {
    const trace = await prisma.agentRun.create({ data: { repoId: repo.id, kind: "trace", status: "succeeded", input: { text: bug.report }, output: { report } as unknown as Prisma.InputJsonValue } });
    const run = await prisma.agentRun.create({ data: { repoId: repo.id, kind: "fix", parentRunId: trace.id, input: { traceRunId: trace.id, eval: bug.id } } });
    const rows = [];
    for (const a of result.attempts) {
      rows.push(
        await prisma.fixAttempt.create({
          data: { runId: run.id, attempt: a.attempt, baseSha: bug.preFixSha, patch: a.patch, applied: a.applied, applyError: a.applyError, passed: a.passed, testSummary: a.test?.summary ?? a.verdict, newFailures: a.newFailures, regressionTest: a.regressionTest, reproduced: a.reproduced },
        }),
      );
    }
    const offered = rows.find((r) => r.attempt === result.offered?.attempt) ?? null;
    const { outputTail: _t, ...baseline } = result.baseline;
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: offered ? "succeeded" : "failed", output: { baseSha: bug.preFixSha, baseline, offeredAttemptId: offered?.id ?? null } as unknown as Prisma.InputJsonValue } });

    const publisher = new RecordingPublisher();
    const failing = rows.find((r) => !r.passed);
    if (failing) {
      const refused = await approveFixAttempt({ prisma, publisher, repoDir }, repo, failing.id).then(() => null, (e: Error) => e.message);
      console.log(`approve failing attempt ${failing.attempt}: ${refused ? `refused (${refused})` : "ACCEPTED — this is a bug"}`);
      if (!refused) failed = true;
    }
    console.log(`publisher calls before approval: ${publisher.calls.length}`);
    if (publisher.calls.length) failed = true;
    if (offered) {
      const res = await approveFixAttempt({ prisma, publisher, repoDir }, repo, offered.id);
      const call = publisher.calls[0]!;
      const attribution = /co-authored-by|generated with|claude|anthropic/i.test(`${call.content.body}\n${call.content.commitMessage}`);
      console.log(`approve offered attempt ${offered.attempt}: publisher called ${publisher.calls.length}x, ${res.prUrl}`);
      console.log(`  PR title: ${call.content.title}`);
      console.log(`  attribution lines in PR body/commit: ${attribution ? "FOUND" : "none"}`);
      console.log(`  approving it again: ${approvalProblem({ ...offered, prUrl: res.prUrl }, offered.id)}`);
      if (attribution || publisher.calls.length !== 1) failed = true;
    }
    // Eval rows (with their dry-run "PR") must not show up as real cases in the app.
    await prisma.agentRun.deleteMany({ where: { id: { in: [run.id, trace.id] } } });
  }
}

const n = dataset.bugs.length;
console.log(`\ntracing: real fix file top-1 ${top1}/${n}, top-3 ${top3}/${n}`);
console.log(`fixer${replay ? " (replay of the real fix — pipeline check, not a model eval)" : ""}: ${fixed}/${n} bugs with a passing patch offered`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);

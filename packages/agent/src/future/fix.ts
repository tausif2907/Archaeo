import type { ChatMessage, Models } from "@archaeo/models";
import { compareToBaseline, extractDiff, filesInDiff, isTestPath, testOnlyDiff } from "@archaeo/sandbox";
import type { BugReport, TestRunSummary } from "@archaeo/shared";
import { formatCodeRef } from "../present/code-refs";

export interface TestRun extends TestRunSummary {
  outputTail: string;
}

/** What the fixer may do to the sandbox. Deliberately has no way to push or publish anything. */
export interface FixEnvironment {
  runTests(files?: string[]): Promise<TestRun>;
  applyPatch(diff: string): Promise<{ ok: boolean; output: string }>;
  reset(): Promise<void>;
  readFile(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
}

export interface AttemptResult {
  attempt: number;
  patch: string;
  applied: boolean;
  applyError: string | null;
  passed: boolean;
  verdict: string;
  test: TestRun | null;
  newFailures: string[];
  regressionTest: boolean;
  /** The patch's tests fail without the code change (null: not checked) */
  reproduced: boolean | null;
  durationMs: number;
}

export interface FixLoopResult {
  baseline: TestRun;
  attempts: AttemptResult[];
  /** First attempt that passed, if any. Only this may be offered for approval. */
  offered: AttemptResult | null;
  error: string | null;
}

export interface FixLoopOptions {
  models: Pick<Models, "writeCode">;
  env: FixEnvironment;
  report: BugReport;
  repoName: string;
  maxAttempts?: number;
  runId?: string;
  onPhase?: (phase: string) => void;
  onAttempt?: (a: AttemptResult) => void | Promise<void>;
  /** Re-use a baseline already computed for this commit */
  baseline?: TestRun;
}

const MAX_FILE_LINES = 400;
const WINDOW = 60;
const FEEDBACK_CHARS = 3500;

const SYSTEM = (repoName: string) => `You are a careful engineer fixing a bug in ${repoName}.
Reply with ONLY a unified diff in a \`\`\`diff block: paths relative to the repository root (--- a/path, +++ b/path),
context lines copied exactly from the files shown, and correct @@ hunk headers.
Make the smallest change that fixes the root cause. If feasible, add a regression test to the existing test file that fails without the fix.
Do not reformat or change unrelated code.`;

/** File content for the prompt: whole file when short, else windows around the suspect lines. */
async function fileContext(env: FixEnvironment, path: string, focus: { startLine: number; endLine: number }[]): Promise<string | null> {
  const text = await env.readFile(path);
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines.length <= MAX_FILE_LINES) return `### ${path} (${lines.length} lines)\n\`\`\`\n${text}\n\`\`\``;
  const ranges = (focus.length ? focus : [{ startLine: 1, endLine: 80 }])
    .map((f) => [Math.max(1, f.startLine - WINDOW), Math.min(lines.length, f.endLine + WINDOW)] as const)
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((acc, [s, e]) => {
      const last = acc[acc.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else acc.push([s, e]);
      return acc;
    }, []);
  const parts = ranges.map(([s, e]) => `Lines ${s}-${e}:\n\`\`\`\n${lines.slice(s - 1, e).join("\n")}\n\`\`\``);
  return `### ${path} (${lines.length} lines; excerpts)\n${parts.join("\n")}`;
}

/** Likely test file for a module: tests/test_<name>.py or a sibling *.test.ts. */
async function guessTestFile(env: FixEnvironment, path: string): Promise<string | null> {
  const base = path.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/^_+/, "");
  const candidates = [`tests/test_${base}.py`, `test/test_${base}.py`, path.replace(/\.(ts|js)x?$/, ".test.$1"), `tests/test_basic.py`];
  for (const c of candidates) if (await env.exists(c)) return c;
  return null;
}

async function buildPrompt(opts: FixLoopOptions): Promise<ChatMessage[]> {
  const { report, env } = opts;
  const codeFiles = [...new Set([...report.filesToChange, ...report.suspects.map((s) => s.path)])].filter((p) => !isTestPath(p)).slice(0, 2);
  const focusFor = (p: string) => [...report.suspects, ...report.evidence.map((e) => e.ref)].filter((r) => r.path === p);
  const contexts = (await Promise.all(codeFiles.map((p) => fileContext(env, p, focusFor(p))))).filter(Boolean);
  const testFile = codeFiles[0] ? await guessTestFile(env, codeFiles[0]) : null;
  const testContext = testFile ? await fileContext(env, testFile, [{ startLine: 1, endLine: 30 }]) : null;

  const evidence = report.evidence.map((e) => `- ${formatCodeRef(e.ref)}: ${e.why}`).join("\n");
  return [
    { role: "system", content: SYSTEM(opts.repoName) },
    {
      role: "user",
      content: [
        `Bug:\n${report.description.slice(0, 3000)}`,
        report.exception && `Exception: ${report.exception}`,
        `Diagnosis (${report.confidence} confidence): ${report.hypothesis}`,
        evidence && `Evidence:\n${evidence}`,
        `Files:\n${contexts.join("\n\n")}`,
        testContext && `Existing test file for a regression test (start of file):\n${testContext}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

function tail(text: string, n = FEEDBACK_CHARS): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

/**
 * Generate → apply → test, up to `maxAttempts` times, feeding failures back to the model. A patch is
 * offered only if it changes non-test code, applies cleanly, and introduces no test failures.
 */
export async function runFixLoop(opts: FixLoopOptions): Promise<FixLoopResult> {
  const { env } = opts;
  const max = opts.maxAttempts ?? 3;
  const phase = opts.onPhase ?? (() => {});

  phase("Running the test suite at the base commit");
  const baseline = opts.baseline ?? (await env.runTests());
  if (baseline.exitCode !== 0 && baseline.failures === null) {
    return { baseline, attempts: [], offered: null, error: `The test suite fails before any change and its failures can't be compared (${baseline.summary}).` };
  }

  const messages = await buildPrompt(opts);
  const attempts: AttemptResult[] = [];
  for (let n = 1; n <= max; n++) {
    const started = Date.now();
    phase(`Attempt ${n} of ${max}: writing a patch`);
    const step = await opts.models.writeCode(messages, undefined, { runId: opts.runId });
    messages.push({ role: "assistant", content: step.content });
    const diff = extractDiff(step.content);
    const record = async (r: Omit<AttemptResult, "attempt" | "durationMs">, feedback: string | null) => {
      const result = { ...r, attempt: n, durationMs: Date.now() - started };
      attempts.push(result);
      await opts.onAttempt?.(result);
      if (feedback) messages.push({ role: "user", content: feedback });
      return result;
    };
    const empty = { applied: false, passed: false, test: null, newFailures: [], regressionTest: false, reproduced: null };

    if (!diff) {
      await record({ ...empty, patch: step.content.slice(0, 4000), applyError: "No unified diff in the model output", verdict: "No patch" }, "Your reply had no unified diff. Reply with a ```diff block only.");
      continue;
    }
    const files = filesInDiff(diff);
    const regressionTest = files.some(isTestPath);
    if (!files.some((f) => !isTestPath(f))) {
      await record({ ...empty, patch: diff, regressionTest, applyError: "The patch only changes tests; it must change the code", verdict: "Tests only" }, "That patch only changes tests. Fix the code itself (a regression test is welcome in addition).");
      continue;
    }

    await env.reset();
    phase(`Attempt ${n} of ${max}: applying the patch`);
    const applied = await env.applyPatch(diff);
    if (!applied.ok) {
      await record(
        { ...empty, patch: diff, regressionTest, applyError: applied.output || "git apply failed", verdict: "Patch does not apply" },
        `The patch did not apply:\n${tail(applied.output, 1500)}\nRegenerate it against the exact file contents shown.`,
      );
      continue;
    }

    phase(`Attempt ${n} of ${max}: running the test suite`);
    const test = await env.runTests();
    const verdict = compareToBaseline(baseline, test);

    let reproduced: boolean | null = null;
    if (verdict.passed && regressionTest) {
      // Proof the new tests target the bug: they should fail on the unfixed code.
      phase(`Attempt ${n} of ${max}: checking the new tests fail without the fix`);
      const testsOnly = testOnlyDiff(diff)!;
      await env.reset();
      if ((await env.applyPatch(testsOnly)).ok) {
        const repro = await env.runTests(filesInDiff(testsOnly));
        reproduced = repro.exitCode !== 0 && !repro.timedOut;
      }
      await env.reset();
    }

    const result = await record(
      { patch: diff, applied: true, applyError: null, passed: verdict.passed, verdict: verdict.reason, test, newFailures: verdict.newFailures, regressionTest, reproduced },
      verdict.passed
        ? null
        : `The patch applied but the tests failed: ${verdict.reason}.\n${verdict.newFailures.length ? `New failures:\n${verdict.newFailures.slice(0, 20).join("\n")}\n` : ""}Test output (end):\n${tail(test.outputTail)}\nFix the patch.`,
    );
    if (result.passed) return { baseline, attempts, offered: result, error: null };
  }
  return { baseline, attempts, offered: null, error: `No passing patch after ${max} attempt${max === 1 ? "" : "s"}.` };
}

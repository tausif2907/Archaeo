import { describe, expect, it } from "vitest";
import { createModels, loadModelConfig, MockProvider, type ChatOutput } from "@archaeo/models";
import type { BugReport } from "@archaeo/shared";
import { approvalProblem } from "./approve";
import { runFixLoop, type FixEnvironment, type TestRun } from "./fix";
import { parseIssueUrl } from "./issue";
import { buildPrContent } from "./publish";
import { mapFrames, parseStackTrace } from "./stack";
import { fallbackReport } from "./trace";

const PY_TRACE = `Traceback (most recent call last):
  File "/home/u/app/cli.py", line 12, in <module>
    main()
  File "/home/u/.venv/lib/python3.12/site-packages/click/core.py", line 1442, in __call__
    return self.main(*args, **kwargs)
  File "/home/u/.venv/lib/python3.12/site-packages/click/types.py", line 410, in convert
    self.fail(msg)
click.exceptions.BadParameter: 'x' is not one of 'a', 'b'.`;

const JS_TRACE = `TypeError: Cannot read properties of undefined (reading 'id')
    at formatUser (/srv/app/src/lib/format.ts:8:20)
    at /srv/app/src/server.ts:15:14
    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)`;

describe("stack traces", () => {
  it("parses Python tracebacks innermost first, with the exception", () => {
    const t = parseStackTrace(PY_TRACE);
    expect(t.exception).toBe("click.exceptions.BadParameter: 'x' is not one of 'a', 'b'.");
    expect(t.frames.map((f) => `${f.rawPath.split("/").pop()}:${f.line}:${f.func}`)).toEqual(["types.py:410:convert", "core.py:1442:__call__", "cli.py:12:<module>"]);
  });

  it("parses JS stack traces", () => {
    const t = parseStackTrace(JS_TRACE);
    expect(t.exception).toBe("TypeError: Cannot read properties of undefined (reading 'id')");
    expect(t.frames.map((f) => [f.rawPath, f.line, f.func])).toEqual([
      ["/srv/app/src/lib/format.ts", 8, "formatUser"],
      ["/srv/app/src/server.ts", 15, null],
      ["/srv/app/node_modules/express/lib/router/layer.js", 95, "Layer.handle"],
    ]);
  });

  it("maps installed or absolute paths onto repo files by path suffix", () => {
    const repo = ["src/click/core.py", "src/click/types.py", "src/click/__init__.py", "tests/test_core.py", "examples/app/__init__.py"];
    const frames = mapFrames(parseStackTrace(PY_TRACE).frames, repo);
    expect(frames.map((f) => f.path)).toEqual(["src/click/types.py", "src/click/core.py", null]);
    // A generic file name matching on one segment only is ambiguous, so it isn't guessed.
    expect(mapFrames([{ rawPath: "/x/y/__init__.py", line: 1, func: null }], repo)[0]!.path).toBeNull();
    expect(mapFrames([{ rawPath: "C:\\proj\\src\\click\\core.py", line: 3, func: null }], repo)[0]!.path).toBe("src/click/core.py");
  });

  it("parses issue URLs", () => {
    expect(parseIssueUrl("https://github.com/pallets/click/issues/1234")).toEqual({ owner: "pallets", name: "click", number: 1234 });
    expect(parseIssueUrl("github.com/a/b/pull/9#issuecomment-1")).toEqual({ owner: "a", name: "b", number: 9 });
    expect(parseIssueUrl("https://gitlab.com/a/b/issues/1")).toBeNull();
  });
});

const report: BugReport = {
  issue: { number: 42, title: "Usage shows [[a|b]] for optional choices", url: "https://github.com/o/r/issues/42" },
  description: "Optional Choice arguments render as [[a|b]] in the usage line.",
  exception: null,
  frames: [],
  suspects: [{ path: "src/pkg/core.py", startLine: 1, endLine: 2, symbol: "make_metavar", score: 4, reasons: ["Matches the bug description (search rank 1)"] }],
  hypothesis: "Argument.make_metavar wraps an already-bracketed metavar in a second pair of brackets.",
  confidence: "medium",
  evidence: [{ ref: { path: "src/pkg/core.py", startLine: 1, endLine: 2 }, why: "wraps var in brackets" }],
  filesToChange: ["src/pkg/core.py"],
  fallback: false,
  toolCalls: [],
  costUsd: 0,
};

const GOOD = "diff --git a/src/pkg/core.py b/src/pkg/core.py\n--- a/src/pkg/core.py\n+++ b/src/pkg/core.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n y = 3\ndiff --git a/tests/test_core.py b/tests/test_core.py\n--- a/tests/test_core.py\n+++ b/tests/test_core.py\n@@ -1 +1,2 @@\n import pkg\n+def test_x(): assert pkg.core.x == 2\n";
const BREAKS = "--- a/src/pkg/core.py\n+++ b/src/pkg/core.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = None\n y = 3\n";
const TESTS_ONLY = "--- a/tests/test_core.py\n+++ b/tests/test_core.py\n@@ -1 +1,2 @@\n import pkg\n+def test_y(): pass\n";
const STALE = "--- a/src/pkg/core.py\n+++ b/src/pkg/core.py\n@@ -1,2 +1,2 @@\n-x = 999\n+x = 2\n y = 3\n";

/** In-memory sandbox: tracks applied patches; tests pass only with the good code change. */
function fakeEnv() {
  const applied: string[] = [];
  const runs: { files?: string[]; applied: string[] }[] = [];
  const pass = (summary: string): TestRun => ({ exitCode: 0, timedOut: false, failures: [], summary, durationMs: 1, outputTail: "ok" });
  const fail = (ids: string[]): TestRun => ({ exitCode: 1, timedOut: false, failures: ids, summary: `${ids.length} failed`, durationMs: 1, outputTail: `FAILED ${ids.join("\nFAILED ")}` });
  const env: FixEnvironment & { applied: string[]; runs: typeof runs } = {
    applied,
    runs,
    async applyPatch(diff) {
      if (diff.includes("x = 999")) return { ok: false, output: "error: patch failed: src/pkg/core.py:1" };
      applied.push(diff);
      return { ok: true, output: "" };
    },
    async reset() {
      applied.length = 0;
    },
    async runTests(files) {
      runs.push({ files, applied: [...applied] });
      const code = applied.join("");
      if (code.includes("x = None")) return fail(["tests/test_core.py::test_existing"]);
      if (files?.length) return code.includes("+x = 2") ? pass("1 passed") : fail(["tests/test_core.py::test_x"]);
      return pass("10 passed");
    },
    async readFile(path) {
      return path === "src/pkg/core.py" ? "x = 1\ny = 3\n" : path === "tests/test_core.py" ? "import pkg\n" : null;
    },
    async exists(path) {
      return path === "tests/test_core.py";
    },
  };
  return env;
}

const reply = (content: string): ChatOutput => ({ content, toolCalls: [], finishReason: "stop" });
const modelsWith = (...replies: string[]) => createModels({ config: loadModelConfig({}), providers: { mock: new MockProvider({ script: replies.map(reply) }) } });

describe("fix loop", () => {
  it("retries after failing patches and offers only the passing one, verifying its regression test", async () => {
    const env = fakeEnv();
    const phases: string[] = [];
    const res = await runFixLoop({
      models: modelsWith("I think it's fine.", `\`\`\`diff\n${TESTS_ONLY}\`\`\``, `\`\`\`diff\n${STALE}\`\`\``),
      env,
      report,
      repoName: "o/r",
      maxAttempts: 3,
      onPhase: (p) => phases.push(p),
    });
    expect(res.offered).toBeNull();
    expect(res.attempts.map((a) => a.applyError)).toEqual(["No unified diff in the model output", "The patch only changes tests; it must change the code", "error: patch failed: src/pkg/core.py:1"]);
    expect(res.error).toBe("No passing patch after 3 attempts.");

    const env2 = fakeEnv();
    const res2 = await runFixLoop({ models: modelsWith(`\`\`\`diff\n${BREAKS}\`\`\``, `Fixed:\n\`\`\`diff\n${GOOD}\`\`\``), env: env2, report, repoName: "o/r" });
    expect(res2.attempts.map((a) => [a.applied, a.passed, a.newFailures])).toEqual([
      [true, false, ["tests/test_core.py::test_existing"]],
      [true, true, []],
    ]);
    expect(res2.offered?.attempt).toBe(2);
    expect(res2.offered?.regressionTest).toBe(true);
    expect(res2.offered?.reproduced).toBe(true);
    // The reproduction run applied only the test part of the patch, to the unfixed code.
    const repro = env2.runs.find((r) => r.files?.length)!;
    expect(repro.files).toEqual(["tests/test_core.py"]);
    expect(repro.applied.join("")).not.toContain("+x = 2");
  });

  it("never offers a patch that breaks tests, even on the last attempt", async () => {
    const res = await runFixLoop({ models: modelsWith(`\`\`\`diff\n${BREAKS}\`\`\``), env: fakeEnv(), report, repoName: "o/r", maxAttempts: 1 });
    expect(res.offered).toBeNull();
    expect(res.attempts[0]).toMatchObject({ applied: true, passed: false });
  });

  it("refuses to judge when the suite already fails in a way it can't compare", async () => {
    const env = fakeEnv();
    env.runTests = async () => ({ exitCode: 2, timedOut: false, failures: null, summary: "crashed", durationMs: 1, outputTail: "" });
    const res = await runFixLoop({ models: modelsWith(`\`\`\`diff\n${GOOD}\`\`\``), env, report, repoName: "o/r" });
    expect(res.attempts).toEqual([]);
    expect(res.error).toContain("fails before any change");
  });
});

describe("approval", () => {
  it("only lets the offered, passing, unpublished attempt through", () => {
    expect(approvalProblem({ id: "a1", passed: false, prUrl: null }, "a1")).toBe("Only a patch that passed the tests can be approved");
    expect(approvalProblem({ id: "a2", passed: true, prUrl: null }, "a1")).toBe("This attempt was not offered for approval");
    expect(approvalProblem({ id: "a1", passed: true, prUrl: "https://x" }, "a1")).toBe("This patch was already published");
    expect(approvalProblem({ id: "a1", passed: true, prUrl: null }, null)).toBe("This attempt was not offered for approval");
    expect(approvalProblem({ id: "a1", passed: true, prUrl: null }, "a1")).toBeNull();
  });
});

describe("pull request content", () => {
  it("explains the fix with evidence and test results, with no attribution lines", () => {
    const pr = buildPrContent({
      report,
      attempt: { patch: GOOD, testSummary: "1658 passed", regressionTest: true, reproduced: true },
      baseline: { exitCode: 0, timedOut: false, failures: [], summary: "1656 passed", durationMs: 1 },
      baseSha: "8929d39aaaaaaa",
    });
    expect(pr.title).toBe("Fix: Usage shows [[a|b]] for optional choices");
    expect(pr.branch).toMatch(/^archaeo\/usage-shows-a-b-for-optional-choices-[0-9a-f]{6}$/);
    expect(pr.body).toContain("`src/pkg/core.py:1-2`: wraps var in brackets");
    expect(pr.body).toContain("Before: 1656 passed (at 8929d39)");
    expect(pr.body).toContain("fails without this change and passes with it");
    for (const text of [pr.body, pr.commitMessage]) expect(text).not.toMatch(/co-authored-by|generated with|claude|anthropic|\bAI\b/i);
  });

  it("builds a fallback report from suspects", () => {
    const r = fallbackReport(report.suspects, "ValueError: bad", true);
    expect(r.confidence).toBe("medium");
    expect(r.filesToChange).toEqual(["src/pkg/core.py"]);
    expect(r.hypothesis).toContain("`make_metavar` (src/pkg/core.py:1-2)");
    expect(fallbackReport([], null, false).filesToChange).toEqual([]);
  });
});

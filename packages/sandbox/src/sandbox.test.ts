import { describe, expect, it } from "vitest";
import { dependencyGroups, testGroups } from "./detect";
import { DockerSandbox, dockerfile, imageTag, SandboxUnavailableError } from "./docker";
import { extractDiff, filesInDiff, isTestPath, splitDiff, testOnlyDiff } from "./patch";
import { compareToBaseline, parsePytest } from "./results";

const DIFF = `diff --git a/src/pkg/core.py b/src/pkg/core.py
--- a/src/pkg/core.py
+++ b/src/pkg/core.py
@@ -1,2 +1,2 @@
-x = 1
+x = 2
 y = 3
diff --git a/tests/test_core.py b/tests/test_core.py
--- a/tests/test_core.py
+++ b/tests/test_core.py
@@ -1 +1,3 @@
 import pkg
+def test_x():
+    assert pkg.core.x == 2
`;

describe("patches", () => {
  it("extracts diffs from fenced or raw model output", () => {
    expect(extractDiff(`Here is the fix:\n\`\`\`diff\n${DIFF}\`\`\`\nDone.`)).toBe(DIFF);
    expect(extractDiff(`Sure.\n${DIFF}`)).toBe(DIFF);
    expect(extractDiff("I could not find the bug.")).toBeNull();
    expect(extractDiff("```diff\n--- a/x\n+++ b/x\n```")).toBeNull(); // no hunk
  });

  it("splits git and plain diffs per file and finds test-only parts", () => {
    expect(filesInDiff(DIFF)).toEqual(["src/pkg/core.py", "tests/test_core.py"]);
    const plain = "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-c\n+d\n";
    expect(splitDiff(plain).map((f) => f.path)).toEqual(["a.py", "tests/test_a.py"]);
    expect(testOnlyDiff(DIFF)).toContain("+++ b/tests/test_core.py");
    expect(testOnlyDiff(DIFF)).not.toContain("core.py\n-x = 1");
    expect(testOnlyDiff("--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n")).toBeNull();
    const created = "diff --git a/tests/test_new.py b/tests/test_new.py\nnew file mode 100644\n--- /dev/null\n+++ b/tests/test_new.py\n@@ -0,0 +1 @@\n+x\n";
    expect(filesInDiff(created)).toEqual(["tests/test_new.py"]);
  });

  it("recognises test files across languages", () => {
    for (const p of ["tests/test_a.py", "pkg/test_util.py", "pkg/util_test.py", "src/a.test.ts", "src/__tests__/a.js", "test/x.js"]) expect(isTestPath(p)).toBe(true);
    for (const p of ["src/pkg/core.py", "src/testing.py", "src/contest.ts"]) expect(isTestPath(p)).toBe(false);
  });
});

describe("pytest results", () => {
  it("parses failures and the summary line", () => {
    const out = "....F..E\n=========================== short test summary info ============================\nFAILED tests/test_a.py::test_x - AssertionError: 1 != 2\nERROR tests/test_b.py::test_y\nFAILED tests/test_a.py::test_x - again\n2 failed, 10 passed in 1.23s\n";
    expect(parsePytest(out)).toEqual({ failures: ["tests/test_a.py::test_x", "tests/test_b.py::test_y"], summary: "2 failed, 10 passed in 1.23s" });
    expect(parsePytest("====== 1656 passed, 24 skipped in 13.25s ======")).toEqual({ failures: [], summary: "1656 passed, 24 skipped in 13.25s" });
    expect(parsePytest("sh: 1: python: not found")).toEqual({ failures: null, summary: null });
  });

  it("judges patches against the baseline", () => {
    const run = (exitCode: number, failures: string[] | null) => ({ exitCode, timedOut: false, failures, summary: "", durationMs: 1 });
    expect(compareToBaseline(run(0, []), run(0, [])).passed).toBe(true);
    expect(compareToBaseline(run(0, []), run(1, ["t::a"]))).toMatchObject({ passed: false, newFailures: ["t::a"] });
    // Pre-existing failures are tolerated, new ones are not.
    expect(compareToBaseline(run(1, ["t::flaky"]), run(1, ["t::flaky"])).passed).toBe(true);
    expect(compareToBaseline(run(1, ["t::flaky"]), run(1, ["t::flaky", "t::b"]))).toMatchObject({ passed: false, newFailures: ["t::b"] });
    // A failing baseline we can't parse can't be compared, so nothing is offered.
    expect(compareToBaseline(run(1, null), run(0, [])).passed).toBe(false);
    expect(compareToBaseline(run(0, []), { ...run(124, null), timedOut: true }).passed).toBe(false);
  });
});

describe("docker availability", () => {
  it("explains a missing or stopped Docker daemon instead of failing mid-build", async () => {
    const sandbox = new DockerSandbox({ docker: "docker-binary-that-does-not-exist" });
    await expect(sandbox.checkAvailable()).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(sandbox.checkAvailable()).rejects.toThrow(/Docker is not available .*Start Docker Desktop/);
  });
});

describe("sandbox config", () => {
  it("finds pyproject dependency groups and prefers the plain test group", () => {
    const pyproject = '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["ruff"]\ntests = [\n  "pytest",\n]\ntests-random = ["pytest-randomly"]\n\n[tool.ruff]\nx = 1\n';
    expect(dependencyGroups(pyproject)).toEqual(["dev", "tests", "tests-random"]);
    expect(testGroups(["dev", "tests", "tests-random"])).toEqual(["tests"]);
    expect(testGroups(["dev", "unit-tests"])).toEqual(["unit-tests"]);
  });

  it("builds a cacheable image definition", () => {
    const config = {
      language: "python" as const,
      baseImage: "python:3.12-slim",
      systemPackages: ["git", "less"],
      install: ["pip install pytest"],
      depsFiles: ["pyproject.toml"],
      test: "pytest",
      testFiles: "pytest {files}",
      env: {},
      timeoutSeconds: 60,
    };
    expect(dockerfile(config)).toBe(
      "FROM python:3.12-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git less && rm -rf /var/lib/apt/lists/*\nWORKDIR /deps\nCOPY . /deps/\nRUN pip install pytest\nWORKDIR /work\n",
    );
    const tag = imageTag("pallets/click", config, { "pyproject.toml": "a" });
    expect(tag).toMatch(/^archaeo-sbx-pallets-click:[0-9a-f]{16}$/);
    expect(imageTag("pallets/click", { ...config, test: "other" }, { "pyproject.toml": "a" })).toBe(tag); // test command doesn't change the image
    expect(imageTag("pallets/click", config, { "pyproject.toml": "b" })).not.toBe(tag);
  });
});

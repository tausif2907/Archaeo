import type { SandboxConfig, TestRunSummary } from "@archaeo/shared";
import type { ExecResult } from "./exec";

/** Failing test ids from pytest `-rfE` output, or null when the output isn't a pytest run. */
export function parsePytest(output: string): { failures: string[] | null; summary: string | null } {
  const summary =
    [...output.matchAll(/^=+ (.*\b(passed|failed|error|errors|skipped|deselected|no tests ran)\b.*) =+$/gm)].pop()?.[1] ??
    [...output.matchAll(/^(\d+ (passed|failed)[^\n]*in [\d.]+s)\s*$/gm)].pop()?.[1] ??
    null;
  if (!summary) return { failures: null, summary: null };
  const failures = [...new Set([...output.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1]!))].sort();
  return { failures, summary };
}

export function summarizeRun(r: ExecResult, config: Pick<SandboxConfig, "language">): TestRunSummary {
  if (r.timedOut) return { exitCode: r.exitCode, timedOut: true, failures: null, summary: "Timed out", durationMs: r.durationMs };
  if (config.language === "python") {
    const p = parsePytest(r.output);
    // pytest exit code 5 = no tests collected
    return { exitCode: r.exitCode, timedOut: false, failures: p.failures, summary: p.summary ?? `exit code ${r.exitCode}`, durationMs: r.durationMs };
  }
  const last = r.output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  return { exitCode: r.exitCode, timedOut: false, failures: r.exitCode === 0 ? [] : null, summary: last.slice(0, 200) || `exit code ${r.exitCode}`, durationMs: r.durationMs };
}

export interface Verdict {
  passed: boolean;
  newFailures: string[];
  reason: string;
}

/**
 * A patched run passes when it introduces no new failures relative to the unpatched baseline.
 * A clean baseline must stay fully green; with a failing baseline, failures must be comparable.
 */
export function compareToBaseline(baseline: TestRunSummary, patched: TestRunSummary): Verdict {
  if (patched.timedOut) return { passed: false, newFailures: [], reason: "Tests timed out" };
  if (baseline.exitCode === 0) {
    return patched.exitCode === 0
      ? { passed: true, newFailures: [], reason: "All tests pass" }
      : { passed: false, newFailures: patched.failures ?? [], reason: "Tests fail" };
  }
  if (baseline.failures === null || patched.failures === null) {
    return { passed: false, newFailures: [], reason: "The suite already fails at the base commit and failures can't be compared" };
  }
  const before = new Set(baseline.failures);
  const added = patched.failures.filter((f) => !before.has(f));
  return added.length
    ? { passed: false, newFailures: added, reason: `${added.length} test(s) fail that passed before` }
    : { passed: true, newFailures: [], reason: `No new failures (${baseline.failures.length} already failed before the patch)` };
}

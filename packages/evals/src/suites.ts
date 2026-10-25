import { answerQuestion, explainWhy, findCitations, loadAgentLimits, loadCitationIndex, runFixLoop, traceBug, type WhyTarget } from "@archaeo/agent";
import { prisma, type Repo } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import { createSandboxProvider, detectSandboxConfig } from "@archaeo/sandbox";
import type { CodeRef } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import { CostMeter, sandboxEnv, type ItemResult, type SuiteResult } from "./common";
import { withSnapshot } from "./snapshot";

export interface HistoryQuestion {
  id: string;
  question: string;
  target: WhyTarget;
  expected: { introducedSha: string; prNumbers: number[]; facts?: string[] };
}

export interface QaQuestion {
  id: string;
  question: string;
  expected: { files: string[]; symbols: string[] };
}

export interface Bug {
  id: string;
  title: string;
  report: string;
  preFixSha: string;
  fixSha: string;
  fixFiles: string[];
  /** Replay only: a wrong patch tried before the real fix, to exercise retry */
  replayWrongPatch?: string;
}

export interface SuiteDeps {
  models: Models;
  meter: CostMeter;
  log: (line: string) => void;
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** "Why does X exist?": the introducing commit and PR must be found, cited, and every citation must exist. */
export async function evalHistory(repo: Repo, questions: HistoryQuestion[], { models, meter, log }: SuiteDeps): Promise<SuiteResult> {
  const index = await loadCitationIndex(prisma, repo.id);
  const dir = repoCloneDir(repo.owner, repo.name);
  const items: ItemResult[] = [];
  let found = 0;
  let cited = 0;
  let valid = 0;
  let fallbacks = 0;

  for (const q of questions) {
    const mark = meter.mark();
    const started = Date.now();
    const r = await explainWhy({ prisma, models, repoId: repo.id, repoDir: dir }, q.target);
    const ms = Date.now() - started;
    const c = findCitations(r.answer);
    const foundOk = sameSha(r.introduced.sha, q.expected.introducedSha) && q.expected.prNumbers.every((n) => r.introduced.prNumbers.includes(n));
    const citedOk = c.shas.some((s) => sameSha(s, q.expected.introducedSha)) && q.expected.prNumbers.every((n) => c.numbers.includes(n));
    const validOk = c.shas.every((s) => index.resolveSha(s) !== null) && c.numbers.every((n) => index.hasNumber(n));
    if (foundOk) found++;
    if (citedOk) cited++;
    if (validOk) valid++;
    if (r.fallback) fallbacks++;

    const failures: string[] = [];
    if (!sameSha(r.introduced.sha, q.expected.introducedSha)) failures.push(`introducing commit: got ${r.introduced.shortSha}, expected ${q.expected.introducedSha.slice(0, 7)}`);
    for (const n of q.expected.prNumbers) if (!r.introduced.prNumbers.includes(n)) failures.push(`PR #${n} not linked`);
    if (!citedOk) failures.push("answer does not cite the introducing commit and PR");
    if (!validOk) failures.push(`invalid citations: ${[...c.shas.filter((s) => index.resolveSha(s) === null), ...c.numbers.filter((n) => !index.hasNumber(n)).map((n) => `#${n}`)].join(", ")}`);
    const ok = foundOk && citedOk && validOk;
    const { calls, cost } = meter.since(mark);
    items.push({ id: q.id, ok, ms, cost, calls, detail: `introduced ${r.introduced.shortSha}${r.introduced.prNumbers.length ? ` (#${r.introduced.prNumbers.join(", #")})` : ""}${r.fallback ? ", fallback answer" : ""}`, failures });
    log(`${ok ? "PASS" : "FAIL"}  ${q.question}  (${ms} ms)`);
  }

  const n = questions.length;
  return {
    suite: "history",
    repo: `${repo.owner}/${repo.name}`,
    items,
    scores: [
      { label: "Answer accuracy (found, cited, all citations valid)", hits: items.filter((i) => i.ok).length, total: n },
      { label: "Introducing commit and PR found", hits: found, total: n },
      { label: "Answer cites them", hits: cited, total: n },
      { label: "Citation validity (every cited SHA/PR exists)", hits: valid, total: n },
    ],
    stats: [{ label: "Fallback answers (model output unusable)", value: `${fallbacks}/${n}` }],
    notes: [],
  };
}

const overlaps = (a: CodeRef, b: CodeRef) => a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
/** Citations longer than this don't count as pointing at specific code. */
const MAX_PRECISE_LINES = 300;

/** Code Q&A: a precise citation must overlap an expected symbol, and every citation must be valid. */
export async function evalQa(repo: Repo, questions: QaQuestion[], { models, meter, log }: SuiteDeps): Promise<SuiteResult> {
  const limits = loadAgentLimits();
  const items: ItemResult[] = [];
  let fileHits = 0;
  let firstHits = 0;
  let valid = 0;
  let fallbacks = 0;

  for (const q of questions) {
    const targets: CodeRef[] = (
      await prisma.symbol.findMany({
        where: { file: { repoId: repo.id, path: { in: q.expected.files } }, qualifiedName: { in: q.expected.symbols } },
        select: { startLine: true, endLine: true, file: { select: { path: true } } },
      })
    ).map((s) => ({ path: s.file.path, startLine: s.startLine, endLine: s.endLine }));
    if (!targets.length) throw new Error(`${q.id}: expected symbols not found in the index`);

    const mark = meter.mark();
    const started = Date.now();
    const r = await answerQuestion(
      { prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name), repoName: `${repo.owner}/${repo.name}` },
      q.question,
      { limits },
    );
    const ms = Date.now() - started;
    const fileHit = r.refs.some((ref) => q.expected.files.includes(ref.path));
    const symbolHit = r.refs.some((ref) => ref.endLine - ref.startLine < MAX_PRECISE_LINES && targets.some((t) => overlaps(ref, t)));
    const firstHit = !!r.refs[0] && q.expected.files.includes(r.refs[0].path);
    const validOk = r.invalidCitations.length === 0 && r.refs.length > 0;
    if (fileHit) fileHits++;
    if (firstHit) firstHits++;
    if (validOk) valid++;
    if (r.fallback) fallbacks++;

    const failures: string[] = [];
    if (!symbolHit) failures.push(`no precise citation overlaps ${q.expected.symbols.join(" / ")}`);
    if (!validOk) failures.push(`invalid citations: ${r.invalidCitations.join(", ") || "(none cited)"}`);
    const ok = symbolHit && validOk;
    const { calls, cost } = meter.since(mark);
    items.push({
      id: q.id,
      ok,
      ms,
      cost,
      calls,
      detail: `cited ${r.refs.slice(0, 3).map((x) => `${x.path}:${x.startLine}-${x.endLine}`).join(", ") || "nothing"}; ${r.toolCalls.length} tool calls${r.fallback ? ", fallback answer" : ""}`,
      failures,
    });
    log(`${ok ? "PASS" : "FAIL"}  ${q.question}  (${ms} ms)`);
  }

  const n = questions.length;
  return {
    suite: "qa",
    repo: `${repo.owner}/${repo.name}`,
    items,
    scores: [
      { label: "Answer accuracy (cites the expected code, all citations valid)", hits: items.filter((i) => i.ok).length, total: n },
      { label: "File recall (an expected file is cited)", hits: fileHits, total: n },
      { label: "First citation in an expected file", hits: firstHits, total: n },
      { label: "Citation validity", hits: valid, total: n },
    ],
    stats: [{ label: "Fallback answers (model output unusable)", value: `${fallbacks}/${n}` }],
    notes: [],
  };
}

/**
 * Historical bugs: trace the symptom-only report against an index of the pre-fix commit (so the fix
 * isn't visible), then run the fixer in the sandbox at that commit unless `fix` is false.
 */
export async function evalBugs(repo: Repo, bugs: Bug[], { models, meter, log }: SuiteDeps, opts: { fix: boolean }): Promise<SuiteResult> {
  const repoDir = repoCloneDir(repo.owner, repo.name);
  const repoName = `${repo.owner}/${repo.name}`;
  const sandbox = opts.fix ? createSandboxProvider() : null;
  const items: ItemResult[] = [];
  let top1 = 0;
  let top3 = 0;
  let offered = 0;
  let attempts = 0;
  let traceMs = 0;
  let fixMs = 0;

  for (const bug of bugs) {
    const mark = meter.mark();
    const failures: string[] = [];
    let detail = "";
    let fixedOk = false;
    const started = Date.now();
    await withSnapshot({ prisma, models }, repo, repoDir, bug.preFixSha, async (snap) => {
      const traceStarted = Date.now();
      const report = await traceBug({ prisma, models, repoId: snap.repoId, repoDir: snap.dir, repoName }, { text: bug.report }, { limits: loadAgentLimits() });
      traceMs += Date.now() - traceStarted;
      const files = [...new Set(report.suspects.map((s) => s.path))];
      const rank = files.findIndex((f) => bug.fixFiles.includes(f));
      if (rank === 0) top1++;
      if (rank >= 0 && rank < 3) top3++;
      if (rank < 0 || rank >= 3) failures.push(`real fix file ${rank < 0 ? "not among suspects" : `ranked #${rank + 1}`}`);
      detail = `fix file ${rank >= 0 ? `#${rank + 1}` : "not found"}; top suspects ${files.slice(0, 3).join(", ") || "none"}${report.fallback ? "; fallback report" : ""}`;

      if (sandbox) {
        const fixStarted = Date.now();
        const detected = await detectSandboxConfig(repoDir, bug.preFixSha);
        if (!detected) throw new Error(`${bug.id}: no sandbox config detected at ${bug.preFixSha.slice(0, 7)}`);
        const session = await sandbox.prepare({ repoDir, sha: bug.preFixSha, repoName, ...detected });
        try {
          const result = await runFixLoop({ models, env: sandboxEnv(session), report, repoName, maxAttempts: 3 });
          attempts += result.attempts.length;
          fixedOk = !!result.offered?.passed;
          if (fixedOk) offered++;
          else failures.push(`no passing patch: ${result.error ?? result.attempts.map((a) => a.applyError ?? a.verdict).join("; ")}`.slice(0, 300));
          detail += `; fixer ${fixedOk ? `passed on attempt ${result.offered!.attempt}` : "failed"} after ${result.attempts.length} attempt(s)`;
        } finally {
          await session.dispose();
        }
        fixMs += Date.now() - fixStarted;
      }
    });
    const { calls, cost } = meter.since(mark);
    const ok = !failures.length;
    items.push({ id: bug.id, ok, ms: Date.now() - started, cost, calls, detail, failures });
    log(`${ok ? "PASS" : "FAIL"}  ${bug.title}  (${detail})`);
  }

  const n = bugs.length;
  return {
    suite: "bugs",
    repo: repoName,
    items,
    scores: [
      { label: "Tracing: real fix file ranked #1", hits: top1, total: n },
      { label: "Tracing: real fix file in top 3", hits: top3, total: n },
      ...(opts.fix ? [{ label: "Fixer: passing patch offered", hits: offered, total: n }] : []),
    ],
    stats: [
      { label: "Average trace latency", value: `${Math.round(traceMs / n)} ms` },
      ...(opts.fix ? [{ label: "Average fixer attempts", value: (attempts / n).toFixed(1) }, { label: "Average fix latency (sandbox + attempts)", value: `${Math.round(fixMs / n / 1000)} s` }] : []),
    ],
    notes: [
      "Each bug is traced against a fresh index of its pre-fix commit, so the fix is not visible to the tracer.",
      ...(opts.fix ? [] : ["Fixer skipped (--no-fix)."]),
    ],
  };
}

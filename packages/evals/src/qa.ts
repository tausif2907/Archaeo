import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerQuestion, loadAgentLimits } from "@archaeo/agent";
import { prisma } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import type { CodeRef } from "@archaeo/shared";
import { repoCloneDir } from "@archaeo/shared/env";
import { requireReadyRepo } from "./repo";

interface Question {
  id: string;
  question: string;
  expected: { files: string[]; symbols: string[] };
}

const dataset = JSON.parse(readFileSync(join(import.meta.dirname, "..", "datasets", "click", "qa.json"), "utf8")) as { repo: string; questions: Question[] };

const repo = await requireReadyRepo(dataset.repo);
const models = configureModels();
const limits = loadAgentLimits();
const overlaps = (a: CodeRef, b: CodeRef) => a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
/** Citations longer than this don't count as pointing at specific code. */
const MAX_PRECISE_LINES = 300;

let passed = 0;
let fileHits = 0;
let top1 = 0;
let totalMs = 0;
let totalCost = 0;
for (const q of dataset.questions) {
  const targets: CodeRef[] = (
    await prisma.symbol.findMany({
      where: { file: { repoId: repo.id, path: { in: q.expected.files } }, qualifiedName: { in: q.expected.symbols } },
      select: { startLine: true, endLine: true, file: { select: { path: true } } },
    })
  ).map((s) => ({ path: s.file.path, startLine: s.startLine, endLine: s.endLine }));
  if (!targets.length) throw new Error(`${q.id}: expected symbols not found in the index`);

  const started = Date.now();
  const r = await answerQuestion(
    { prisma, models, repoId: repo.id, repoDir: repoCloneDir(repo.owner, repo.name), repoName: `${repo.owner}/${repo.name}` },
    q.question,
    { limits },
  );
  const ms = Date.now() - started;
  totalMs += ms;
  totalCost += r.costUsd;

  const fileHit = r.refs.some((ref) => q.expected.files.includes(ref.path));
  const symbolHit = r.refs.some((ref) => ref.endLine - ref.startLine < MAX_PRECISE_LINES && targets.some((t) => overlaps(ref, t)));
  const firstHit = !!r.refs[0] && q.expected.files.includes(r.refs[0].path);
  const valid = r.invalidCitations.length === 0 && r.refs.length > 0;
  const ok = symbolHit && valid;
  if (ok) passed++;
  if (fileHit) fileHits++;
  if (firstHit) top1++;

  console.log(`${ok ? "PASS" : "FAIL"}  ${q.question}  (${ms} ms, ${r.toolCalls.length} tool calls${r.fallback ? ", fallback" : ""})`);
  console.log(`      cited: ${r.refs.slice(0, 5).map((x) => `${x.path}:${x.startLine}-${x.endLine}`).join(", ") || "nothing"}`);
  if (!symbolHit) console.log(`      ✗ no precise citation overlaps ${q.expected.symbols.join(" / ")}`);
  if (!valid) console.log(`      ✗ invalid citations: ${r.invalidCitations.join(", ") || "(none cited)"}`);
}

const n = dataset.questions.length;
console.log(`\n${passed}/${n} questions cite the right code with valid citations`);
console.log(`file recall ${fileHits}/${n} · first citation in an expected file ${top1}/${n} · avg ${Math.round(totalMs / n)} ms · total cost $${totalCost.toFixed(4)}`);
await prisma.$disconnect();
process.exit(passed === n ? 0 : 1);

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explainWhy, findCitations, loadCitationIndex, type WhyTarget } from "@archaeo/agent";
import { prisma } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { repoCloneDir } from "@archaeo/shared/env";
import { requireReadyRepo } from "./repo";

interface Question {
  id: string;
  question: string;
  target: WhyTarget;
  expected: { introducedSha: string; prNumbers: number[]; facts: string[] };
}

const dataset = JSON.parse(readFileSync(join(import.meta.dirname, "..", "datasets", "history.json"), "utf8")) as { repo: string; questions: Question[] };

const repo = await requireReadyRepo(dataset.repo);
const models = configureModels();
const index = await loadCitationIndex(prisma, repo.id);
const dir = repoCloneDir(repo.owner, repo.name);

let passed = 0;
for (const q of dataset.questions) {
  const r = await explainWhy({ prisma, models, repoId: repo.id, repoDir: dir }, q.target);
  const cited = findCitations(r.answer);
  const checks: [string, boolean][] = [
    [`introducing commit is ${q.expected.introducedSha.slice(0, 7)}`, r.introduced.sha.startsWith(q.expected.introducedSha)],
    ...q.expected.prNumbers.map((n): [string, boolean] => [`linked to PR #${n}`, r.introduced.prNumbers.includes(n)]),
    [`answer cites ${q.expected.introducedSha.slice(0, 7)}`, cited.shas.some((s) => q.expected.introducedSha.startsWith(s) || s.startsWith(q.expected.introducedSha))],
    ...q.expected.prNumbers.map((n): [string, boolean] => [`answer cites #${n}`, cited.numbers.includes(n)]),
    ["every cited SHA exists", cited.shas.every((s) => index.resolveSha(s) !== null)],
    ["every cited PR/issue exists", cited.numbers.every((n) => index.hasNumber(n))],
  ];
  const ok = checks.every(([, pass]) => pass);
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${q.question}`);
  console.log(`      introduced ${r.introduced.shortSha} ${r.introduced.date} "${r.introduced.subject}"${r.introduced.prNumbers.length ? ` (PR #${r.introduced.prNumbers.join(", #")})` : ""}`);
  for (const [label, pass] of checks) if (!pass) console.log(`      ✗ ${label}`);
}

console.log(`\n${passed}/${dataset.questions.length} history questions answered with valid citations`);
await prisma.$disconnect();
process.exit(passed === dataset.questions.length ? 0 : 1);

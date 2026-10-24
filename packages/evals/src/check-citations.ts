import "@archaeo/shared/load-env";
import { findCitations, loadCitationIndex } from "@archaeo/agent";
import { prisma } from "@archaeo/db";

/** Fails if any stored era title or narrative cites a SHA or PR/issue number that doesn't exist in its repo. */
const repos = await prisma.repo.findMany({ where: { status: "ready" } });
let checked = 0;
let shas = 0;
let numbers = 0;
const problems: string[] = [];

for (const repo of repos) {
  const index = await loadCitationIndex(prisma, repo.id);
  const eras = await prisma.era.findMany({ where: { repoId: repo.id }, orderBy: { startDate: "asc" } });
  for (const era of eras) {
    const cited = findCitations(`${era.title}\n${era.narrative ?? ""}`);
    checked++;
    shas += cited.shas.length;
    numbers += cited.numbers.length;
    for (const s of cited.shas) if (!index.resolveSha(s)) problems.push(`${repo.owner}/${repo.name} era "${era.title}": unknown commit ${s}`);
    for (const n of cited.numbers) if (!index.hasNumber(n)) problems.push(`${repo.owner}/${repo.name} era "${era.title}": unknown PR/issue #${n}`);
  }
}

console.log(`Checked ${checked} era narratives in ${repos.length} repo(s): ${shas} commit citations, ${numbers} PR/issue citations.`);
for (const p of problems) console.log(`✗ ${p}`);
console.log(problems.length ? `${problems.length} invalid citations` : "All citations exist.");
await prisma.$disconnect();
process.exit(problems.length ? 1 : 0);

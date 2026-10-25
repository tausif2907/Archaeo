import { prisma } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { CostMeter, flag, loadDataset, pct } from "./common";
import { requireReadyRepo } from "./repo";
import { evalQa, type QaQuestion } from "./suites";

/** `pnpm eval:qa [--repo got]`: one suite, printed to the console. `pnpm eval` runs everything. */
const dataset = await loadDataset<{ questions: QaQuestion[] }>(flag("repo", "click")!, "qa");
if (!dataset) throw new Error("No Q&A dataset for that repo");
const repo = await requireReadyRepo(dataset.repo);
const meter = new CostMeter();
const result = await evalQa(repo, dataset.questions, { models: configureModels({ recorder: meter }), meter, log: console.log });
for (const i of result.items) {
  console.log(`  ${i.id}: ${i.detail}`);
  for (const f of i.failures) console.log(`    ✗ ${f}`);
}
for (const s of result.scores) console.log(`${s.label}: ${pct(s)}`);
await prisma.$disconnect();
process.exit(result.items.every((i) => i.ok) ? 0 : 1);

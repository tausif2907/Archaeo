import { prisma } from "@archaeo/db";
import { configureModels } from "@archaeo/models";
import { CostMeter, flag, loadDataset, pct } from "./common";
import { requireReadyRepo } from "./repo";
import { evalHistory, type HistoryQuestion } from "./suites";

/** `pnpm eval:history [--repo got]`: one suite, printed to the console. `pnpm eval` runs everything. */
const dataset = await loadDataset<{ questions: HistoryQuestion[] }>(flag("repo", "click")!, "history");
if (!dataset) throw new Error("No history dataset for that repo");
const repo = await requireReadyRepo(dataset.repo);
const meter = new CostMeter();
const result = await evalHistory(repo, dataset.questions, { models: configureModels({ recorder: meter }), meter, log: console.log });
for (const i of result.items) for (const f of i.failures) console.log(`  ${i.id}: ✗ ${f}`);
for (const s of result.scores) console.log(`${s.label}: ${pct(s)}`);
await prisma.$disconnect();
process.exit(result.items.every((i) => i.ok) ? 0 : 1);

import "@archaeo/shared/load-env";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prisma } from "@archaeo/db";
import { configureModels, loadModelConfig, type ModelConfig } from "@archaeo/models";
import { exec } from "@archaeo/sandbox";
import { CostMeter, datasetRepos, flag, loadDataset, pct, type SuiteResult } from "./common";
import { evalBugs, evalHistory, evalQa, type Bug, type HistoryQuestion, type QaQuestion } from "./suites";

/**
 * `pnpm eval`: every suite (history, qa, bugs) for every repo with datasets, written to evals/REPORT.md.
 * Flags: --repo click, --suite history,qa, --no-fix (trace bugs without running the fixer).
 */
const REPORT = join(import.meta.dirname, "..", "..", "..", "evals", "REPORT.md");
const repos = flag("repo") ? [flag("repo")!] : datasetRepos();
const suites = (flag("suite") ?? "history,qa,bugs").split(",");
const fix = !process.argv.includes("--no-fix");

const config = loadModelConfig();
const meter = new CostMeter();
const models = configureModels({ recorder: meter });
const log = (line: string) => console.log(`  ${line}`);
const results: SuiteResult[] = [];
const skipped: string[] = [];
const heads: string[] = [];

for (const key of repos) {
  for (const suite of suites) {
    const dataset =
      suite === "history"
        ? await loadDataset<{ questions: HistoryQuestion[] }>(key, "history")
        : suite === "qa"
          ? await loadDataset<{ questions: QaQuestion[] }>(key, "qa")
          : await loadDataset<{ bugs: Bug[] }>(key, "bugs");
    if (!dataset) continue;
    const repo = await prisma.repo.findUnique({ where: { url: dataset.repo } });
    if (!repo || repo.status !== "ready") {
      skipped.push(`${key} ${suite}: ${dataset.repo} is not ingested (${repo?.status ?? "missing"})`);
      continue;
    }
    const head = `${repo.owner}/${repo.name} at \`${repo.headSha?.slice(0, 7)}\``;
    if (!heads.includes(head)) heads.push(head);

    console.log(`\n== ${repo.owner}/${repo.name}: ${suite}`);
    const deps = { models, meter, log };
    try {
      if ("questions" in dataset && suite === "history") results.push(await evalHistory(repo, dataset.questions as HistoryQuestion[], deps));
      else if ("questions" in dataset) results.push(await evalQa(repo, dataset.questions as QaQuestion[], deps));
      else results.push(await evalBugs(repo, dataset.bugs, deps, { fix }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  suite failed: ${message}`);
      results.push({ suite: suite as SuiteResult["suite"], repo: `${repo.owner}/${repo.name}`, items: [], scores: [], stats: [], notes: [`Suite failed: ${message}`] });
    }
  }
}

const archaeoHead = (await exec("git", ["-C", join(import.meta.dirname, ".."), "rev-parse", "--short", "HEAD"])).output.trim();
const markdown = renderReport(results, { config, archaeoHead, heads, skipped, fix });
await mkdir(dirname(REPORT), { recursive: true });
await writeFile(REPORT, markdown);
console.log(`\nWrote ${REPORT}`);
for (const r of results) for (const s of r.scores) console.log(`${r.repo} ${r.suite}: ${s.label}: ${pct(s)}`);
await prisma.$disconnect();

function renderReport(results: SuiteResult[], meta: { config: ModelConfig; archaeoHead: string; heads: string[]; skipped: string[]; fix: boolean }): string {
  const { config } = meta;
  const route = (task: keyof ModelConfig["tasks"]) => `\`${config.tasks[task].provider}/${config.tasks[task].model}\``;
  const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const runType = { history: "Why does this exist? (history)", qa: "Code Q&A", bugs: meta.fix ? "Bug trace + fix" : "Bug trace" };
  const out: string[] = [];

  out.push("# Archaeo eval report", "");
  out.push(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with \`pnpm eval\` (Archaeo \`${meta.archaeoHead}\`).`, "");
  out.push(`- **Repos:** ${meta.heads.join("; ") || "none"}`);
  out.push(`- **Models:** ${config.mode} mode. Reasoning ${route("reason")}, code writing ${route("writeCode")}, embeddings ${route("embed")}.`);
  out.push(`- **Datasets:** \`packages/evals/datasets/<repo>/\`. Ground truth comes from git history and reading the source, not from Archaeo.`);
  if (config.mode === "mock") {
    out.push("", "> **Mock mode.** No model API keys were configured, so every agent ran end to end against the offline stand-in model.");
    out.push("> These numbers measure retrieval, ranking, citation checking and the fallbacks, not answer quality. The fixer cannot");
    out.push("> write a working patch in mock mode. Set `MODEL_PROVIDER=live` and the API keys in `.env`, then rerun `pnpm eval`.");
  }
  for (const s of meta.skipped) out.push(`- Skipped: ${s}`);
  out.push("");

  out.push("## Summary", "", "| Repo | Suite | Metric | Result |", "|---|---|---|---|");
  for (const r of results) {
    if (!r.scores.length) out.push(`| ${r.repo} | ${r.suite} | ${r.notes[0] ?? "no result"} | |`);
    for (const s of r.scores) out.push(`| ${r.repo} | ${r.suite} | ${s.label} | ${pct(s)} |`);
  }
  out.push("");

  out.push("## Cost and latency per run type", "", "| Repo | Run type | Runs | Avg latency | Avg model calls | Avg cost |", "|---|---|---|---|---|---|");
  for (const r of results) {
    const n = r.items.length;
    if (!n) continue;
    const sum = (f: (i: SuiteResult["items"][number]) => number) => r.items.reduce((a, i) => a + f(i), 0);
    out.push(`| ${r.repo} | ${runType[r.suite]} | ${n} | ${ms(sum((i) => i.ms) / n)} | ${(sum((i) => i.calls) / n).toFixed(1)} | ${usd(sum((i) => i.cost) / n)} |`);
  }
  out.push("");
  if (config.mode === "mock") out.push("Costs are $0 in mock mode. Latency is real: retrieval, tool calls, git and the sandbox.", "");

  for (const r of results) {
    out.push(`## ${r.repo}: ${r.suite}`, "");
    for (const s of r.scores) out.push(`- ${s.label}: **${pct(s)}**`);
    for (const s of r.stats) out.push(`- ${s.label}: ${s.value}`);
    for (const n of r.notes) out.push(`- ${n}`);
    if (r.items.length) {
      out.push("", "| Item | Result | Latency | Detail |", "|---|---|---|---|");
      for (const i of r.items) out.push(`| ${i.id} | ${i.ok ? "pass" : "**fail**"} | ${ms(i.ms)} | ${i.detail.replace(/\|/g, "\\|")} |`);
      const failed = r.items.filter((i) => !i.ok);
      if (failed.length) {
        out.push("", "<details><summary>Why items failed</summary>", "");
        for (const i of failed) out.push(`- **${i.id}**: ${i.failures.join("; ").replace(/\|/g, "\\|")}`);
        out.push("", "</details>");
      }
    }
    out.push("");
  }
  return out.join("\n");
}

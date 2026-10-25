import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeRepoPath, type FixEnvironment } from "@archaeo/agent";
import type { CallRecorder, ModelCallRecord } from "@archaeo/models";
import type { SandboxSession } from "@archaeo/sandbox";

const DATASETS = join(import.meta.dirname, "..", "datasets");

/** Repos with eval datasets: the folder names under datasets/ (e.g. "click", "got"). */
export function datasetRepos(): string[] {
  return readdirSync(DATASETS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Loads datasets/<repo>/<name>.json, or null when that repo has no such dataset. */
export async function loadDataset<T>(repo: string, name: "history" | "qa" | "bugs"): Promise<({ repo: string; notes?: string } & T) | null> {
  const text = await readFile(join(DATASETS, repo, `${name}.json`), "utf8").catch(() => null);
  return text === null ? null : JSON.parse(text);
}

/** `--repo click` style CLI flag, or the default. */
export function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Counts model calls, cost and latency; `since()` gives the totals for one eval item. */
export class CostMeter implements CallRecorder {
  calls = 0;
  cost = 0;
  modelMs = 0;

  record(call: ModelCallRecord) {
    this.calls++;
    this.cost += call.cost;
    this.modelMs += call.latencyMs;
  }

  mark() {
    return { calls: this.calls, cost: this.cost };
  }

  since(mark: { calls: number; cost: number }) {
    return { calls: this.calls - mark.calls, cost: this.cost - mark.cost };
  }
}

export interface ItemResult {
  id: string;
  ok: boolean;
  ms: number;
  cost: number;
  calls: number;
  /** One line on what the item got, shown in the report */
  detail: string;
  failures: string[];
}

export interface Score {
  label: string;
  hits: number;
  total: number;
}

export interface SuiteResult {
  suite: "history" | "qa" | "bugs";
  repo: string;
  items: ItemResult[];
  scores: Score[];
  /** Extra averages, e.g. fixer attempts */
  stats: { label: string; value: string }[];
  notes: string[];
}

export const pct = (s: Score) => (s.total ? `${s.hits}/${s.total} (${Math.round((100 * s.hits) / s.total)}%)` : "n/a");

/** Wraps a sandbox session as the fixer's environment. */
export function sandboxEnv(session: SandboxSession): FixEnvironment {
  return {
    runTests: (f) => session.runTests(f),
    applyPatch: (d) => session.applyPatch(d),
    reset: () => session.reset(),
    readFile: async (p) => {
      const full = safeRepoPath(session.dir, p);
      return full ? await readFile(full, "utf8").catch(() => null) : null;
    },
    exists: async (p) => {
      const full = safeRepoPath(session.dir, p);
      return full ? (await stat(full).catch(() => null))?.isFile() === true : false;
    },
  };
}

import { INGEST_STAGES, type RepoCounts, type RepoStats, type RepoStatus, type StageProgress } from "@archaeo/shared";

/** Turns the repo's current stage plus live DB counts into a per-stage progress list. */
export function buildStages(repo: { status: RepoStatus; stage: string | null; stats: unknown }, counts: RepoCounts): StageProgress[] {
  const stats = (repo.stats as RepoStats | null) ?? {};
  const current = INGEST_STAGES.indexOf(repo.stage as (typeof INGEST_STAGES)[number]);
  const finished = repo.status === "ready" || repo.stage === "done";

  const totals: Record<(typeof INGEST_STAGES)[number], [number | null, number | null]> = {
    clone: [null, null],
    parse: [counts.files, null],
    history: [counts.commits, null],
    embed: [counts.embedded, counts.chunks],
    summarize: [counts.summarizedFiles + counts.summarizedCommits, stats.summarizeTotal ?? null],
  };

  return INGEST_STAGES.map((name, i) => {
    let state: StageProgress["state"] = "pending";
    if (finished || (current !== -1 && i < current)) state = "done";
    else if (i === current) state = repo.status === "failed" ? "failed" : "active";
    const [done, total] = totals[name];
    return { name, state, done, total: total === null ? null : Math.max(total, done ?? 0) };
  });
}

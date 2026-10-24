import type { CommitInfo } from "./git";

type LinkCommit = Pick<CommitInfo, "sha" | "parents" | "committedAt" | "message">;

const BASE = 1;
const BRANCH = 2;

/** Upper bound on commits attributed to one PR, so a malformed merge can't claim half the history. */
const MAX_BRANCH_COMMITS = 500;

/**
 * Commits reachable from `branchTip` but not from `base`, like `git rev-list base..branchTip`.
 * Uses git's date-ordered "paint" walk, so it only visits the region between the two sides.
 */
export function commitsBetween(base: string, branchTip: string, bySha: Map<string, LinkCommit>): string[] {
  const color = new Map<string, number>();
  const queue: LinkCommit[] = [];
  const push = (sha: string, c: number) => {
    const commit = bySha.get(sha);
    if (!commit) return;
    const prev = color.get(sha) ?? 0;
    if ((prev | c) === prev) return;
    color.set(sha, prev | c);
    if (prev === 0) queue.push(commit);
  };
  push(base, BASE);
  push(branchTip, BRANCH);

  const result: string[] = [];
  // Stop once every queued commit is already known to be reachable from the base.
  while (queue.some((c) => color.get(c.sha) === BRANCH)) {
    // Newest first
    let idx = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i]!.committedAt > queue[idx]!.committedAt) idx = i;
    const commit = queue.splice(idx, 1)[0]!;
    const c = color.get(commit.sha)!;
    if (c === BRANCH) {
      result.push(commit.sha);
      if (result.length >= MAX_BRANCH_COMMITS) break;
    }
    for (const p of commit.parents) push(p, c);
  }
  return result;
}

/** PR number → commits from its branch, for every `Merge pull request #N` merge commit in history. */
export function prBranchCommits(commits: LinkCommit[]): Map<number, string[]> {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out = new Map<number, string[]>();
  for (const c of commits) {
    if (c.parents.length !== 2) continue;
    const m = /^Merge pull request #(\d+)/.exec(c.message);
    if (!m) continue;
    out.set(Number(m[1]), commitsBetween(c.parents[0]!, c.parents[1]!, bySha));
  }
  return out;
}

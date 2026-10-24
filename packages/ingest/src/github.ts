import { Octokit } from "@octokit/rest";
import type { CommitInfo } from "./git";
import { prBranchCommits } from "./links";

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  updatedAt: Date;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  updatedAt: Date;
}

export function createOctokit(token?: string): Octokit {
  return new Octokit({ auth: token || undefined, userAgent: "archaeo" });
}

interface FetchOptions {
  /** Only items updated after this (incremental re-ingest) */
  since?: Date | null;
  max: number;
}

/** Merged PRs, most recently updated first. */
export async function fetchMergedPullRequests(octokit: Octokit, owner: string, repo: string, opts: FetchOptions): Promise<PullRequestInfo[]> {
  const out: PullRequestInfo[] = [];
  let scanned = 0;
  const pages = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  for await (const page of pages) {
    for (const pr of page.data) {
      const updatedAt = new Date(pr.updated_at);
      if (opts.since && updatedAt <= opts.since) return out;
      if (++scanned > opts.max) return out;
      if (!pr.merged_at) continue;
      out.push({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? null,
        mergedAt: new Date(pr.merged_at),
        mergeCommitSha: pr.merge_commit_sha ?? null,
        updatedAt,
      });
    }
  }
  return out;
}

/** Issues (not PRs), open and closed, most recently updated first. */
export async function fetchIssues(octokit: Octokit, owner: string, repo: string, opts: FetchOptions): Promise<IssueInfo[]> {
  const out: IssueInfo[] = [];
  const pages = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
    ...(opts.since ? { since: opts.since.toISOString() } : {}),
  });
  for await (const page of pages) {
    for (const issue of page.data) {
      if (issue.pull_request) continue;
      out.push({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state,
        labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        updatedAt: new Date(issue.updated_at),
      });
      if (out.length >= opts.max) return out;
    }
  }
  return out;
}

/** PR numbers a commit message points at: `Merge pull request #12` or a trailing `(#12)` on the subject (squash merges). */
export function prRefsInMessage(message: string): number[] {
  const subject = message.split("\n", 1)[0] ?? "";
  const refs = new Set<number>();
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  if (merge) refs.add(Number(merge[1]));
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) refs.add(Number(squash[1]));
  return [...refs];
}

/**
 * Maps PR number → commit SHAs in this repo's history: the merge commit SHA, commits whose message
 * references the PR, and every commit on the PR's branch for `Merge pull request #N` merges.
 */
export function linkPullRequests(
  prs: Pick<PullRequestInfo, "number" | "mergeCommitSha">[],
  commits: Pick<CommitInfo, "sha" | "message" | "parents" | "committedAt">[],
): Map<number, string[]> {
  const known = new Set(commits.map((c) => c.sha));
  const byNumber = new Map<number, Set<string>>();
  const add = (n: number, sha: string) => {
    let set = byNumber.get(n);
    if (!set) byNumber.set(n, (set = new Set()));
    set.add(sha);
  };
  for (const c of commits) for (const n of prRefsInMessage(c.message)) add(n, c.sha);
  for (const pr of prs) if (pr.mergeCommitSha && known.has(pr.mergeCommitSha)) add(pr.number, pr.mergeCommitSha);
  for (const [n, shas] of prBranchCommits(commits)) for (const sha of shas) add(n, sha);
  return new Map([...byNumber].map(([n, set]) => [n, [...set]]));
}

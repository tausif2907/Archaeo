import type { Octokit } from "@octokit/rest";
import type { PrismaClient } from "@archaeo/db";

export interface IssueRef {
  owner: string;
  name: string;
  number: number;
}

export interface IssueContext {
  number: number;
  title: string;
  url: string;
  body: string;
  comments: string[];
}

export function parseIssueUrl(url: string): IssueRef | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[#?].*)?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null;
}

const MAX_COMMENTS = 10;
const MAX_TEXT = 4000;

/** Issue title, body and first comments from GitHub; falls back to the ingested Issue row (no comments). */
export async function loadIssue(ref: IssueRef, deps: { octokit?: Octokit; prisma: PrismaClient; repoId: string }): Promise<IssueContext> {
  const url = `https://github.com/${ref.owner}/${ref.name}/issues/${ref.number}`;
  if (deps.octokit) {
    try {
      const issue = await deps.octokit.rest.issues.get({ owner: ref.owner, repo: ref.name, issue_number: ref.number });
      const comments = issue.data.comments
        ? (await deps.octokit.rest.issues.listComments({ owner: ref.owner, repo: ref.name, issue_number: ref.number, per_page: MAX_COMMENTS })).data
        : [];
      return {
        number: ref.number,
        title: issue.data.title,
        url: issue.data.html_url,
        body: (issue.data.body ?? "").slice(0, MAX_TEXT),
        comments: comments.map((c) => (c.body ?? "").slice(0, 1500)).filter(Boolean),
      };
    } catch {
      // rate limit / offline: use the stored copy below
    }
  }
  const stored = await deps.prisma.issue.findUnique({ where: { repoId_number: { repoId: deps.repoId, number: ref.number } } });
  if (!stored) throw new Error(`Issue #${ref.number} could not be fetched from GitHub and is not in the ingested data`);
  return { number: stored.number, title: stored.title, url, body: (stored.body ?? "").slice(0, MAX_TEXT), comments: [] };
}

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { exec } from "@archaeo/sandbox";
import type { BugReport, TestRunSummary } from "@archaeo/shared";
import { formatCodeRef } from "../present/code-refs";

export interface PrContent {
  title: string;
  body: string;
  commitMessage: string;
  branch: string;
}

export interface PublishInput {
  repo: { owner: string; name: string; defaultBranch: string };
  /** Local clone to build the commit from */
  repoDir: string;
  baseSha: string;
  patch: string;
  content: PrContent;
}

/** Pushes an approved patch and opens a PR. Only ever called from the approval endpoint. */
export interface Publisher {
  publish(input: PublishInput): Promise<{ prUrl: string; branch: string }>;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fix";
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]?.trim() ?? "";
}

/** PR title, body and commit message. Plain project prose: no AI co-author or attribution lines. */
export function buildPrContent(input: {
  report: BugReport;
  attempt: { patch: string; testSummary: string | null; regressionTest: boolean; reproduced: boolean | null };
  baseline: TestRunSummary | null;
  baseSha: string;
}): PrContent {
  const { report, attempt } = input;
  const subject = report.issue?.title ?? report.exception ?? firstLine(report.description) ?? "bug";
  const title = `Fix: ${subject.replace(/^fix(es|ed)?:?\s*/i, "")}`.slice(0, 72);
  const evidence = report.evidence.map((e) => `- \`${formatCodeRef(e.ref)}\`: ${e.why}`).join("\n");
  const regression = attempt.regressionTest
    ? attempt.reproduced === true
      ? "Adds a regression test that fails without this change and passes with it."
      : attempt.reproduced === false
        ? "Adds a test; note it also passes without the code change."
        : "Adds a regression test."
    : "No regression test added.";
  const body = [
    "## Summary",
    report.hypothesis,
    report.issue ? `\nUpstream issue: ${report.issue.url}` : "",
    evidence ? `\n## Evidence\n${evidence}` : "",
    "\n## Tests",
    `- Before: ${input.baseline?.summary ?? "not recorded"} (at ${input.baseSha.slice(0, 7)})`,
    `- After: ${attempt.testSummary ?? "not recorded"}`,
    `- ${regression}`,
  ]
    .filter(Boolean)
    .join("\n");
  const commitMessage = `${title}\n\n${report.hypothesis}${report.issue ? `\n\nRefs ${report.issue.url}` : ""}`;
  return { title, body, commitMessage, branch: `archaeo/${slug(subject)}-${randomBytes(3).toString("hex")}` };
}

/**
 * Publishes to a fork owned by the token's account (created if needed). With target "fork" the PR
 * opens inside the fork against a branch pinned at the base commit, so nothing reaches upstream.
 */
export class GitHubForkPublisher implements Publisher {
  constructor(
    private readonly opts: { token: string; target: "fork" | "upstream"; authorName?: string; authorEmail?: string; octokit?: Octokit },
  ) {}

  async publish(input: PublishInput): Promise<{ prUrl: string; branch: string }> {
    const octokit = this.opts.octokit ?? new Octokit({ auth: this.opts.token, userAgent: "archaeo" });
    const { owner, name } = input.repo;
    const me = (await octokit.rest.users.getAuthenticated()).data;
    const ownRepo = me.login.toLowerCase() === owner.toLowerCase();
    const forkOwner = ownRepo ? owner : me.login;
    if (!ownRepo) {
      await octokit.rest.repos.createFork({ owner, repo: name });
      for (let i = 0; ; i++) {
        try {
          await octokit.rest.repos.get({ owner: forkOwner, repo: name });
          break;
        } catch (err) {
          if (i >= 30) throw new Error(`Fork ${forkOwner}/${name} did not become available: ${err instanceof Error ? err.message : err}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    const { content } = input;
    const dir = await mkdtemp(join(tmpdir(), "archaeo-pr-"));
    await rm(dir, { recursive: true, force: true });
    const git = (...args: string[]) => exec("git", ["-C", dir, ...args]);
    const must = async (p: ReturnType<typeof git>, what: string) => {
      const r = await p;
      if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.output.replaceAll(this.opts.token, "***").trim().slice(-1500)}`);
      return r;
    };
    try {
      await must(exec("git", ["-C", input.repoDir, "worktree", "add", "--detach", dir, input.baseSha]), "git worktree add");
      const patchFile = join(dir, ".archaeo.patch");
      await writeFile(patchFile, input.patch);
      await must(git("apply", "--recount", "--whitespace=nowarn", patchFile), "git apply");
      await rm(patchFile);
      await must(git("add", "-A"), "git add");
      const author = this.opts.authorName ?? me.name ?? me.login;
      const email = this.opts.authorEmail ?? `${me.id}+${me.login}@users.noreply.github.com`;
      await must(git("-c", `user.name=${author}`, "-c", `user.email=${email}`, "commit", "-q", "-m", content.commitMessage), "git commit");

      const auth = Buffer.from(`x-access-token:${this.opts.token}`).toString("base64");
      const remote = `https://github.com/${forkOwner}/${name}.git`;
      const baseBranch = this.opts.target === "fork" ? `archaeo/base-${input.baseSha.slice(0, 7)}` : input.repo.defaultBranch;
      const refs = [...(this.opts.target === "fork" ? [`${input.baseSha}:refs/heads/${baseBranch}`] : []), `HEAD:refs/heads/${content.branch}`];
      await must(git("-c", `http.extraHeader=Authorization: Basic ${auth}`, "push", "--force", remote, ...refs), "git push");

      const pr =
        this.opts.target === "fork"
          ? await octokit.rest.pulls.create({ owner: forkOwner, repo: name, head: content.branch, base: baseBranch, title: content.title, body: content.body })
          : await octokit.rest.pulls.create({ owner, repo: name, head: `${forkOwner}:${content.branch}`, base: input.repo.defaultBranch, title: content.title, body: content.body });
      return { prUrl: pr.data.html_url, branch: content.branch };
    } finally {
      await exec("git", ["-C", input.repoDir, "worktree", "remove", "--force", dir]);
      await exec("git", ["-C", input.repoDir, "worktree", "prune"]);
      await rm(dir, { recursive: true, force: true });
    }
  }
}

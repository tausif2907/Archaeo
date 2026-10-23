import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";

export interface CloneResult {
  dir: string;
  headSha: string;
  defaultBranch: string;
}

/**
 * Full clone (history is needed for `git log --numstat`, so no shallow/blobless clone),
 * or fetch + hard reset to the remote default branch when the clone already exists.
 */
export async function cloneOrUpdate(url: string, dir: string): Promise<CloneResult> {
  if (existsSync(join(dir, ".git"))) {
    const git = simpleGit(dir);
    await git.fetch(["--prune", "--tags", "--force", "origin"]);
    await git.raw(["remote", "set-head", "origin", "--auto"]);
  } else {
    await mkdir(dirname(dir), { recursive: true });
    await simpleGit().clone(url, dir, ["--config", "core.autocrlf=false"]);
  }
  const git = simpleGit(dir);
  const defaultBranch = (await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
  await git.raw(["checkout", "--force", "-B", defaultBranch, `origin/${defaultBranch}`]);
  await git.raw(["clean", "-fdx"]);
  const headSha = (await git.revparse(["HEAD"])).trim();
  return { dir, headSha, defaultBranch };
}

export async function listTrackedFiles(dir: string): Promise<string[]> {
  const out = await simpleGit(dir).raw(["ls-files", "-z"]);
  return out.split("\0").filter(Boolean);
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  sha: string;
  author: string;
  date: Date;
  message: string;
  files: FileChange[];
}

const RECORD = "\x1e";
const FIELD = "\x1f";

export async function readGitLog(dir: string, maxCommits: number): Promise<CommitInfo[]> {
  const out = await simpleGit(dir).raw([
    "log",
    "--no-renames",
    "--numstat",
    `--max-count=${maxCommits}`,
    `--format=${"%x1e%H%x1f%an%x1f%aI%x1f%B%x1f"}`,
  ]);
  return parseGitLog(out);
}

/** Parses the `--format=%x1e%H%x1f%an%x1f%aI%x1f%B%x1f --numstat` output above. */
export function parseGitLog(text: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of text.split(RECORD)) {
    if (!record.trim()) continue;
    const [sha, author, date, message, stats = ""] = record.split(FIELD);
    if (!sha || !date) continue;
    const files: FileChange[] = [];
    for (const row of stats.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row.trim());
      if (!m) continue;
      files.push({ path: m[3]!, additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) });
    }
    commits.push({ sha: sha.trim(), author: author ?? "", date: new Date(date), message: (message ?? "").trim(), files });
  }
  return commits;
}

/** Number of commits touching each path. */
export function computeChurn(commits: CommitInfo[]): Map<string, number> {
  const churn = new Map<string, number>();
  for (const c of commits) for (const f of c.files) churn.set(f.path, (churn.get(f.path) ?? 0) + 1);
  return churn;
}

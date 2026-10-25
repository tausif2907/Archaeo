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
  /** Author date */
  date: Date;
  /** Committer date: follows topology better than author date after rebases */
  committedAt: Date;
  parents: string[];
  message: string;
  files: FileChange[];
}

const RECORD = "\x1e";
const FIELD = "\x1f";

export const LOG_FORMAT = "%x1e%H%x1f%an%x1f%aI%x1f%cI%x1f%P%x1f%B%x1f";

export async function readGitLog(dir: string, maxCommits: number): Promise<CommitInfo[]> {
  const out = await simpleGit(dir).raw(["log", "--no-renames", "--numstat", `--max-count=${maxCommits}`, `--format=${LOG_FORMAT}`]);
  return parseGitLog(out);
}

/** Parses `git log --format=LOG_FORMAT [--numstat]` output. */
export function parseGitLog(text: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of text.split(RECORD)) {
    if (!record.trim()) continue;
    const [sha, author, date, committed, parents = "", message, stats = ""] = record.split(FIELD);
    if (!sha || !date) continue;
    const files: FileChange[] = [];
    for (const row of stats.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row.trim());
      if (!m) continue;
      files.push({ path: m[3]!, additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) });
    }
    commits.push({
      sha: sha.trim(),
      author: author ?? "",
      date: new Date(date),
      committedAt: new Date(committed || date),
      parents: parents.split(" ").filter(Boolean),
      message: (message ?? "").trim(),
      files,
    });
  }
  return commits;
}

/** Number of commits touching each path. */
export function computeChurn(commits: CommitInfo[]): Map<string, number> {
  const churn = new Map<string, number>();
  for (const c of commits) for (const f of c.files) churn.set(f.path, (churn.get(f.path) ?? 0) + 1);
  return churn;
}

export interface TagInfo {
  name: string;
  date: Date;
}

export async function readTags(dir: string): Promise<TagInfo[]> {
  const out = await simpleGit(dir).raw(["for-each-ref", "refs/tags", "--format=%(refname:short)%09%(creatordate:iso-strict)"]);
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([name, date]) => ({ name, date: new Date(date) }))
    .filter((t) => !Number.isNaN(t.date.getTime()));
}

/** Release tags marking a major or minor version: `1.2`, `v1.2.0`, not pre-releases, patches or branch tags like `1.x`. */
export function releaseTags(tags: TagInfo[]): TagInfo[] {
  return tags.filter((t) => /^v?\d+\.\d+(\.0)?$/.test(t.name)).sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Commits touching a file, newest first, following renames. `files` holds that file's own line counts. */
export async function fileHistory(dir: string, path: string, max = 300): Promise<CommitInfo[]> {
  const out = await simpleGit(dir).raw(["log", "--follow", "--numstat", `--max-count=${max}`, `--format=${LOG_FORMAT}`, "--", path]);
  return parseGitLog(out);
}

/** Commits that touched a line range (e.g. a symbol), newest first. */
export async function lineHistory(dir: string, path: string, startLine: number, endLine: number, max = 1000): Promise<CommitInfo[]> {
  const out = await simpleGit(dir).raw(["log", "-s", `--max-count=${max}`, `--format=${LOG_FORMAT}`, "-L", `${startLine},${endLine}:${path}`]);
  return parseGitLog(out);
}

/** The oldest commit that changed how often `text` occurs in the file (following renames): when it was first added. */
export async function firstAddedIn(dir: string, path: string, text: string): Promise<string | null> {
  const out = await simpleGit(dir).raw(["log", "--follow", "--format=%H", "-S", text, "--", path]);
  return out.trim().split("\n").filter(Boolean).pop() ?? null;
}

export interface BlameShare {
  sha: string;
  author: string;
  date: Date;
  summary: string;
  lines: number;
}

export async function blame(dir: string, path: string, startLine?: number, endLine?: number): Promise<BlameShare[]> {
  const range = startLine && endLine ? ["-L", `${startLine},${endLine}`] : [];
  const out = await simpleGit(dir).raw(["blame", "--line-porcelain", "-w", "-M", ...range, "--", path]);
  return parseBlame(out);
}

/** Aggregates `git blame --line-porcelain` output into lines per commit, most lines first. */
export function parseBlame(text: string): BlameShare[] {
  const byCommit = new Map<string, BlameShare>();
  let current: BlameShare | null = null;
  for (const line of text.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) {
      const sha = header[1]!;
      current = byCommit.get(sha) ?? { sha, author: "", date: new Date(0), summary: "", lines: 0 };
      byCommit.set(sha, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice(7);
    else if (line.startsWith("author-time ")) current.date = new Date(Number(line.slice(12)) * 1000);
    else if (line.startsWith("summary ")) current.summary = line.slice(8);
    else if (line.startsWith("\t")) current.lines++;
  }
  return [...byCommit.values()].sort((a, b) => b.lines - a.lines);
}

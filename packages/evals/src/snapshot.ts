import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient, Repo } from "@archaeo/db";
import { embedPendingChunks, indexCode, listTrackedFiles, scanSourceFiles } from "@archaeo/ingest";
import type { Models } from "@archaeo/models";
import { exec } from "@archaeo/sandbox";

/** Snapshot repos use this URL suffix; the API leaves them out of the repo list. */
export const SNAPSHOT_MARK = "#eval@";

/**
 * Indexes the repo as it was at `sha` (files, symbols, call graph, embeddings) into a temporary repo row,
 * so a historical bug is traced against code that does not contain its fix yet. Removed afterwards.
 */
export async function withSnapshot<T>(
  deps: { prisma: PrismaClient; models: Pick<Models, "embed"> },
  repo: Repo,
  repoDir: string,
  sha: string,
  fn: (snap: { repoId: string; dir: string }) => Promise<T>,
): Promise<T> {
  const { prisma } = deps;
  const url = `${repo.url}${SNAPSHOT_MARK}${sha}`;
  await prisma.repo.deleteMany({ where: { url } }); // left over from an interrupted run

  const dir = await mkdtemp(join(tmpdir(), "archaeo-snap-"));
  await rm(dir, { recursive: true, force: true });
  const add = await exec("git", ["-C", repoDir, "worktree", "add", "--detach", dir, sha]);
  if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.output.trim()}`);

  const snap = await prisma.repo.create({
    data: { url, owner: repo.owner, name: `${repo.name}@${sha.slice(0, 7)}`, status: "ingesting", headSha: sha, language: repo.language },
  });
  const log = () => {};
  try {
    const sources = await scanSourceFiles(dir, await listTrackedFiles(dir), { maxLoc: 200_000 });
    await indexCode({ prisma, log }, snap.id, sources, true);
    await embedPendingChunks({ prisma, models: deps.models, log }, snap.id);
    return await fn({ repoId: snap.id, dir });
  } finally {
    await prisma.repo.delete({ where: { id: snap.id } }).catch(() => {});
    await exec("git", ["-C", repoDir, "worktree", "remove", "--force", dir]);
    await exec("git", ["-C", repoDir, "worktree", "prune"]);
  }
}

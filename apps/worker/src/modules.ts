import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";

const FOLDER_INSTRUCTION =
  "You summarize a folder of a codebase for a developer new to it. From the summaries of its files and subfolders, say in 1-2 sentences what this folder is responsible for. No preamble.";
const OVERVIEW_INSTRUCTION =
  "You write the overview of a code repository for a developer new to it. From the summaries of its top-level folders and files, say in 2-3 sentences what the project does and how the code is organized. No preamble.";
const MAX_CHILD_CHARS = 6000;

function parentOf(path: string): string | null {
  if (path === "") return null;
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/**
 * Bottom-up summaries: files → folders → repo overview (path ""). Every folder that contains source
 * files, directly or below, gets a Module row. Summaries are reused while their inputs are unchanged.
 */
export async function summarizeModules(repoId: string, prisma: PrismaClient, models: Pick<Models, "summarizeCheap">, repoName: string): Promise<number> {
  const files = await prisma.file.findMany({ where: { repoId }, select: { path: true, summary: true }, orderBy: { path: "asc" } });

  const folders = new Set<string>([""]);
  for (const f of files) for (let d = parentOf(f.path); d !== null; d = parentOf(d)) folders.add(d);

  const filesIn = new Map<string, typeof files>();
  for (const f of files) {
    const dir = parentOf(f.path)!;
    filesIn.set(dir, [...(filesIn.get(dir) ?? []), f]);
  }
  const subfoldersIn = new Map<string, string[]>();
  for (const d of folders) {
    const p = parentOf(d);
    if (p !== null) subfoldersIn.set(p, [...(subfoldersIn.get(p) ?? []), d]);
  }

  const existing = new Map((await prisma.module.findMany({ where: { repoId } })).map((m) => [m.path, m]));
  const summaries = new Map<string, string | null>();
  let written = 0;

  // Deepest folders first, so each folder sees its subfolders' summaries.
  const ordered = [...folders].sort((a, b) => b.split("/").length - a.split("/").length || (b === "" ? -1 : a === "" ? 1 : a.localeCompare(b)));
  for (const dir of ordered) {
    const lines = [
      ...(subfoldersIn.get(dir) ?? []).sort().map((d) => `- ${posix.basename(d)}/: ${summaries.get(d) ?? "(no summary)"}`),
      ...(filesIn.get(dir) ?? []).map((f) => `- ${posix.basename(f.path)}: ${f.summary ?? "(no summary)"}`),
    ];
    const childText = lines.join("\n").slice(0, MAX_CHILD_CHARS);
    const fingerprint = createHash("sha1").update(childText).digest("hex");
    const prev = existing.get(dir);

    let summary = prev?.fingerprint === fingerprint ? prev.summary : null;
    if (summary === null) {
      summary =
        dir === ""
          ? await models.summarizeCheap({ instruction: OVERVIEW_INSTRUCTION, text: `Repository: ${repoName}\n${childText}`, maxWords: 80 })
          : await models.summarizeCheap({ instruction: FOLDER_INSTRUCTION, text: `Folder: ${dir}/\n${childText}`, maxWords: 50 });
      written++;
    }
    summaries.set(dir, summary);
    await prisma.module.upsert({
      where: { repoId_path: { repoId, path: dir } },
      create: { repoId, path: dir, parentPath: parentOf(dir), summary, fingerprint },
      update: { parentPath: parentOf(dir), summary, fingerprint },
    });
  }
  await prisma.module.deleteMany({ where: { repoId, path: { notIn: [...folders] } } });
  return written;
}

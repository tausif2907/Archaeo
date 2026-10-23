import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectLanguage } from "./languages";
import type { SourceFile } from "./types";

export class RepoTooLargeError extends Error {
  constructor(
    readonly loc: number,
    readonly maxLoc: number,
  ) {
    super(`Repository has more than ${maxLoc.toLocaleString("en-US")} lines of source code (counted ${loc.toLocaleString("en-US")}+). Archaeo caps ingest at ${maxLoc.toLocaleString("en-US")} LOC.`);
    this.name = "RepoTooLargeError";
  }
}

export interface ScanOptions {
  maxLoc: number;
  /** Larger files are almost always generated or vendored */
  maxFileBytes?: number;
}

export function countLoc(content: string): number {
  let loc = 0;
  for (const line of content.split("\n")) if (line.trim()) loc++;
  return loc;
}

export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Reads every tracked source file we can parse. Throws RepoTooLargeError once the LOC cap is exceeded. */
export async function scanSourceFiles(dir: string, trackedPaths: string[], opts: ScanOptions): Promise<SourceFile[]> {
  const maxBytes = opts.maxFileBytes ?? 512 * 1024;
  const files: SourceFile[] = [];
  let total = 0;
  for (const path of trackedPaths) {
    const lang = detectLanguage(path);
    if (!lang) continue;
    const full = join(dir, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > maxBytes) continue;
    const content = await readFile(full, "utf8");
    const loc = countLoc(content);
    total += loc;
    if (total > opts.maxLoc) throw new RepoTooLargeError(total, opts.maxLoc);
    files.push({ path, language: lang.language, content, hash: hashContent(content), loc });
  }
  return files;
}

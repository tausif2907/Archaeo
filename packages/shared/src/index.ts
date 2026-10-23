import { z } from "zod";

export const RepoStatus = z.enum(["queued", "ingesting", "ready", "failed"]);
export type RepoStatus = z.infer<typeof RepoStatus>;

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export interface GitHubRepoRef {
  owner: string;
  name: string;
  /** Canonical https URL without trailing .git */
  url: string;
}

/** Parses `https://github.com/owner/name(.git)` into its parts, or returns null. */
export function parseGitHubUrl(input: string): GitHubRepoRef | null {
  const match = GITHUB_URL.exec(input.trim());
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

export const CreateRepoInput = z.object({
  url: z
    .string()
    .min(1)
    .refine((u) => parseGitHubUrl(u) !== null, { message: "Must be a GitHub repository URL" }),
});
export type CreateRepoInput = z.infer<typeof CreateRepoInput>;

export const RepoDto = z.object({
  id: z.string(),
  url: z.string(),
  owner: z.string(),
  name: z.string(),
  status: RepoStatus,
  statusMessage: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  language: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepoDto = z.infer<typeof RepoDto>;

export const QUEUES = {
  ingest: "ingest",
} as const;

export interface IngestJobData {
  repoId: string;
}

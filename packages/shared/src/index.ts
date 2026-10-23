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

export const INGEST_STAGES = ["clone", "parse", "history", "embed", "summarize"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

export const RepoDto = z.object({
  id: z.string(),
  url: z.string(),
  owner: z.string(),
  name: z.string(),
  status: RepoStatus,
  stage: z.string().nullable(),
  statusMessage: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  language: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepoDto = z.infer<typeof RepoDto>;

export const RepoCounts = z.object({
  files: z.number(),
  loc: z.number(),
  symbols: z.number(),
  importEdges: z.number(),
  callEdges: z.number(),
  commits: z.number(),
  pullRequests: z.number(),
  issues: z.number(),
  chunks: z.number(),
  embedded: z.number(),
  summarizedFiles: z.number(),
  summarizedCommits: z.number(),
});
export type RepoCounts = z.infer<typeof RepoCounts>;

export const StageProgress = z.object({
  name: z.enum(INGEST_STAGES),
  state: z.enum(["pending", "active", "done", "failed"]),
  done: z.number().nullable(),
  total: z.number().nullable(),
});
export type StageProgress = z.infer<typeof StageProgress>;

export const RepoProgressDto = z.object({
  repo: RepoDto,
  stages: z.array(StageProgress),
  counts: RepoCounts,
});
export type RepoProgressDto = z.infer<typeof RepoProgressDto>;

/** Shape of Repo.stats (JSON column) */
export interface RepoStats {
  /** Files + commits queued for summarizeCheap on the last run */
  summarizeTotal?: number;
  /** Non-fatal problems from the last run (e.g. GitHub rate limit) */
  warnings?: string[];
  counts?: RepoCounts;
  durationsMs?: Partial<Record<IngestStage, number>>;
}

export const QUEUES = {
  /** Jobs: "ingest" (the pipeline) and "finalize" (flow parent that marks the repo ready) */
  ingest: "ingest",
  summarize: "summarize",
} as const;

export interface IngestJobData {
  repoId: string;
}

export interface SummarizeJobData {
  repoId: string;
  kind: "file" | "commit";
  ids: string[];
}

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
  /** Parser/chunker version the code index was built with */
  indexVersion?: number;
}

export const QUEUES = {
  /** Jobs: "ingest" (the pipeline) and "finalize" (flow parent that marks the repo ready) */
  ingest: "ingest",
  summarize: "summarize",
  eras: "eras",
} as const;

export interface ErasJobData {
  repoId: string;
  /** Rewrite narratives even when an era's evidence is unchanged */
  force?: boolean;
}

// ---------------------------------------------------------------- The Past

export interface EraStats {
  commits: number;
  contributors: number;
  topAuthors: { name: string; commits: number }[];
  topAreas: { area: string; percent: number }[];
  releases: string[];
  /** Narrative was assembled from evidence because model output was unusable */
  fallback: boolean;
}

export interface EraDto {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  narrative: string | null;
  stats: EraStats | null;
  keyCommits: { sha: string; shortSha: string; subject: string; author: string; date: string }[];
  keyPrs: { number: number; title: string; mergedAt: string | null }[];
}

export interface ErasResponse {
  /** pending | running | ready | failed | null (never generated) */
  status: string | null;
  message: string | null;
  eras: EraDto[];
}

export const WhyInput = z
  .object({
    path: z.string().min(1).max(500),
    symbol: z.string().min(1).max(300).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .refine((v) => (v.startLine === undefined) === (v.endLine === undefined), { message: "startLine and endLine go together" });
export type WhyInput = z.infer<typeof WhyInput>;

export interface WhyCommit {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  subject: string;
  linesChanged: number | null;
  prNumbers: number[];
}

export interface WhyResult {
  target: { path: string; symbol: string | null; startLine: number | null; endLine: number | null };
  totalCommits: number;
  introduced: WhyCommit;
  latest: WhyCommit;
  majorChanges: WhyCommit[];
  blame: { sha: string; shortSha: string; author: string; date: string; summary: string; lines: number; percent: number }[];
  pullRequests: { number: number; title: string; mergedAt: string | null; excerpt: string }[];
  /** Markdown with citations like [abc1234] and [#123] */
  answer: string;
  fallback: boolean;
  invalidCitations: string[];
}

// ---------------------------------------------------------------- The Present

export interface CodeRef {
  path: string;
  startLine: number;
  endLine: number;
}

export type AgentLimitReason = "tool_calls" | "time" | "cost";

export interface AskResult {
  status: "succeeded" | "limited" | "failed";
  /** Markdown with citations like [src/app.py:10-30] */
  answer: string;
  refs: CodeRef[];
  /** Answer assembled from retrieved code because model output had no valid citation */
  fallback: boolean;
  invalidCitations: string[];
  limitReason: AgentLimitReason | null;
  toolCalls: { name: string; summary: string; ms: number }[];
  costUsd: number;
  steps: number;
}

/** Server-sent events streamed while the agent works. */
export type AgentEvent =
  | { type: "run"; runId: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; summary: string; refs: CodeRef[] }
  | { type: "limit"; reason: AgentLimitReason; message: string }
  | { type: "answer"; result: AskResult }
  | { type: "error"; message: string };

export const AskInput = z.object({ question: z.string().trim().min(3).max(2000) });
export type AskInput = z.infer<typeof AskInput>;

export const FlowInput = z.object({ symbol: z.string().trim().min(1).max(300), path: z.string().max(500).optional() });
export type FlowInput = z.infer<typeof FlowInput>;

export interface FlowHop {
  step: number;
  depth: number;
  parentStep: number | null;
  qualifiedName: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Line in the parent where this hop is first called */
  callLine: number | null;
  explanation: string;
}

export interface FlowTrace {
  entry: string;
  entryPath: string;
  hops: FlowHop[];
  /** Explanations came from docstrings because model output was unusable */
  fallback: boolean;
  /** Stopped at the hop limit */
  truncated: boolean;
}

export interface MapFile {
  path: string;
  folder: string;
  language: string | null;
  loc: number;
  churn: number;
  complexity: number;
  summary: string | null;
}

export interface MapModule {
  path: string;
  parentPath: string | null;
  summary: string | null;
}

export interface MapData {
  overview: string | null;
  modules: MapModule[];
  files: MapFile[];
  /** File-level import edges; the client aggregates them to whatever folders are expanded */
  edges: { from: string; to: string }[];
}

export interface CodeFile {
  path: string;
  language: string | null;
  lines: string[];
  totalLines: number;
  truncated: boolean;
}

export interface SymbolHit {
  qualifiedName: string;
  kind: string;
  path: string;
  startLine: number;
}

export interface FileEntry {
  path: string;
  language: string | null;
  loc: number;
}

export interface SymbolEntry {
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface IngestJobData {
  repoId: string;
}

export interface SummarizeJobData {
  repoId: string;
  kind: "file" | "commit";
  ids: string[];
}

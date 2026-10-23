import { isAbsolute, join } from "node:path";
import { findRepoRoot } from "@archaeo/shared/env";

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface IngestConfig {
  workspaceDir: string;
  maxLoc: number;
  maxCommits: number;
  maxPullRequests: number;
  maxIssues: number;
  /** Only the most recent N commits get an LLM summary */
  summarizeMaxCommits: number;
  summarizeBatchSize: number;
  embedBatchSize: number;
  githubToken?: string;
}

export function loadIngestConfig(): IngestConfig {
  const ws = process.env.WORKSPACE_DIR || ".workspace";
  return {
    workspaceDir: isAbsolute(ws) ? ws : join(findRepoRoot(), ws),
    maxLoc: num("INGEST_MAX_LOC", 200_000),
    maxCommits: num("INGEST_MAX_COMMITS", 20_000),
    maxPullRequests: num("INGEST_MAX_PRS", 3_000),
    maxIssues: num("INGEST_MAX_ISSUES", 3_000),
    summarizeMaxCommits: num("SUMMARIZE_MAX_COMMITS", 1_000),
    summarizeBatchSize: num("SUMMARIZE_BATCH_SIZE", 25),
    embedBatchSize: num("EMBED_BATCH_SIZE", 64),
    githubToken: process.env.GITHUB_TOKEN || undefined,
  };
}

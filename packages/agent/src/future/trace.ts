import { readFile } from "node:fs/promises";
import type { Octokit } from "@octokit/rest";
import type { PrismaClient } from "@archaeo/db";
import { isTestPath } from "@archaeo/ingest";
import type { Models } from "@archaeo/models";
import type { BugReport, CodeRef, TraceEvent, TraceInput } from "@archaeo/shared";
import { parseJsonObject } from "../past/json";
import { formatCodeRef, parseCodeRef } from "../present/code-refs";
import type { AgentLimits } from "../present/limits";
import { runLoop } from "../present/loop";
import { CODE_TOOLS, safeRepoPath } from "../present/tools";
import { loadIssue, parseIssueUrl, type IssueContext } from "./issue";
import { mapFrames, parseStackTrace } from "./stack";
import { rankSuspects } from "./suspects";

export interface TraceDeps {
  prisma: PrismaClient;
  models: Pick<Models, "reason" | "embed">;
  repoId: string;
  repoDir: string;
  repoName: string;
  octokit?: Octokit;
}

export interface TraceOptions {
  limits: AgentLimits;
  onEvent?: (e: TraceEvent) => void;
  runId?: string;
  signal?: AbortSignal;
}

const CONFIDENCE = new Set(["low", "medium", "high"]);

function systemPrompt(repoName: string): string {
  return `You are debugging the ${repoName} codebase. Find the root cause of the reported bug.
Start from the ranked suspects, confirm with read_file, follow callers/callees, and check history with git_blame when useful.
Finish with JSON only:
{"hypothesis": "2-4 sentences: what goes wrong and why", "confidence": "low|medium|high",
 "evidence": [{"ref": "path:start-end", "why": "what these lines show"}],
 "filesToChange": ["path", ...]}
Only cite lines you have seen. Prefer the smallest set of files that fixes the root cause.`;
}

/** Bug tracer: stack trace and/or issue → ranked suspects → agent investigation → structured report. */
export async function traceBug(deps: TraceDeps, input: TraceInput, opts: TraceOptions): Promise<BugReport> {
  const { prisma, repoId } = deps;

  let issue: IssueContext | null = null;
  if (input.issueUrl) {
    const ref = parseIssueUrl(input.issueUrl);
    if (!ref) throw new Error(`Not a GitHub issue URL: ${input.issueUrl}`);
    issue = await loadIssue(ref, { octokit: deps.octokit, prisma, repoId });
  }
  const description = [input.text.trim(), issue && `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`, ...(issue?.comments.map((c, i) => `Comment ${i + 1}:\n${c}`) ?? [])]
    .filter(Boolean)
    .join("\n\n");

  const parsed = parseStackTrace(description);
  const repoPaths = (await prisma.file.findMany({ where: { repoId }, select: { path: true } })).map((f) => f.path);
  const frames = mapFrames(parsed.frames, repoPaths);
  const ctx = { prisma, models: deps.models, repoId, repoDir: deps.repoDir };
  const suspects = await rankSuspects(ctx, { frames, text: description, exception: parsed.exception });

  const suspectList = suspects.map((s, i) => `${i + 1}. ${formatCodeRef(s)} ${s.symbol ?? ""} (score ${s.score}): ${s.reasons.join("; ")}`).join("\n");
  const frameList = frames.map((f) => `- ${f.path ?? `${f.rawPath} (outside repo)`}:${f.line}${f.func ? ` in ${f.func}` : ""}`).join("\n");
  const loop = await runLoop({
    models: deps.models,
    tools: CODE_TOOLS,
    ctx,
    messages: [
      { role: "system", content: systemPrompt(deps.repoName) },
      {
        role: "user",
        content: `Bug report:\n${description.slice(0, 6000)}\n\n${parsed.exception ? `Exception: ${parsed.exception}\n\n` : ""}${frames.length ? `Stack frames (innermost first):\n${frameList}\n\n` : ""}Ranked suspects:\n${suspectList || "(none)"}`,
      },
    ],
    limits: opts.limits,
    onEvent: opts.onEvent,
    runId: opts.runId,
    signal: opts.signal,
  });

  const lineCounts = new Map<string, number | null>();
  const lines = async (path: string) => {
    if (!lineCounts.has(path)) {
      const full = safeRepoPath(deps.repoDir, path);
      const text = full ? await readFile(full, "utf8").catch(() => null) : null;
      lineCounts.set(path, text === null ? null : text.split("\n").length);
    }
    return lineCounts.get(path)!;
  };

  const base = {
    issue: issue && { number: issue.number, title: issue.title, url: issue.url },
    description,
    exception: parsed.exception,
    frames,
    suspects,
    toolCalls: loop.toolCalls.map((t) => ({ name: t.name, summary: t.summary, ms: t.ms })),
    costUsd: loop.costUsd,
  };

  const json = parseJsonObject(loop.content);
  if (json && typeof json.hypothesis === "string" && json.hypothesis.trim()) {
    const evidence: { ref: CodeRef; why: string }[] = [];
    for (const e of Array.isArray(json.evidence) ? (json.evidence as { ref?: unknown; why?: unknown }[]) : []) {
      const ref = typeof e.ref === "string" ? parseCodeRef(e.ref.replace(/^\[|\]$/g, "")) : null;
      const count = ref ? await lines(ref.path) : null;
      if (ref && count !== null && ref.startLine <= count) evidence.push({ ref: { ...ref, endLine: Math.min(ref.endLine, count) }, why: typeof e.why === "string" ? e.why : "" });
    }
    const filesToChange: string[] = [];
    for (const f of Array.isArray(json.filesToChange) ? json.filesToChange : []) if (typeof f === "string" && (await lines(f)) !== null) filesToChange.push(f);
    if (evidence.length && filesToChange.length) {
      const report: BugReport = {
        ...base,
        hypothesis: json.hypothesis.trim(),
        confidence: CONFIDENCE.has(String(json.confidence)) ? (json.confidence as BugReport["confidence"]) : "low",
        evidence,
        filesToChange,
        fallback: false,
      };
      opts.onEvent?.({ type: "report", report });
      return report;
    }
  }

  const report: BugReport = { ...base, ...fallbackReport(suspects, parsed.exception, frames.some((f) => f.path)), fallback: true };
  opts.onEvent?.({ type: "report", report });
  return report;
}

/** Report built from the suspect ranking alone (no usable model output). */
export function fallbackReport(suspects: BugReport["suspects"], exception: string | null, hasRepoFrames: boolean): Pick<BugReport, "hypothesis" | "confidence" | "evidence" | "filesToChange"> {
  const top = suspects[0];
  if (!top) {
    return { hypothesis: "No likely location found: the report has no stack frames in this repository and nothing in the code matched it closely.", confidence: "low", evidence: [], filesToChange: [] };
  }
  const where = top.symbol ? `\`${top.symbol}\` (${formatCodeRef(top)})` : formatCodeRef(top);
  const hypothesis = `The bug most likely originates in ${where}: ${top.reasons[0]!.charAt(0).toLowerCase()}${top.reasons[0]!.slice(1)}.${exception ? ` The failure surfaces as \`${exception}\`.` : ""} This ranking comes from the ${hasRepoFrames ? "stack trace, the call graph and code search" : "bug description and code search"}; confirm it before changing code.`;
  const codeFiles = [...new Set(suspects.filter((s) => !isTestPath(s.path)).map((s) => s.path))];
  return {
    hypothesis,
    confidence: hasRepoFrames ? "medium" : "low",
    evidence: suspects.slice(0, 3).map((s) => ({ ref: { path: s.path, startLine: s.startLine, endLine: s.endLine }, why: s.reasons.join("; ") })),
    filesToChange: codeFiles.slice(0, 2),
  };
}

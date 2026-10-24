import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@archaeo/db";
import type { Models } from "@archaeo/models";
import type { AgentEvent, AskResult, CodeRef } from "@archaeo/shared";
import { loadCitationIndex, validateCitations } from "../past/citations";
import { formatCodeRef, validateCodeCitations } from "./code-refs";
import type { AgentLimits } from "./limits";
import { limitMessage, runLoop } from "./loop";
import { CODE_TOOLS, safeRepoPath, type AgentTool } from "./tools";

export interface AskDeps {
  prisma: PrismaClient;
  models: Pick<Models, "reason" | "embed">;
  repoId: string;
  repoDir: string;
  repoName: string;
}

export interface AskOptions {
  limits: AgentLimits;
  onEvent?: (e: AgentEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  tools?: AgentTool[];
}

function systemPrompt(repoName: string, overview: string | null, topLevel: string[]): string {
  return `You answer questions about the ${repoName} codebase for a developer.
${overview ? `Repository overview: ${overview}\n` : ""}Top-level folders: ${topLevel.join(", ") || "(none)"}.

Work like this: search_code to find candidates, read_file to confirm details, get_callers/get_callees to follow the call graph, git_blame for who/when.
Rules:
- Cite every claim about code with the exact lines, as [path:start-end] (e.g. [src/app/core.py:120-145]). Only cite lines a tool showed you.
- Prefer specific functions and line ranges over whole files. Say so plainly if the code doesn't answer the question.
- Be concise: a direct answer first, then the key details. Markdown is fine.`;
}

/** Line counts of repo files, cached per question. */
function lineCounter(repoDir: string) {
  const cache = new Map<string, number | null>();
  return {
    async load(paths: string[]) {
      await Promise.all(
        paths.filter((p) => !cache.has(p)).map(async (p) => {
          const full = safeRepoPath(repoDir, p);
          const text = full ? await readFile(full, "utf8").catch(() => null) : null;
          cache.set(p, text === null ? null : text.split("\n").length);
        }),
      );
    },
    get: (p: string) => cache.get(p) ?? null,
  };
}

const CODE_PATH = /\[([^\]\n]+)\]/g;

/** Answers a question about the repo with the tool-calling agent, then checks every citation. */
export async function answerQuestion(deps: AskDeps, question: string, opts: AskOptions): Promise<AskResult> {
  const { prisma, repoId } = deps;
  const [overview, top] = await Promise.all([
    prisma.module.findUnique({ where: { repoId_path: { repoId, path: "" } }, select: { summary: true } }),
    prisma.module.findMany({ where: { repoId, parentPath: "" }, select: { path: true }, orderBy: { path: "asc" } }),
  ]);

  const loop = await runLoop({
    models: deps.models,
    tools: opts.tools ?? CODE_TOOLS,
    ctx: { prisma, models: deps.models, repoId, repoDir: deps.repoDir },
    messages: [
      { role: "system", content: systemPrompt(deps.repoName, overview?.summary ?? null, top.map((t) => t.path)) },
      { role: "user", content: question },
    ],
    limits: opts.limits,
    onEvent: opts.onEvent,
    runId: opts.runId,
    signal: opts.signal,
  });

  // Validate code citations against real files, and commit/PR citations against history.
  const lines = lineCounter(deps.repoDir);
  const candidates = [...loop.content.matchAll(CODE_PATH)].flatMap((m) => m[1]!.split(/\s*,\s*/).map((t) => t.split(":")[0]!));
  await lines.load([...candidates, ...loop.seen.map((r) => r.path)]);
  const code = validateCodeCitations(loop.content, lines.get);
  const history = validateCitations(code.text, await loadCitationIndex(prisma, repoId));

  let answer = history.text.trim();
  let fallback = false;
  if (code.valid.length === 0 && loop.seen.length > 0) {
    answer = fallbackAnswer(loop.seen.filter((r) => lines.get(r.path) !== null));
    fallback = true;
  }
  if (loop.status === "limited" && loop.limitReason) answer = `${limitMessage(loop.limitReason, opts.limits)} Here is what I found so far:\n\n${answer}`;
  if (loop.status === "failed") answer = `Sorry, the run failed: ${loop.error}.${answer ? `\n\n${answer}` : ""}`;
  if (!answer) answer = "I couldn't find code that answers this question.";

  const refs = fallback ? dedupeRefs(loop.seen).slice(0, 6) : code.valid;
  const result: AskResult = {
    status: loop.status,
    answer,
    refs,
    fallback,
    invalidCitations: [...code.invalid, ...history.invalid],
    limitReason: loop.limitReason,
    toolCalls: loop.toolCalls.map((t) => ({ name: t.name, summary: t.summary, ms: t.ms })),
    costUsd: loop.costUsd,
    steps: loop.steps,
  };
  opts.onEvent?.({ type: "answer", result });
  return result;
}

function dedupeRefs(refs: CodeRef[]): CodeRef[] {
  const out: CodeRef[] = [];
  for (const r of refs) if (!out.some((o) => o.path === r.path && o.startLine <= r.startLine && o.endLine >= r.endLine)) out.push(r);
  return out;
}

function fallbackAnswer(seen: CodeRef[]): string {
  const top = dedupeRefs(seen).slice(0, 6);
  if (!top.length) return "";
  return `I couldn't write a cited answer, but this is the most relevant code I found:\n${top.map((r) => `- [${formatCodeRef(r)}]`).join("\n")}`;
}

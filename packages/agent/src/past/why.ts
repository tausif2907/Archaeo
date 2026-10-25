import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@archaeo/db";
import { blame, fileHistory, firstAddedIn, lineHistory, type CommitInfo } from "@archaeo/ingest";
import type { Models } from "@archaeo/models";
import type { WhyCommit, WhyResult } from "@archaeo/shared";
import { loadCitationIndex, validateCitations } from "./citations";
import { cleanExcerpt, isoDay, parseJsonObject, shortSha, subjectOf } from "./json";

export interface WhyTarget {
  path: string;
  /** Symbol name or qualified name (e.g. `Command.invoke`) inside `path` */
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export class WhyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export interface WhyDeps {
  prisma: PrismaClient;
  models: Pick<Models, "reason">;
  repoId: string;
  /** Local clone of the repo */
  repoDir: string;
}

const MAJOR_CHANGES = 5;

/**
 * The text that defines a symbol, e.g. "class Group" or "def make_metavar": the first line in its range that names
 * it, cut after the name. Null when that text is not unique in the file (several classes define make_metavar)
 * or no keyword precedes the name, since searching history for it would then find the wrong commit.
 */
export function definitionToken(fileText: string, startLine: number, endLine: number, name: string): string | null {
  const lines = fileText.split("\n");
  const named = new RegExp(`(?<![\\w$#])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  for (let i = Math.max(startLine - 1, 0); i < Math.min(endLine, lines.length); i++) {
    const line = lines[i]!.trimStart();
    const m = named.exec(line);
    if (!m) continue;
    const token = line.slice(0, m.index + name.length);
    if (!/\s/.test(token)) return null;
    return fileText.split(token).length === 2 ? token : null;
  }
  return null;
}

const SYSTEM = `You explain why a piece of code exists, using only its git history and pull requests.
Cover: when and by whom it was introduced and the stated reason; how it evolved (major changes); what shaped its current form.
Cite every factual sentence with commit SHAs or PR numbers in square brackets: [abc1234] or [#123]. Never cite anything not in the evidence.
Respond with JSON only: {"answer": "1-3 short paragraphs of markdown"}`;

/** "Why does this exist?" for a file or symbol: walks history and blame, then explains with citations. */
export async function explainWhy(deps: WhyDeps, target: WhyTarget): Promise<WhyResult> {
  const { prisma, repoId, repoDir } = deps;
  const path = target.path.replace(/^\/+/, "");
  if (path.includes("..") || !existsSync(join(repoDir, path))) throw new WhyError(`File not found: ${path}`, 404);

  let range: { start: number; end: number; symbol: string | null } | null = null;
  if (target.symbol) {
    const symbols = await prisma.symbol.findMany({
      where: { file: { repoId, path }, OR: [{ qualifiedName: target.symbol }, { name: target.symbol }] },
      orderBy: { startLine: "asc" },
    });
    // Exact qualified name first; among duplicates (e.g. typing @overload stubs) the largest body is the implementation.
    const pool = symbols.some((s) => s.qualifiedName === target.symbol) ? symbols.filter((s) => s.qualifiedName === target.symbol) : symbols;
    const sym = [...pool].sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))[0];
    if (!sym) throw new WhyError(`Symbol ${target.symbol} not found in ${path}`, 404);
    range = { start: sym.startLine, end: sym.endLine, symbol: sym.qualifiedName };
  } else if (target.startLine && target.endLine) {
    if (target.endLine < target.startLine) throw new WhyError("endLine must be >= startLine");
    range = { start: target.startLine, end: target.endLine, symbol: null };
  }

  let history = range ? await lineHistory(repoDir, path, range.start, range.end) : await fileHistory(repoDir, path);
  if (history.length === 0) throw new WhyError(`No git history for ${path}`, 404);
  if (range?.symbol) {
    // git log -L can carry a newly added symbol back into older code that merely looked similar, so its history
    // starts at the commit that first added the definition line, when that line is unique in the file.
    const token = definitionToken(await readFile(join(repoDir, path), "utf8"), range.start, range.end, range.symbol.split(".").pop()!);
    const added = token ? await firstAddedIn(repoDir, path, token) : null;
    const at = added ? history.findIndex((c) => c.sha === added) : -1;
    if (at >= 0) history = history.slice(0, at + 1);
  }

  // Lines changed per commit: from the file's own numstat (file history), or the stored commit stats (line history).
  const linesFor = await linesChangedLookup(prisma, repoId, path, history, !range);
  const introducedInfo = history[history.length - 1]!;
  const latestInfo = history[0]!;
  const middle = history.slice(1, -1);
  const majorInfos = [...middle].sort((a, b) => (linesFor(b) ?? 0) - (linesFor(a) ?? 0)).slice(0, MAJOR_CHANGES);

  const blameShares = (await blame(repoDir, path, range?.start, range?.end)).slice(0, 5);
  const blameTotal = blameShares.reduce((s, b) => s + b.lines, 0) || 1;

  const cited = new Set([introducedInfo, latestInfo, ...majorInfos].map((c) => c.sha).concat(blameShares.map((b) => b.sha)));
  const prs = await prisma.pullRequest.findMany({
    where: { repoId, linkedCommitShas: { hasSome: [...cited] } },
    select: { number: true, title: true, body: true, mergedAt: true, linkedCommitShas: true },
    orderBy: { number: "asc" },
  });
  const prsOf = (sha: string) => prs.filter((p) => p.linkedCommitShas.includes(sha)).map((p) => p.number);

  const toWhy = (c: CommitInfo): WhyCommit => ({
    sha: c.sha,
    shortSha: shortSha(c.sha),
    date: isoDay(c.date),
    author: c.author,
    subject: subjectOf(c.message),
    linesChanged: linesFor(c),
    prNumbers: prsOf(c.sha),
  });

  const result: Omit<WhyResult, "answer" | "fallback" | "invalidCitations"> = {
    target: { path, symbol: range?.symbol ?? null, startLine: range?.start ?? null, endLine: range?.end ?? null },
    totalCommits: history.length,
    introduced: toWhy(introducedInfo),
    latest: toWhy(latestInfo),
    majorChanges: majorInfos.map(toWhy),
    blame: blameShares.map((b) => ({
      sha: b.sha,
      shortSha: shortSha(b.sha),
      author: b.author,
      date: isoDay(b.date),
      summary: b.summary,
      lines: b.lines,
      percent: Math.round((b.lines / blameTotal) * 100),
    })),
    pullRequests: prs.map((p) => ({ number: p.number, title: p.title, mergedAt: p.mergedAt ? isoDay(p.mergedAt) : null, excerpt: cleanExcerpt(p.body) })),
  };

  const introducedBody = introducedInfo.message.split("\n").slice(1).join("\n").trim();
  const evidence = { ...result, introducedMessageBody: introducedBody.slice(0, 600) };
  const index = await loadCitationIndex(prisma, repoId);
  try {
    const step = await deps.models.reason([
      { role: "system", content: SYSTEM },
      { role: "user", content: `Why does ${describeTarget(result.target)} exist?\n\nEvidence:\n${JSON.stringify(evidence, null, 2)}` },
    ]);
    const answer = parseJsonObject(step.content)?.answer;
    if (typeof answer === "string" && answer.trim()) {
      const checked = validateCitations(answer.trim(), index);
      if (checked.validShas.length + checked.validNumbers.length > 0) {
        return { ...result, answer: checked.text, fallback: false, invalidCitations: checked.invalid };
      }
    }
  } catch {
    // fall through to the evidence-only answer
  }
  return { ...result, answer: validateCitations(fallbackAnswer(result), index).text, fallback: true, invalidCitations: [] };
}

function describeTarget(t: WhyResult["target"]): string {
  if (t.symbol) return `\`${t.symbol}\` in \`${t.path}\``;
  if (t.startLine) return `lines ${t.startLine}-${t.endLine} of \`${t.path}\``;
  return `\`${t.path}\``;
}

async function linesChangedLookup(
  prisma: PrismaClient,
  repoId: string,
  path: string,
  history: CommitInfo[],
  fromNumstat: boolean,
): Promise<(c: CommitInfo) => number | null> {
  if (fromNumstat) {
    return (c) => (c.files.length ? c.files.reduce((s, f) => s + f.additions + f.deletions, 0) : null);
  }
  const basename = path.split("/").pop()!;
  const rows = await prisma.commit.findMany({ where: { repoId, sha: { in: history.map((c) => c.sha) } }, select: { sha: true, filesChanged: true } });
  const bySha = new Map(
    rows.map((r) => {
      const files = (r.filesChanged as { path: string; additions: number; deletions: number }[] | null) ?? [];
      const own = files.filter((f) => f.path === path || f.path.endsWith(`/${basename}`) || f.path === basename);
      return [r.sha, own.length ? own.reduce((s, f) => s + f.additions + f.deletions, 0) : null] as const;
    }),
  );
  return (c) => bySha.get(c.sha) ?? null;
}

function cite(c: WhyCommit): string {
  return `[${[c.shortSha, ...c.prNumbers.map((n) => `#${n}`)].join(", ")}]`;
}

/** Deterministic, fully cited answer built straight from the evidence. */
export function fallbackAnswer(r: Omit<WhyResult, "answer" | "fallback" | "invalidCitations">): string {
  const what = describeTarget(r.target);
  const intro = r.introduced;
  const pr = r.pullRequests.find((p) => intro.prNumbers.includes(p.number));
  const parts: string[] = [];
  parts.push(
    `${what} was introduced on ${intro.date} by ${intro.author} in "${intro.subject}" ${cite(intro)}` +
      (pr ? `, part of PR #${pr.number} "${pr.title}"` : "") +
      ".",
  );
  if (pr?.excerpt) parts.push(`The PR explains: "${pr.excerpt}" [#${pr.number}]`);

  const evolution: string[] = [];
  if (r.totalCommits > 1) {
    evolution.push(`It has been changed in ${r.totalCommits - 1} commit${r.totalCommits === 2 ? "" : "s"} since.`);
    if (r.majorChanges.length) {
      evolution.push(
        `The largest changes were ${r.majorChanges
          .slice(0, 3)
          .map((c) => `"${c.subject}" (${c.date}) ${cite(c)}`)
          .join("; ")}.`,
      );
    }
    if (r.latest.sha !== intro.sha) evolution.push(`The most recent change was "${r.latest.subject}" on ${r.latest.date} ${cite(r.latest)}.`);
  }
  const top = r.blame[0];
  if (top) evolution.push(`Today ${top.percent}% of its lines still come from "${top.summary}" (${top.date}, ${top.author}) [${top.shortSha}].`);

  return [parts.join(" "), evolution.join(" ")].filter(Boolean).join("\n\n");
}

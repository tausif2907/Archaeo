import { createHash } from "node:crypto";
import type { Models } from "@archaeo/models";
import { validateCitations, type CitationIndex } from "./citations";
import { isBot, type EraDraft } from "./eras";
import { cleanExcerpt, isoDay, monthYear, parseJsonObject, shortSha, subjectOf } from "./json";

export interface EvidencePr {
  number: number;
  title: string;
  body: string | null;
  mergedAt: Date | null;
  linkedCommitShas: string[];
}

export interface EvidenceCommit {
  sha: string;
  message: string;
  author: string;
  date: Date;
  linesChanged: number;
}

export interface EraEvidence {
  start: string;
  end: string;
  commitCount: number;
  contributors: number;
  topAuthors: { name: string; commits: number }[];
  topAreas: { area: string; percent: number }[];
  releases: string[];
  keyPrs: { number: number; title: string; mergedAt: string | null; excerpt: string; linesChanged: number }[];
  keyCommits: { sha: string; subject: string; author: string; date: string; linesChanged: number }[];
}

const KEY_PRS = 6;
const KEY_COMMITS = 6;

/** Picks the PRs and commits that best represent an era (by size of change) and summarizes who/where. */
export function buildEraEvidence(draft: EraDraft, prs: EvidencePr[], commitsBySha: Map<string, EvidenceCommit>): EraEvidence {
  const inEra = new Set(draft.commits.map((c) => c.sha));
  const authors = new Map<string, number>();
  for (const c of draft.commits) if (!isBot(c.author)) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);

  const prLines = (pr: EvidencePr) => pr.linkedCommitShas.reduce((s, sha) => s + (commitsBySha.get(sha)?.linesChanged ?? 0), 0);
  const keyPrs = prs
    .filter((p) => p.mergedAt && p.mergedAt >= draft.start && p.mergedAt <= draft.end)
    .map((p) => ({ pr: p, lines: prLines(p) }))
    .sort((a, b) => b.lines - a.lines || a.pr.number - b.pr.number)
    .slice(0, KEY_PRS);

  const coveredByPrs = new Set(keyPrs.flatMap((k) => k.pr.linkedCommitShas));
  const keyCommits = [...inEra]
    .map((sha) => commitsBySha.get(sha))
    .filter((c): c is EvidenceCommit => !!c && !coveredByPrs.has(c.sha) && !/^Merge /.test(c.message))
    .sort((a, b) => b.linesChanged - a.linesChanged || a.sha.localeCompare(b.sha))
    .slice(0, KEY_COMMITS);

  return {
    start: isoDay(draft.start),
    end: isoDay(draft.end),
    commitCount: draft.commits.length,
    contributors: authors.size,
    topAuthors: [...authors]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, commits]) => ({ name, commits })),
    topAreas: draft.areas.slice(0, 5).map((a) => ({ area: a.area, percent: Math.round(a.share * 100) })),
    releases: draft.releases,
    keyPrs: keyPrs.map(({ pr, lines }) => ({
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt ? isoDay(pr.mergedAt) : null,
      excerpt: cleanExcerpt(pr.body, 300),
      linesChanged: lines,
    })),
    keyCommits: keyCommits.map((c) => ({ sha: shortSha(c.sha), subject: subjectOf(c.message), author: c.author, date: isoDay(c.date), linesChanged: c.linesChanged })),
  };
}

/** Stable hash of what the narrative is written from; unchanged eras reuse their narrative. */
export function eraFingerprint(ev: EraEvidence): string {
  const key = JSON.stringify([ev.start, ev.end, ev.commitCount, ev.releases, ev.keyPrs.map((p) => p.number), ev.keyCommits.map((c) => c.sha)]);
  return createHash("sha1").update(key).digest("hex");
}

export interface EraNarrative {
  title: string;
  narrative: string;
  /** True when the narrative was assembled from evidence because model output was unusable */
  fallback: boolean;
  invalidCitations: string[];
}

const SYSTEM = `You are a software historian writing one chapter of a repository's history.
Use ONLY the evidence provided. Do not invent features, motives, people or numbers.
Cite every factual sentence with the commit SHAs or PR numbers it is based on, in square brackets: [abc1234] or [#123] or [abc1234, #123].
Explain what changed and, where PR descriptions say so, why. Mention key contributors by name.
Respond with JSON only: {"title": "<= 8 words, specific", "narrative": "2-3 short paragraphs of markdown"}`;

/** Writes an era narrative with `reason()`; falls back to an evidence-only narrative on bad output. */
export async function writeEraNarrative(
  models: Pick<Models, "reason">,
  ev: EraEvidence,
  index: CitationIndex,
  opts: { runId?: string } = {},
): Promise<EraNarrative> {
  try {
    const step = await models.reason(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Evidence for this era:\n${JSON.stringify(ev, null, 2)}` },
      ],
      undefined,
      { runId: opts.runId },
    );
    const parsed = parseJsonObject(step.content);
    const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
    const narrative = typeof parsed?.narrative === "string" ? parsed.narrative.trim() : "";
    if (title && narrative) {
      const checked = validateCitations(narrative, index);
      // An uncited narrative can't be trusted; prefer the grounded fallback.
      if (checked.validShas.length + checked.validNumbers.length > 0) {
        return { title: validateCitations(title, index).text, narrative: checked.text, fallback: false, invalidCitations: checked.invalid };
      }
    }
  } catch {
    // fall through to the evidence-only narrative
  }
  return { ...fallbackNarrative(ev), fallback: true, invalidCitations: [] };
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function areaLabel(area: string): string {
  return area === "(root)" ? "top-level files" : area;
}

/** Deterministic, fully cited narrative built straight from the evidence. */
export function fallbackNarrative(ev: EraEvidence): { title: string; narrative: string } {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  const releases = ev.releases.length === 0 ? "" : ev.releases.length === 1 ? `Release ${ev.releases[0]}` : `Releases ${ev.releases[0]}–${ev.releases[ev.releases.length - 1]}`;
  const when = releases || (monthYear(start) === monthYear(end) ? monthYear(start) : `${monthYear(start)} – ${monthYear(end)}`);
  const codeAreas = ev.topAreas.filter((a) => !["docs", "tests", "(root)", ".github", "requirements"].includes(a.area));
  const focus = (codeAreas.length ? codeAreas : ev.topAreas).slice(0, 2).map((a) => a.area.split("/").pop()!);
  const title = focus.length ? `${when}: ${focus.join(" & ")}` : when;

  const intro =
    `${ev.commitCount.toLocaleString("en-US")} commits from ${ev.contributors} contributor${ev.contributors === 1 ? "" : "s"} between ${monthYear(start)} and ${monthYear(end)}` +
    (ev.releases.length ? `, leading up to ${ev.releases.length === 1 ? "release" : "releases"} ${list(ev.releases.slice(0, 6))}${ev.releases.length > 6 ? " and more" : ""}` : "") +
    ". " +
    (ev.topAreas.length ? `Most of the work touched ${list(ev.topAreas.slice(0, 3).map((a) => `${areaLabel(a.area)} (${a.percent}%)`))}. ` : "") +
    (ev.topAuthors.length ? `Leading contributors: ${list(ev.topAuthors.slice(0, 3).map((a) => `${a.name} (${a.commits})`))}.` : "");

  const changes = [
    ...ev.keyPrs.slice(0, 4).map((p) => `- ${p.title} [#${p.number}]`),
    ...ev.keyCommits.slice(0, Math.max(2, 6 - Math.min(4, ev.keyPrs.length))).map((c) => `- ${c.subject} [${c.sha}]`),
  ];
  return { title, narrative: changes.length ? `${intro}\n\nKey changes:\n${changes.join("\n")}` : intro };
}

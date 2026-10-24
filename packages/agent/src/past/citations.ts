import type { PrismaClient } from "@archaeo/db";

/** Resolves citations against what actually exists in the repo. */
export interface CitationIndex {
  /** Full SHA for a unique prefix (≥7 chars), else null */
  resolveSha(prefix: string): string | null;
  /** PR or issue number exists */
  hasNumber(n: number): boolean;
}

export interface CheckedText {
  text: string;
  validShas: string[];
  validNumbers: number[];
  /** Citations that were removed because they don't exist */
  invalid: string[];
}

const SHA = /^[0-9a-f]{7,40}$/;
const NUM = /^#(\d+)$/;
// A bare hex token must contain a digit and a letter, so words ("deadbeef" aside) and years don't match.
const BARE_SHA = /(?<![\w/#])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/])/g;
const BARE_NUM = /(?<![\w/&#[])#(\d+)\b/g;
const BRACKET = /\s?\[([^\]\n]{1,200})\](?!\()/g;

export function citationIndex(shas: string[], numbers: Iterable<number>): CitationIndex {
  const sorted = [...shas].sort();
  const nums = new Set(numbers);
  return {
    resolveSha(prefix) {
      const p = prefix.toLowerCase();
      if (p.length < 7) return null;
      // binary search for the first sha >= prefix
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]! < p) lo = mid + 1;
        else hi = mid;
      }
      const hit = sorted[lo];
      if (!hit?.startsWith(p)) return null;
      const next = sorted[lo + 1];
      return next?.startsWith(p) ? null : hit;
    },
    hasNumber: (n) => nums.has(n),
  };
}

export async function loadCitationIndex(prisma: PrismaClient, repoId: string): Promise<CitationIndex> {
  const [commits, prs, issues] = await Promise.all([
    prisma.commit.findMany({ where: { repoId }, select: { sha: true } }),
    prisma.pullRequest.findMany({ where: { repoId }, select: { number: true } }),
    prisma.issue.findMany({ where: { repoId }, select: { number: true } }),
  ]);
  return citationIndex(
    commits.map((c) => c.sha),
    [...prs, ...issues].map((x) => x.number),
  );
}

/** Every SHA-like and #number token in the text, bracketed or bare. */
export function findCitations(text: string): { shas: string[]; numbers: number[] } {
  const shas = new Set<string>();
  const numbers = new Set<number>();
  for (const m of text.matchAll(BARE_SHA)) shas.add(m[0]);
  for (const m of text.matchAll(/(?<![\w/&])#(\d+)\b/g)) numbers.add(Number(m[1]));
  return { shas: [...shas], numbers: [...numbers] };
}

/**
 * Keeps citations that exist and removes the rest. Citations are `[abc1234]`, `[#123]`, or a bracket
 * listing several (`[abc1234, #12]`). Bare SHAs/#numbers in prose are checked too.
 */
export function validateCitations(text: string, index: CitationIndex): CheckedText {
  const validShas = new Set<string>();
  const validNumbers = new Set<number>();
  const invalid: string[] = [];

  const check = (token: string): boolean => {
    const num = NUM.exec(token);
    if (num) {
      const n = Number(num[1]);
      if (index.hasNumber(n)) {
        validNumbers.add(n);
        return true;
      }
    } else if (SHA.test(token.toLowerCase())) {
      const full = index.resolveSha(token);
      if (full) {
        validShas.add(full);
        return true;
      }
    }
    invalid.push(token);
    return false;
  };

  // 1. Bracketed citations. Brackets holding anything else (e.g. markdown link text) are left alone.
  let out = text.replace(BRACKET, (whole, inner: string) => {
    const tokens = inner.split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length || !tokens.every((t) => NUM.test(t) || SHA.test(t.toLowerCase()))) return whole;
    const kept = tokens.filter(check);
    if (!kept.length) return "";
    return `${whole.startsWith(" ") ? " " : ""}[${kept.join(", ")}]`;
  });

  // 2. Bare tokens outside brackets.
  const outsideBrackets = (offset: number, s: string) => {
    const open = s.lastIndexOf("[", offset);
    const close = s.lastIndexOf("]", offset);
    return open <= close;
  };
  out = out.replace(BARE_SHA, (tok, offset: number, s: string) => (!outsideBrackets(offset, s) || check(tok) ? tok : ""));
  out = out.replace(BARE_NUM, (tok, _n, offset: number, s: string) => (!outsideBrackets(offset, s) || check(tok) ? tok : ""));

  return { text: out.replace(/ +([.,;:])/g, "$1"), validShas: [...validShas], validNumbers: [...validNumbers], invalid };
}

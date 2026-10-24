import { buildAreaMapper } from "./areas";

export interface EraCommit {
  sha: string;
  date: Date;
  author: string;
  files: string[];
}

export interface ReleaseTag {
  name: string;
  date: Date;
}

export interface EraDraft {
  start: Date;
  end: Date;
  commits: EraCommit[];
  /** Areas by share of activity, highest first */
  areas: { area: string; share: number }[];
  /** Release tags published inside the era */
  releases: string[];
}

export interface DetectOptions {
  minEras?: number;
  maxEras?: number;
  /** Release-based windows are used when a repo has at least this many release tags */
  minReleasesForWindows?: number;
}

type Vec = Map<string, number>;

interface Segment {
  commits: EraCommit[];
  vec: Vec;
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
/** Weight of the even-split penalties relative to area dissimilarity */
const BALANCE = 0.5;

export function isBot(author: string): boolean {
  return /\[bot\]$|^dependabot|^pre-commit-ci|^renovate|^github-actions/i.test(author);
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    dot += v * (b.get(k) ?? 0);
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function addVec(a: Vec, b: Vec): Vec {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

function quarterStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

/** Window end boundaries (exclusive of the next window): release dates, or calendar quarters. */
function windowBoundaries(first: Date, last: Date, releases: ReleaseTag[], minReleases: number): Date[] {
  const inside = releases.filter((r) => r.date > first && r.date < last).map((r) => r.date);
  if (inside.length >= minReleases) return [...inside, last];
  const bounds: Date[] = [];
  let q = quarterStart(first);
  for (;;) {
    q = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth() + 3, 1));
    if (q > last) break;
    bounds.push(q);
  }
  return [...bounds, last];
}

/**
 * Groups history into 5–12 eras. Commits are first bucketed into windows (between release tags, or
 * quarters), then adjacent windows are merged greedily, cheapest first, where merging is cheap when
 * two windows touch the same areas of the codebase or one of them is small.
 */
export function detectEras(commits: EraCommit[], releases: ReleaseTag[], opts: DetectOptions = {}): EraDraft[] {
  const minEras = opts.minEras ?? 5;
  const maxEras = opts.maxEras ?? 12;
  const sorted = [...commits].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (sorted.length === 0) return [];

  const first = sorted[0]!.date;
  const last = sorted[sorted.length - 1]!.date;
  const areaOf = buildAreaMapper(sorted.flatMap((c) => c.files));

  const vecOf = (c: EraCommit): Vec => {
    const v: Vec = new Map();
    // Bot commits (dependency bumps, autofixes) say nothing about where the project's attention was.
    if (isBot(c.author)) return v;
    const areas = [...new Set(c.files.map(areaOf))];
    // Each commit contributes weight 1, spread over the areas it touches.
    for (const a of areas) v.set(a, 1 / areas.length);
    return v;
  };

  // Bucket commits into windows.
  const bounds = windowBoundaries(first, last, releases, opts.minReleasesForWindows ?? 6);
  let segments: Segment[] = [];
  let bi = 0;
  let current: Segment = { commits: [], vec: new Map() };
  for (const c of sorted) {
    while (bi < bounds.length - 1 && c.date > bounds[bi]!) {
      if (current.commits.length) segments.push(current);
      current = { commits: [], vec: new Map() };
      bi++;
    }
    current.commits.push(c);
    current.vec = addVec(current.vec, vecOf(c));
  }
  if (current.commits.length) segments.push(current);

  const spanYears = (last.getTime() - first.getTime()) / YEAR_MS;
  const target = Math.min(segments.length, Math.max(minEras, Math.min(maxEras, Math.round(spanYears * 0.75))));

  // Merge cost = how different the two windows' areas are (weighted by the smaller window's size)
  // + penalties for producing an era much longer or bigger than an even split would.
  const idealSpan = Math.max(1, last.getTime() - first.getTime()) / target;
  const idealCommits = sorted.length / target;
  const spanOf = (a: Segment, b: Segment) => b.commits[b.commits.length - 1]!.date.getTime() - a.commits[0]!.date.getTime();

  while (segments.length > target) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < segments.length - 1; i++) {
      const a = segments[i]!;
      const b = segments[i + 1]!;
      const n = a.commits.length + b.commits.length;
      const cost =
        (1 - cosine(a.vec, b.vec)) * Math.sqrt(Math.min(a.commits.length, b.commits.length)) +
        BALANCE * (spanOf(a, b) / idealSpan) ** 2 +
        BALANCE * (n / idealCommits) ** 2;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    const a = segments[best]!;
    const b = segments[best + 1]!;
    segments = [...segments.slice(0, best), { commits: [...a.commits, ...b.commits], vec: addVec(a.vec, b.vec) }, ...segments.slice(best + 2)];
  }

  return segments.map((s, i) => {
    const start = s.commits[0]!.date;
    const end = s.commits[s.commits.length - 1]!.date;
    const total = [...s.vec.values()].reduce((x, y) => x + y, 0) || 1;
    const areas = [...s.vec]
      .map(([area, w]) => ({ area, share: w / total }))
      .sort((x, y) => y.share - x.share);
    // A release belongs to the era whose commits led up to it: from this era's start until the next era starts.
    const nextStart = segments[i + 1]?.commits[0]!.date;
    const releasesIn = releases
      .filter((r) => (i === 0 || r.date >= start) && (!nextStart || r.date < nextStart))
      .map((r) => r.name);
    return { start, end, commits: s.commits, areas, releases: releasesIn };
  });
}

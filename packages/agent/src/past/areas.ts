/** Source roots stripped before grouping, so `click/core.py` and `src/click/core.py` (after a src-layout move) match. */
const ROOT_PREFIX = /^(src|lib|source|packages)\//;

/** A top-level area taking more than this share of activity is split one level deeper (its modules). */
const SPLIT_SHARE = 0.25;

export function normalizePath(path: string): string {
  return path.replace(ROOT_PREFIX, "");
}

function topSegment(path: string): string {
  const n = normalizePath(path);
  const i = n.indexOf("/");
  return i === -1 ? "(root)" : n.slice(0, i);
}

function secondSegment(path: string): string {
  const parts = normalizePath(path).split("/");
  const second = parts[1] ?? "";
  return second.replace(/\.[^.]+$/, "");
}

/**
 * Builds a path → area function from a sample of touched paths. Areas are top-level folders,
 * except a dominant folder (usually the main package) is split into its files/subfolders.
 */
export function buildAreaMapper(touchedPaths: string[]): (path: string) => string {
  const counts = new Map<string, number>();
  for (const p of touchedPaths) counts.set(topSegment(p), (counts.get(topSegment(p)) ?? 0) + 1);
  const total = touchedPaths.length || 1;
  const split = new Set([...counts].filter(([seg, n]) => seg !== "(root)" && n / total > SPLIT_SHARE).map(([seg]) => seg));

  return (path) => {
    const top = topSegment(path);
    if (!split.has(top)) return top;
    const second = secondSegment(path);
    return second ? `${top}/${second}` : top;
  };
}

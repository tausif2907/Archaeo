/** Pulls a unified diff out of model output: fenced ```diff blocks, or raw diff text. */
export function extractDiff(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:diff|patch)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]!).filter((b) => /^(diff --git |--- )/m.test(b));
  let diff = fenced.join("\n");
  if (!diff) {
    const start = text.search(/^(diff --git |--- (a\/|\/dev\/null))/m);
    if (start === -1) return null;
    diff = text.slice(start);
  }
  if (!/^\+\+\+ /m.test(diff) || !/^@@ /m.test(diff)) return null;
  return diff.endsWith("\n") ? diff : `${diff}\n`;
}

export interface FileDiff {
  path: string;
  text: string;
}

/** Splits a multi-file diff into per-file sections (keyed by the new path, or old path for deletions). */
export function splitDiff(diff: string): FileDiff[] {
  const lines = diff.split("\n");
  // git-style diffs: one section per "diff --git"; plain unified diffs: a "---"/"+++"/"@@" header triple.
  let starts = lines.flatMap((l, i) => (l.startsWith("diff --git ") ? [i] : []));
  if (!starts.length) {
    starts = lines.flatMap((l, i) => (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && lines[i + 2]?.startsWith("@@") ? [i] : []));
  }
  if (!starts.length) return [];
  return starts.map((s, k) => {
    const text = lines.slice(s, starts[k + 1] ?? lines.length).join("\n");
    const plus = /^\+\+\+ (?:b\/)?(.+?)\s*$/m.exec(text)?.[1];
    const minus = /^--- (?:a\/)?(.+?)\s*$/m.exec(text)?.[1];
    const path = plus && plus !== "/dev/null" ? plus : (minus ?? "");
    return { path, text: text.endsWith("\n") ? text : `${text}\n` };
  });
}

export function filesInDiff(diff: string): string[] {
  return [...new Set(splitDiff(diff).map((f) => f.path).filter(Boolean))];
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Only the sections of a diff that touch test files (used to check the tests fail without the fix). */
export function testOnlyDiff(diff: string): string | null {
  const parts = splitDiff(diff).filter((f) => isTestPath(f.path));
  return parts.length ? parts.map((p) => p.text).join("") : null;
}

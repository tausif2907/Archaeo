import type { StackFrame } from "@archaeo/shared";

const PY_FRAME = /File "([^"]+)", line (\d+)(?:, in ([^\s\n]+))?/g;
const JS_FRAME = /^\s*at (?:(.+?) \()?((?:[A-Za-z]:)?[^\s():]+\.[cm]?[jt]sx?):(\d+)(?::\d+)?\)?\s*$/gm;
const PY_EXCEPTION_LINE = /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?::\s.*)?$/;
const JS_EXCEPTION = /^\s*(?:Uncaught )?((?:[A-Z]\w*)?Error)(?::\s*(.*))?$/m;

export interface ParsedTrace {
  /** Innermost frame first */
  frames: { rawPath: string; line: number; func: string | null }[];
  exception: string | null;
}

/** Python tracebacks and JS/TS stack traces. Frames come back innermost first. */
export function parseStackTrace(text: string): ParsedTrace {
  const pyMatches = [...text.matchAll(PY_FRAME)];
  if (pyMatches.length) {
    const py = pyMatches.map((m) => ({ rawPath: m[1]!, line: Number(m[2]), func: m[3] ?? null }));
    // The exception is the last unindented "Name: message" line after the frames (any class name).
    const after = text.slice(pyMatches[pyMatches.length - 1]!.index!).split("\n").slice(1);
    const excLine = [...after].reverse().find((l) => PY_EXCEPTION_LINE.test(l));
    return { frames: py.reverse(), exception: excLine?.trim() ?? null };
  }
  const js = [...text.matchAll(JS_FRAME)].map((m) => ({ rawPath: m[2]!, line: Number(m[3]), func: m[1]?.trim() ?? null }));
  const exc = JS_EXCEPTION.exec(text);
  return { frames: js, exception: exc ? `${exc[1]}${exc[2] ? `: ${exc[2].trim()}` : ""}` : null };
}

const GENERIC_NAMES = new Set(["__init__.py", "index.js", "index.ts", "main.py", "__main__.py", "utils.py", "index.tsx"]);

/**
 * Maps printed frame paths (absolute, site-packages, other machines) onto repo files by the longest
 * matching path suffix: `/venv/lib/site-packages/click/core.py` → `src/click/core.py`.
 */
export function mapFrames(frames: ParsedTrace["frames"], repoPaths: string[]): StackFrame[] {
  const bySegments = repoPaths.map((p) => ({ path: p, parts: p.split("/") }));
  return frames.map((f) => {
    const parts = f.rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
    let best: { path: string; score: number } | null = null;
    let tie = false;
    for (const r of bySegments) {
      let n = 0;
      while (n < parts.length && n < r.parts.length && parts[parts.length - 1 - n] === r.parts[r.parts.length - 1 - n]) n++;
      if (n === 0) continue;
      if (!best || n > best.score) {
        best = { path: r.path, score: n };
        tie = false;
      } else if (n === best.score) tie = true;
    }
    const basename = parts[parts.length - 1] ?? "";
    // One matching segment is only enough for a distinctive, unambiguous file name.
    const ok = best && !tie && (best.score >= 2 || (best.score === 1 && !GENERIC_NAMES.has(basename)));
    return { rawPath: f.rawPath, path: ok ? best!.path : null, line: f.line, func: f.func };
  });
}

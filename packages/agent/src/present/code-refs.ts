import type { CodeRef } from "@archaeo/shared";

const CODE_TOKEN = /^([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/;
const COMMIT_OR_NUMBER = /^(#\d+|[0-9a-f]{7,40})$/;
const BRACKET = /\s?\[([^\]\n]{1,300})\](?!\()/g;

export function parseCodeRef(token: string): CodeRef | null {
  const m = CODE_TOKEN.exec(token.trim());
  if (!m) return null;
  const startLine = Number(m[2]);
  const endLine = m[3] ? Number(m[3]) : startLine;
  if (startLine < 1 || endLine < startLine) return null;
  return { path: m[1]!.replace(/^\.?\//, ""), startLine, endLine };
}

export function formatCodeRef(ref: CodeRef): string {
  return ref.startLine === ref.endLine ? `${ref.path}:${ref.startLine}` : `${ref.path}:${ref.startLine}-${ref.endLine}`;
}

export interface CheckedCode {
  text: string;
  valid: CodeRef[];
  invalid: string[];
}

/**
 * Keeps `[path:start-end]` citations that point at real lines and removes the rest.
 * `lineCount(path)` returns the file's line count, or null when the file doesn't exist.
 * Commit/PR tokens in the same bracket are passed through (validated separately).
 */
export function validateCodeCitations(text: string, lineCount: (path: string) => number | null): CheckedCode {
  const valid: CodeRef[] = [];
  const invalid: string[] = [];
  const out = text.replace(BRACKET, (whole, inner: string) => {
    const tokens = inner.split(/\s*,\s*/).filter(Boolean);
    const isCode = tokens.map((t) => parseCodeRef(t));
    // Not a citation bracket (markdown, prose) unless every token is a code ref or commit/PR.
    if (!isCode.some(Boolean) || !tokens.every((t, i) => isCode[i] || COMMIT_OR_NUMBER.test(t))) return whole;
    const kept = tokens.filter((t, i) => {
      const ref = isCode[i];
      if (!ref) return true;
      const lines = lineCount(ref.path);
      if (lines !== null && ref.startLine <= lines) {
        valid.push({ ...ref, endLine: Math.min(ref.endLine, lines) });
        return true;
      }
      invalid.push(t);
      return false;
    });
    if (!kept.length) return "";
    return `${whole.startsWith(" ") ? " " : ""}[${kept.map((t) => {
      const ref = parseCodeRef(t);
      const lines = ref ? lineCount(ref.path) : null;
      return ref && lines !== null && ref.endLine > lines ? formatCodeRef({ ...ref, endLine: lines }) : t;
    }).join(", ")}]`;
  });
  return { text: out.replace(/ +([.,;:])/g, "$1"), valid, invalid };
}

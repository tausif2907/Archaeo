import { symbolKey } from "./callgraph";
import type { CommitInfo } from "./git";
import type { ParsedFile, SourceFile } from "./types";

export const MAX_CHUNK_CHARS = 4000;
const FILE_CHUNK_LINES = 120;
const CLASS_HEADER_LINES = 60;

export interface CodeChunkDraft {
  /** symbolKey(...) for symbol chunks, `file:<path>` for files without symbols */
  sourceKey: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

function clip(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? `${text.slice(0, MAX_CHUNK_CHARS)}\n…` : text;
}

/**
 * One chunk per symbol. Classes only get their header (up to the first nested symbol)
 * so method bodies aren't embedded twice. Files without symbols get one chunk of their head.
 */
export function codeChunks(file: SourceFile, parsed: ParsedFile): CodeChunkDraft[] {
  const lines = file.content.split("\n");
  const slice = (start: number, end: number) => lines.slice(start - 1, end).join("\n");

  if (parsed.symbols.length === 0) {
    if (!file.content.trim()) return [];
    const end = Math.min(lines.length, FILE_CHUNK_LINES);
    return [{ sourceKey: `file:${file.path}`, path: file.path, startLine: 1, endLine: end, text: clip(`${file.path}\n${slice(1, end)}`) }];
  }

  return parsed.symbols.map((sym) => {
    let end = sym.endLine;
    if (sym.kind === "class") {
      const firstChild = parsed.symbols.find((s) => s !== sym && s.startLine > sym.startLine && s.endLine <= sym.endLine);
      end = Math.min(end, firstChild ? firstChild.startLine - 1 : end, sym.startLine + CLASS_HEADER_LINES);
    }
    const header = `${file.path}:${sym.startLine}-${sym.endLine} ${sym.kind} ${sym.qualifiedName}`;
    return {
      sourceKey: symbolKey(file.path, sym),
      path: file.path,
      startLine: sym.startLine,
      endLine: sym.endLine,
      text: clip(`${header}\n${slice(sym.startLine, end)}`),
    };
  });
}

export function commitChunkText(c: Pick<CommitInfo, "sha" | "author" | "date" | "message" | "files">): string {
  const files = c.files.slice(0, 30).map((f) => `${f.path} (+${f.additions}/-${f.deletions})`);
  const more = c.files.length > 30 ? `\n… and ${c.files.length - 30} more files` : "";
  return clip(`commit ${c.sha}\nauthor ${c.author}, ${c.date.toISOString().slice(0, 10)}\n\n${c.message}\n\nfiles:\n${files.join("\n")}${more}`);
}

export function prChunkText(pr: { number: number; title: string; body: string | null }): string {
  return clip(`PR #${pr.number}: ${pr.title}\n\n${pr.body ?? ""}`.trim());
}

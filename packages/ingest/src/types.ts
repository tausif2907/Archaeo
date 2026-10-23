import type { Language } from "./languages";

export type SymbolKind = "function" | "class" | "method";

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  /** Dotted path within the file, e.g. `Command.invoke` */
  qualifiedName: string;
  /** 1-based, inclusive (includes decorators) */
  startLine: number;
  endLine: number;
  /** Names of functions/methods/classes called directly inside this symbol (not nested symbols) */
  calls: string[];
}

export interface ParsedImport {
  /** Module specifier: `./util` (JS/TS) or `click.core` (Python, without leading dots) */
  module: string;
  /** Python relative-import depth: 0 = absolute, 1 = `.`, 2 = `..` */
  level: number;
  /** Imported names (`from x import a, b` / `import { a, b }`); empty for bare imports */
  names: string[];
}

export interface ParsedFile {
  path: string;
  language: Language;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** Branch-point count: if/loops/catch/ternaries/boolean operators */
  complexity: number;
}

export interface SourceFile {
  path: string;
  language: Language;
  content: string;
  /** sha1 of content, used to skip unchanged files on re-ingest */
  hash: string;
  /** Non-blank lines */
  loc: number;
}

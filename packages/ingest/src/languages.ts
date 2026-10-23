export type Language = "python" | "typescript" | "javascript";

/** Which tree-sitter grammar parses a file. JavaScript goes through the TSX grammar. */
export type Grammar = "python" | "typescript" | "tsx";

const EXTENSIONS: Record<string, { language: Language; grammar: Grammar }> = {
  ".py": { language: "python", grammar: "python" },
  ".ts": { language: "typescript", grammar: "typescript" },
  ".mts": { language: "typescript", grammar: "typescript" },
  ".cts": { language: "typescript", grammar: "typescript" },
  ".tsx": { language: "typescript", grammar: "tsx" },
  ".js": { language: "javascript", grammar: "tsx" },
  ".jsx": { language: "javascript", grammar: "tsx" },
  ".mjs": { language: "javascript", grammar: "tsx" },
  ".cjs": { language: "javascript", grammar: "tsx" },
};

/** Paths we never parse: vendored, generated, or build output. */
const SKIP_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|coverage|\.next|vendor|third_party|site-packages)\//,
  /\.min\.[cm]?js$/,
  /\.d\.ts$/,
  /\.bundle\.js$/,
];

export function detectLanguage(path: string): { language: Language; grammar: Grammar } | null {
  if (SKIP_PATTERNS.some((re) => re.test(path))) return null;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

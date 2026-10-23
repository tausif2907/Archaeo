import { createRequire } from "node:module";
import { Language as TSLanguage, Parser, type Node } from "web-tree-sitter";
import { detectLanguage, type Grammar } from "./languages";
import type { ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from "./types";

const require = createRequire(import.meta.url);

const GRAMMAR_FILES: Record<Grammar, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
};

let ready: Promise<Record<Grammar, TSLanguage>> | undefined;

/** Loads the wasm runtime and grammars once per process. */
function loadGrammars(): Promise<Record<Grammar, TSLanguage>> {
  ready ??= (async () => {
    await Parser.init();
    const entries = await Promise.all(
      (Object.keys(GRAMMAR_FILES) as Grammar[]).map(async (g) => [g, await TSLanguage.load(require.resolve(GRAMMAR_FILES[g]))] as const),
    );
    return Object.fromEntries(entries) as Record<Grammar, TSLanguage>;
  })();
  return ready;
}

export interface SourceParser {
  /** Returns null for files we don't parse (unknown extension, vendored, ...) */
  parse(path: string, source: string): ParsedFile | null;
}

export async function createParser(): Promise<SourceParser> {
  const grammars = await loadGrammars();
  const parsers = new Map<Grammar, Parser>();
  const parserFor = (g: Grammar) => {
    let p = parsers.get(g);
    if (!p) {
      p = new Parser();
      p.setLanguage(grammars[g]);
      parsers.set(g, p);
    }
    return p;
  };

  return {
    parse(path, source) {
      const lang = detectLanguage(path);
      if (!lang) return null;
      const tree = parserFor(lang.grammar).parse(source);
      if (!tree) return null;
      try {
        const extract = lang.grammar === "python" ? extractPython : extractTs;
        return { path, language: lang.language, ...extract(tree.rootNode) };
      } finally {
        tree.delete();
      }
    },
  };
}

type Extracted = Omit<ParsedFile, "path" | "language">;

function children(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function line(row: number): number {
  return row + 1;
}

/**
 * Generic walk shared by both languages. `describe` says whether a node starts a symbol;
 * calls are attributed to the innermost enclosing symbol.
 */
function walk(
  root: Node,
  hooks: {
    describe(node: Node, enclosing: ParsedSymbol | null): { kind: SymbolKind; name: string; rangeNode: Node } | null;
    callName(node: Node): string | null;
    importOf(node: Node): ParsedImport[] | null;
    isBranch(node: Node): boolean;
  },
): Extracted {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  let complexity = 0;

  const visit = (node: Node, enclosing: ParsedSymbol | null) => {
    if (hooks.isBranch(node)) complexity++;

    const imp = hooks.importOf(node);
    if (imp) imports.push(...imp);

    const call = hooks.callName(node);
    if (call && enclosing && !enclosing.calls.includes(call)) enclosing.calls.push(call);

    let next = enclosing;
    const desc = hooks.describe(node, enclosing);
    if (desc) {
      const sym: ParsedSymbol = {
        kind: desc.kind,
        name: desc.name,
        qualifiedName: enclosing ? `${enclosing.qualifiedName}.${desc.name}` : desc.name,
        startLine: line(desc.rangeNode.startPosition.row),
        endLine: line(desc.rangeNode.endPosition.row),
        calls: [],
      };
      symbols.push(sym);
      next = sym;
    }
    for (const child of children(node)) visit(child, next);
  };

  visit(root, null);
  return { symbols, imports, complexity };
}

// ---------------------------------------------------------------- Python

const PY_BRANCHES = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
  "boolean_operator",
  "case_clause",
  "for_in_clause",
  "if_clause",
]);

function extractPython(root: Node): Extracted {
  return walk(root, {
    isBranch: (n) => PY_BRANCHES.has(n.type),
    describe(node, enclosing) {
      if (node.type !== "function_definition" && node.type !== "class_definition") return null;
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const rangeNode = node.parent?.type === "decorated_definition" ? node.parent : node;
      if (node.type === "class_definition") return { kind: "class", name, rangeNode };
      return { kind: enclosing?.kind === "class" ? "method" : "function", name, rangeNode };
    },
    callName(node) {
      if (node.type !== "call") return null;
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier") return fn.text;
      if (fn?.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
      return null;
    },
    importOf(node) {
      if (node.type === "import_statement") {
        return children(node).flatMap((c) => {
          const dotted = c.type === "aliased_import" ? c.childForFieldName("name") : c;
          return dotted?.type === "dotted_name" ? [{ module: dotted.text, level: 0, names: [] }] : [];
        });
      }
      if (node.type === "import_from_statement") {
        const mod = node.childForFieldName("module_name");
        if (!mod) return null;
        let module = mod.text;
        let level = 0;
        if (mod.type === "relative_import") {
          const prefix = children(mod).find((c) => c.type === "import_prefix")?.text ?? mod.text.match(/^\.+/)?.[0] ?? "";
          level = prefix.length;
          module = children(mod).find((c) => c.type === "dotted_name")?.text ?? "";
        }
        const names = node.childrenForFieldName("name")
          .filter((c): c is Node => c !== null)
          .map((c) => (c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.text))
          .filter((n): n is string => !!n);
        return [{ module, level, names }];
      }
      return null;
    },
  });
}

// ---------------------------------------------------------------- TypeScript / JavaScript

const TS_BRANCHES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const TS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function stringValue(node: Node | null | undefined): string | null {
  if (!node || node.type !== "string") return null;
  return children(node).find((c) => c.type === "string_fragment")?.text ?? "";
}

function extractTs(root: Node): Extracted {
  return walk(root, {
    isBranch(n) {
      if (TS_BRANCHES.has(n.type)) return true;
      if (n.type === "binary_expression") {
        const op = n.childForFieldName("operator")?.type;
        return op === "&&" || op === "||" || op === "??";
      }
      return false;
    },
    describe(node, enclosing) {
      const name = node.childForFieldName("name");
      switch (node.type) {
        case "function_declaration":
        case "generator_function_declaration":
          return name ? { kind: "function", name: name.text, rangeNode: exportWrapper(node) } : null;
        case "class_declaration":
        case "abstract_class_declaration":
          return name ? { kind: "class", name: name.text, rangeNode: exportWrapper(node) } : null;
        case "method_definition":
          return name ? { kind: "method", name: name.text, rangeNode: node } : null;
        case "variable_declarator": {
          const value = node.childForFieldName("value");
          if (name?.type !== "identifier" || !value || !TS_FUNCTION_VALUES.has(value.type)) return null;
          // Range covers the whole `const x = ...` statement (and `export`).
          const decl = node.parent ?? node;
          return { kind: enclosing?.kind === "class" ? "method" : "function", name: name.text, rangeNode: exportWrapper(decl) };
        }
        default:
          return null;
      }
    },
    callName(node) {
      if (node.type !== "call_expression" && node.type !== "new_expression") return null;
      const fn = node.childForFieldName(node.type === "call_expression" ? "function" : "constructor");
      if (fn?.type === "identifier") return fn.text;
      if (fn?.type === "member_expression") return fn.childForFieldName("property")?.text ?? null;
      return null;
    },
    importOf(node) {
      if (node.type === "import_statement" || node.type === "export_statement") {
        const source = stringValue(node.childForFieldName("source"));
        if (source === null) return null;
        return [{ module: source, level: 0, names: importedNames(node) }];
      }
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        const isRequire = fn?.type === "identifier" && fn.text === "require";
        if (!isRequire && fn?.type !== "import") return null;
        const arg = children(node.childForFieldName("arguments") ?? node)[0];
        const source = stringValue(arg);
        return source === null ? null : [{ module: source, level: 0, names: [] }];
      }
      return null;
    },
  });
}

function exportWrapper(node: Node): Node {
  return node.parent?.type === "export_statement" ? node.parent : node;
}

function importedNames(node: Node): string[] {
  const names: string[] = [];
  const visit = (n: Node) => {
    if (n.type === "import_specifier" || n.type === "export_specifier") {
      const name = n.childForFieldName("name")?.text;
      if (name) names.push(name);
      return;
    }
    if (n.type === "import_clause") {
      for (const c of children(n)) if (c.type === "identifier") names.push(c.text);
    }
    if (n.type === "namespace_import") {
      const id = children(n).find((c) => c.type === "identifier");
      if (id) names.push(id.text);
      return;
    }
    for (const c of children(n)) visit(c);
  };
  visit(node);
  return names;
}

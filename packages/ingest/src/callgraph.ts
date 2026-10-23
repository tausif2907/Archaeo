import type { ImportEdge } from "./resolve";
import type { ParsedFile, ParsedSymbol } from "./types";

/** Stable key for a parsed symbol, used to map to DB ids after insert. */
export function symbolKey(path: string, sym: Pick<ParsedSymbol, "qualifiedName" | "startLine">): string {
  return `${path}#${sym.qualifiedName}@${sym.startLine}`;
}

export interface CallEdge {
  from: string;
  to: string;
}

/**
 * Best-effort call edges. A call `foo()` inside symbol S of file F resolves to, in order:
 *  1. symbols named `foo` in F,
 *  2. symbols named `foo` in files F imports,
 *  3. the only symbol named `foo` in the whole repo.
 * Anything ambiguous is dropped rather than guessed.
 */
export function buildCallEdges(files: ParsedFile[], importEdges: ImportEdge[]): CallEdge[] {
  const byFileAndName = new Map<string, Map<string, string[]>>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const local = new Map<string, string[]>();
    for (const sym of file.symbols) {
      const key = symbolKey(file.path, sym);
      local.set(sym.name, [...(local.get(sym.name) ?? []), key]);
      byName.set(sym.name, [...(byName.get(sym.name) ?? []), key]);
    }
    byFileAndName.set(file.path, local);
  }

  const importsOf = new Map<string, string[]>();
  for (const e of importEdges) importsOf.set(e.from, [...(importsOf.get(e.from) ?? []), e.to]);

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const sym of file.symbols) {
      const from = symbolKey(file.path, sym);
      for (const call of sym.calls) {
        const target = resolveCall(call, file.path, from, byFileAndName, importsOf.get(file.path) ?? [], byName);
        if (!target) continue;
        const k = `${from}\0${target}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from, to: target });
      }
    }
  }
  return edges;
}

function resolveCall(
  name: string,
  path: string,
  self: string,
  byFileAndName: Map<string, Map<string, string[]>>,
  imported: string[],
  byName: Map<string, string[]>,
): string | null {
  const pick = (keys: string[] | undefined) => {
    const others = (keys ?? []).filter((k) => k !== self);
    return others.length === 1 ? others[0]! : null;
  };
  const local = byFileAndName.get(path)?.get(name);
  if (local?.length) return pick(local);

  const fromImports = imported.flatMap((p) => byFileAndName.get(p)?.get(name) ?? []);
  if (fromImports.length) return pick(fromImports);

  return pick(byName.get(name));
}

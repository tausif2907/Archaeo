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
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|[._](test|spec)\.[jt]sx?$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

export function buildCallEdges(files: ParsedFile[], importEdges: ImportEdge[]): CallEdge[] {
  const byFileAndName = new Map<string, Map<string, string[]>>();
  // Only symbols other files can reach: not nested inside a function (closures are local).
  const exported = new Map<string, Map<string, string[]>>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const local = new Map<string, string[]>();
    const visible = new Map<string, string[]>();
    const functions = new Set(file.symbols.filter((s) => s.kind !== "class").map((s) => s.qualifiedName));
    for (const sym of file.symbols) {
      const key = symbolKey(file.path, sym);
      local.set(sym.name, [...(local.get(sym.name) ?? []), key]);
      const parent = sym.qualifiedName.includes(".") ? sym.qualifiedName.slice(0, sym.qualifiedName.lastIndexOf(".")) : null;
      if (parent && functions.has(parent)) continue;
      visible.set(sym.name, [...(visible.get(sym.name) ?? []), key]);
      byName.set(sym.name, [...(byName.get(sym.name) ?? []), key]);
    }
    byFileAndName.set(file.path, local);
    exported.set(file.path, visible);
  }

  const importsOf = new Map<string, string[]>();
  for (const e of importEdges) importsOf.set(e.from, [...(importsOf.get(e.from) ?? []), e.to]);

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const sym of file.symbols) {
      const from = symbolKey(file.path, sym);
      for (const call of sym.calls) {
        const target = resolveCall(call, file.path, from, byFileAndName, exported, importsOf.get(file.path) ?? [], byName);
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
  exported: Map<string, Map<string, string[]>>,
  imported: string[],
  byName: Map<string, string[]>,
): string | null {
  const pick = (keys: string[] | undefined) => {
    const others = (keys ?? []).filter((k) => k !== self);
    return others.length === 1 ? others[0]! : null;
  };
  const local = byFileAndName.get(path)?.get(name);
  if (local?.length) {
    const unique = pick(local);
    if (unique) return unique;
    // `self.invoke()` inside Command.main: prefer a method of the caller's own class.
    const callerName = self.slice(self.indexOf("#") + 1, self.lastIndexOf("@"));
    const cls = callerName.includes(".") ? callerName.slice(0, callerName.lastIndexOf(".")) : null;
    return cls ? pick(local.filter((k) => k.slice(k.indexOf("#") + 1, k.lastIndexOf("@")) === `${cls}.${name}`)) : null;
  }

  const fromImports = imported.flatMap((p) => exported.get(p)?.get(name) ?? []);
  if (fromImports.length) return pick(fromImports);

  // Repo-wide unique name: never from application code into test code.
  const callerIsTest = isTestPath(path);
  return pick((byName.get(name) ?? []).filter((k) => callerIsTest || !isTestPath(k.slice(0, k.indexOf("#")))));
}

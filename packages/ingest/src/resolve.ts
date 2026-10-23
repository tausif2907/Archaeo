import { posix } from "node:path";
import type { ParsedFile, ParsedImport } from "./types";

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PY_SOURCE_ROOTS = ["", "src/", "lib/", "python/"];

/** Resolves import specifiers to repo-relative file paths. Best effort: unresolved imports return null. */
export class ImportResolver {
  private readonly files: Set<string>;
  private readonly pyModules = new Map<string, string>();

  constructor(paths: Iterable<string>) {
    this.files = new Set(paths);
    for (const path of this.files) {
      if (!path.endsWith(".py")) continue;
      for (const root of PY_SOURCE_ROOTS) {
        if (!path.startsWith(root)) continue;
        const rel = path.slice(root.length, -3);
        const mod = (rel.endsWith("/__init__") ? rel.slice(0, -"/__init__".length) : rel).replaceAll("/", ".");
        if (mod && !this.pyModules.has(mod)) this.pyModules.set(mod, path);
      }
    }
  }

  /** Every file the import refers to (a `from pkg import a, b` can point at several submodules). */
  resolve(fromPath: string, imp: ParsedImport): string[] {
    return fromPath.endsWith(".py") ? this.resolvePython(fromPath, imp) : this.resolveTs(fromPath, imp.module);
  }

  private resolveTs(fromPath: string, spec: string): string[] {
    let base: string;
    if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    else if (spec.startsWith("@/") || spec.startsWith("~/")) base = `src/${spec.slice(2)}`;
    else return [];

    const stripped = base.replace(/\.(m|c)?js$/, "");
    const candidates = [base, ...TS_EXTS.map((e) => stripped + e), ...TS_EXTS.map((e) => `${stripped}/index${e}`)];
    const hit = candidates.find((c) => this.files.has(c));
    return hit ? [hit] : [];
  }

  private resolvePython(fromPath: string, imp: ParsedImport): string[] {
    if (imp.level > 0) {
      // `.` = this file's package; each extra dot goes one package up.
      let pkgDir = posix.dirname(fromPath);
      for (let i = 1; i < imp.level; i++) pkgDir = posix.dirname(pkgDir);
      const pkgPath = pkgDir === "." ? "" : pkgDir;
      const relMod = [pkgPath.replaceAll("/", "."), imp.module].filter(Boolean).join(".");
      return this.lookupPython(relMod, imp.names, pkgPath);
    }
    return this.lookupPython(imp.module, imp.names, null);
  }

  /** `relativeDir` is set for relative imports: the module path is then rooted at the repo, not a source root. */
  private lookupPython(moduleName: string, names: string[], relativeDir: string | null): string[] {
    const find = (mod: string): string | undefined => {
      if (relativeDir !== null) {
        const path = mod.replaceAll(".", "/");
        return [`${path}.py`, `${path}/__init__.py`].find((c) => this.files.has(c));
      }
      return this.pyModules.get(mod);
    };

    const out = new Set<string>();
    // `from pkg import sub` may import submodule `pkg.sub` rather than a name defined in pkg/__init__.py
    let needsModule = names.length === 0;
    for (const name of names) {
      const sub = find(moduleName ? `${moduleName}.${name}` : name);
      if (sub) out.add(sub);
      else needsModule = true;
    }
    const direct = moduleName ? find(moduleName) : undefined;
    if (direct && needsModule) out.add(direct);
    return [...out];
  }
}

export interface ImportEdge {
  from: string;
  to: string;
}

/** File-level import edges, deduplicated, without self-loops. */
export function buildImportEdges(files: ParsedFile[], resolver: ImportResolver): ImportEdge[] {
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];
  for (const file of files) {
    for (const imp of file.imports) {
      for (const to of resolver.resolve(file.path, imp)) {
        const key = `${file.path}\0${to}`;
        if (to === file.path || seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: file.path, to });
      }
    }
  }
  return edges;
}

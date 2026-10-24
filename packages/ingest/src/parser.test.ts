import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCallEdges, symbolKey } from "./callgraph";
import { createParser, type SourceParser } from "./parser";
import { buildImportEdges, ImportResolver } from "./resolve";
import type { ParsedFile } from "./types";

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

let parser: SourceParser;
beforeAll(async () => {
  parser = await createParser();
});

function parseFixture(root: string, path: string): ParsedFile {
  const parsed = parser.parse(path, readFileSync(join(FIXTURES, root, path), "utf8"));
  if (!parsed) throw new Error(`not parsed: ${path}`);
  return parsed;
}

const brief = (f: ParsedFile) => f.symbols.map((s) => `${s.kind} ${s.qualifiedName} ${s.startLine}-${s.endLine}`);

describe("python parser", () => {
  it("extracts functions, classes, methods and nested functions with line ranges", () => {
    const f = parseFixture("py", "pkg/core.py");
    expect(f.language).toBe("python");
    expect(brief(f)).toEqual([
      "function top_level 8-11",
      "function helper_two 14-15",
      "class Command 18-38",
      "method Command.__init__ 21-22",
      "method Command.title 24-26", // includes the @property decorator
      "method Command.invoke 28-32",
      "method Command.run 34-38",
      "function Command.run.inner 35-36",
    ]);
  });

  it("extracts absolute and relative imports", () => {
    const f = parseFixture("py", "pkg/core.py");
    expect(f.imports).toEqual([
      { module: "os", level: 0, names: [] },
      { module: "typing", level: 0, names: [] },
      { module: "", level: 1, names: ["utils"] },
      { module: "utils", level: 1, names: ["slugify", "Helper"] },
      { module: "shared.config", level: 2, names: ["load_config"] },
    ]);
  });

  it("records calls per innermost symbol and counts branches", () => {
    const f = parseFixture("py", "pkg/core.py");
    const calls = Object.fromEntries(f.symbols.map((s) => [s.qualifiedName, s.calls]));
    expect(calls["top_level"]).toEqual(["slugify", "helper_two"]);
    expect(calls["Command.invoke"]).toEqual(["run", "fallback", "Helper"]);
    expect(calls["Command.run"]).toEqual(["inner"]);
    expect(calls["Command.run.inner"]).toEqual(["top_level"]);
    // if, boolean_operator(or), for_in_clause, if_clause, except_clause, conditional_expression
    expect(f.complexity).toBe(6);
  });
});

describe("typescript / javascript parser", () => {
  it("extracts functions, classes, methods and arrow-function consts", () => {
    const f = parseFixture("ts", "src/server.ts");
    expect(f.language).toBe("typescript");
    expect(brief(f)).toEqual([
      "function lazy 6-6",
      "function createServer 8-18",
      "class UserService 20-30",
      "method UserService.get 23-25",
      "method UserService.render 27-29",
      "function toUpper 32-32",
    ]);
  });

  it("extracts static imports, re-exports and dynamic imports", () => {
    const f = parseFixture("ts", "src/server.ts");
    expect(f.imports).toEqual([
      { module: "express", level: 0, names: ["express"] },
      { module: "./lib/format", level: 0, names: ["formatUser", "User"] },
      { module: "./db", level: 0, names: ["db"] },
      { module: "./lib/format", level: 0, names: ["formatUser"] },
      { module: "./lib/lazy", level: 0, names: [] },
    ]);
  });

  it("records calls and counts branches", () => {
    const f = parseFixture("ts", "src/server.ts");
    const calls = Object.fromEntries(f.symbols.map((s) => [s.qualifiedName, s.calls]));
    expect(calls["createServer"]).toEqual(["express", "get", "findUser", "send", "status", "formatUser", "listen"]);
    expect(calls["UserService.render"]).toEqual(["formatUser"]);
    // if, ||, ternary, ??
    expect(f.complexity).toBe(4);
  });

  it("parses JavaScript with require()", () => {
    const f = parseFixture("ts", "src/db.js");
    expect(f.language).toBe("javascript");
    expect(brief(f)).toEqual(["function findUser 3-5"]);
    expect(f.imports).toEqual([{ module: "./store.json", level: 0, names: [] }]);
  });

  it("skips files it should not parse", () => {
    expect(parser.parse("README.md", "# hi")).toBeNull();
    expect(parser.parse("node_modules/x/index.js", "")).toBeNull();
    expect(parser.parse("types/global.d.ts", "")).toBeNull();
  });
});

describe("import resolution and call graph", () => {
  it("resolves python relative imports, submodules and src/ roots", () => {
    const r = new ImportResolver(["src/pkg/__init__.py", "src/pkg/core.py", "src/pkg/utils.py", "src/shared/config.py", "tests/test_core.py"]);
    expect(r.resolve("src/pkg/core.py", { module: "", level: 1, names: ["utils"] })).toEqual(["src/pkg/utils.py"]);
    expect(r.resolve("src/pkg/core.py", { module: "utils", level: 1, names: ["slugify"] })).toEqual(["src/pkg/utils.py"]);
    expect(r.resolve("src/pkg/core.py", { module: "shared.config", level: 2, names: ["x"] })).toEqual(["src/shared/config.py"]);
    expect(r.resolve("tests/test_core.py", { module: "pkg.core", level: 0, names: [] })).toEqual(["src/pkg/core.py"]);
    expect(r.resolve("tests/test_core.py", { module: "pkg", level: 0, names: ["core", "VERSION"] }).sort()).toEqual([
      "src/pkg/__init__.py",
      "src/pkg/core.py",
    ]);
    expect(r.resolve("tests/test_core.py", { module: "os", level: 0, names: [] })).toEqual([]);
  });

  it("resolves TS relative specifiers with extensions and index files", () => {
    const r = new ImportResolver(["src/server.ts", "src/lib/format.ts", "src/db.js", "src/util/index.ts"]);
    expect(r.resolve("src/server.ts", { module: "./lib/format", level: 0, names: [] })).toEqual(["src/lib/format.ts"]);
    expect(r.resolve("src/server.ts", { module: "./lib/format.js", level: 0, names: [] })).toEqual(["src/lib/format.ts"]);
    expect(r.resolve("src/server.ts", { module: "./db", level: 0, names: [] })).toEqual(["src/db.js"]);
    expect(r.resolve("src/lib/format.ts", { module: "../util", level: 0, names: [] })).toEqual(["src/util/index.ts"]);
    expect(r.resolve("src/server.ts", { module: "express", level: 0, names: [] })).toEqual([]);
  });

  it("never resolves calls to closures in other files or from app code into tests", () => {
    const sym = (qualifiedName: string, kind: "function" | "method" | "class", startLine: number, calls: string[] = []) => ({
      kind,
      name: qualifiedName.split(".").pop()!,
      qualifiedName,
      startLine,
      endLine: startLine + 1,
      calls,
    });
    const files: ParsedFile[] = [
      { path: "src/app/utils.py", language: "python", complexity: 0, imports: [], symbols: [sym("detect", "function", 1, ["exists", "helper"])] },
      { path: "tests/test_paths.py", language: "python", complexity: 0, imports: [], symbols: [sym("test_path", "function", 1, ["detect"]), sym("test_path.exists", "function", 2)] },
      { path: "src/app/core.py", language: "python", complexity: 0, imports: [], symbols: [sym("run", "function", 1, ["helper"]), sym("run.helper", "function", 2), sym("Cmd", "class", 5), sym("Cmd.helper", "method", 6)] },
    ];
    const calls = buildCallEdges(files, []).map((e) => `${e.from} -> ${e.to}`);
    // `exists` (really os.path.exists) must not bind to a closure inside a test. From other files, `helper`
    // resolves only to the class method, never to the closure `run.helper`. Inside core.py, `run` → `helper`
    // is ambiguous (closure or method), so no edge is guessed.
    expect(calls).toEqual(["src/app/utils.py#detect@1 -> src/app/core.py#Cmd.helper@6", "tests/test_paths.py#test_path@1 -> src/app/utils.py#detect@1"]);
  });

  it("resolves an ambiguous self-call to the caller's own class", () => {
    const sym = (qualifiedName: string, startLine: number, calls: string[] = []) => ({
      kind: "method" as const,
      name: qualifiedName.split(".").pop()!,
      qualifiedName,
      startLine,
      endLine: startLine + 1,
      calls,
    });
    const files: ParsedFile[] = [
      { path: "core.py", language: "python", complexity: 0, imports: [], symbols: [sym("Command.main", 1, ["invoke"]), sym("Command.invoke", 3), sym("Context.invoke", 5)] },
    ];
    expect(buildCallEdges(files, [])).toEqual([{ from: "core.py#Command.main@1", to: "core.py#Command.invoke@3" }]);
  });

  it("builds import and call edges across files", () => {
    const files = [parseFixture("ts", "src/server.ts"), parseFixture("ts", "src/lib/format.ts"), parseFixture("ts", "src/db.js")];
    const resolver = new ImportResolver(files.map((f) => f.path));
    const imports = buildImportEdges(files, resolver);
    expect(imports).toEqual([
      { from: "src/server.ts", to: "src/lib/format.ts" },
      { from: "src/server.ts", to: "src/db.js" },
    ]);

    const calls = buildCallEdges(files, imports);
    const format = files[1]!.symbols[0]!;
    const findUser = files[2]!.symbols[0]!;
    const server = files[0]!;
    const key = (path: string, name: string) => symbolKey(path, server.symbols.find((s) => s.qualifiedName === name)!);
    expect(calls).toContainEqual({ from: key("src/server.ts", "createServer"), to: symbolKey("src/lib/format.ts", format) });
    expect(calls).toContainEqual({ from: key("src/server.ts", "createServer"), to: symbolKey("src/db.js", findUser) });
    expect(calls).toContainEqual({ from: key("src/server.ts", "UserService.get"), to: symbolKey("src/db.js", findUser) });
    // `get` on app/cache is ambiguous with UserService.get only via self → never a self-edge
    expect(calls.every((e) => e.from !== e.to)).toBe(true);
  });
});

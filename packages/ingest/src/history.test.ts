import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitChunkText, codeChunks } from "./chunk";
import { computeChurn, parseGitLog } from "./git";
import { linkPullRequests, prRefsInMessage } from "./github";
import { countLoc, RepoTooLargeError, scanSourceFiles } from "./scan";

const R = "\x1e";
const F = "\x1f";

describe("git log parsing", () => {
  const log = [
    `${R}aaa111${F}Ada${F}2024-01-02T10:00:00+00:00${F}Fix parser (#12)\n\nLonger body.\n${F}\n\n3\t1\tsrc/a.py\n-\t-\tlogo.png\n`,
    `${R}bbb222${F}Linus${F}2023-05-06T10:00:00+00:00${F}Merge pull request #7 from x/y\n${F}\n`,
    `${R}ccc333${F}Ada${F}2022-01-01T00:00:00Z${F}Initial commit${F}\n\n10\t0\tsrc/a.py\n4\t0\tsrc/b.py\n`,
  ].join("");

  it("parses commits, messages and numstat", () => {
    const commits = parseGitLog(log);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toMatchObject({ sha: "aaa111", author: "Ada", message: "Fix parser (#12)\n\nLonger body." });
    expect(commits[0]!.date.toISOString()).toBe("2024-01-02T10:00:00.000Z");
    expect(commits[0]!.files).toEqual([
      { path: "src/a.py", additions: 3, deletions: 1 },
      { path: "logo.png", additions: 0, deletions: 0 },
    ]);
    expect(commits[1]!.files).toEqual([]);
  });

  it("computes churn per path", () => {
    const churn = computeChurn(parseGitLog(log));
    expect(churn.get("src/a.py")).toBe(2);
    expect(churn.get("src/b.py")).toBe(1);
  });

  it("links PRs to commits by merge SHA and message references", () => {
    expect(prRefsInMessage("Fix parser (#12)\n\nbody (#99)")).toEqual([12]);
    expect(prRefsInMessage("Merge pull request #7 from x/y")).toEqual([7]);
    expect(prRefsInMessage("Refs #5 in the subject")).toEqual([]);
    const links = linkPullRequests(
      [
        { number: 12, mergeCommitSha: "aaa111" },
        { number: 30, mergeCommitSha: "ccc333" },
        { number: 31, mergeCommitSha: "not-in-history" },
      ],
      parseGitLog(log),
    );
    expect(links.get(12)).toEqual(["aaa111"]);
    expect(links.get(7)).toEqual(["bbb222"]);
    expect(links.get(30)).toEqual(["ccc333"]);
    expect(links.has(31)).toBe(false);
  });
});

describe("scanning and chunking", () => {
  it("counts non-blank lines and enforces the LOC cap", async () => {
    expect(countLoc("a\n\n  \nb\n")).toBe(2);
    const dir = await mkdtemp(join(tmpdir(), "archaeo-scan-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/a.py"), "x = 1\ny = 2\n");
    await writeFile(join(dir, "src/b.ts"), "export const z = 3;\n");
    await writeFile(join(dir, "README.md"), "# readme\n");

    const files = await scanSourceFiles(dir, ["src/a.py", "src/b.ts", "README.md"], { maxLoc: 10 });
    expect(files.map((f) => [f.path, f.language, f.loc])).toEqual([
      ["src/a.py", "python", 2],
      ["src/b.ts", "typescript", 1],
    ]);
    expect(files[0]!.hash).toMatch(/^[0-9a-f]{40}$/);

    await expect(scanSourceFiles(dir, ["src/a.py", "src/b.ts"], { maxLoc: 2 })).rejects.toBeInstanceOf(RepoTooLargeError);
  });

  it("chunks symbols, trimming class bodies to their header", () => {
    const content = ["class A:", "    x = 1", "    def m(self):", "        return 1", "", "def f():", "    return 2"].join("\n");
    const chunks = codeChunks(
      { path: "a.py", language: "python", content, hash: "h", loc: 6 },
      {
        path: "a.py",
        language: "python",
        complexity: 0,
        imports: [],
        symbols: [
          { kind: "class", name: "A", qualifiedName: "A", startLine: 1, endLine: 4, calls: [] },
          { kind: "method", name: "m", qualifiedName: "A.m", startLine: 3, endLine: 4, calls: [] },
          { kind: "function", name: "f", qualifiedName: "f", startLine: 6, endLine: 7, calls: [] },
        ],
      },
    );
    expect(chunks.map((c) => c.text)).toEqual([
      "a.py:1-4 class A\nclass A:\n    x = 1",
      "a.py:3-4 method A.m\n    def m(self):\n        return 1",
      "a.py:6-7 function f\ndef f():\n    return 2",
    ]);
  });

  it("formats commit chunks", () => {
    const text = commitChunkText({
      sha: "abc",
      author: "Ada",
      date: new Date("2024-01-02T00:00:00Z"),
      message: "Fix it",
      files: [{ path: "a.py", additions: 1, deletions: 2 }],
    });
    expect(text).toBe("commit abc\nauthor Ada, 2024-01-02\n\nFix it\n\nfiles:\na.py (+1/-2)");
  });
});

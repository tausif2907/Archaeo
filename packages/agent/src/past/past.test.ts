import { describe, expect, it } from "vitest";
import { createModels, loadModelConfig, MockProvider } from "@archaeo/models";
import { buildAreaMapper, normalizePath } from "./areas";
import { citationIndex, findCitations, validateCitations } from "./citations";
import { detectEras, type EraCommit } from "./eras";
import { cleanExcerpt, parseJsonObject } from "./json";
import { buildEraEvidence, eraFingerprint, fallbackNarrative, writeEraNarrative, type EvidenceCommit } from "./narrative";

const SHAS = ["3c4cacb1bba9f2b6f62628cf1783ce64aed62436", "3c4cacf000000000000000000000000000000000", "af24c8d0000000000000000000000000000000aa"];
const index = citationIndex(SHAS, [1622, 1329, 7]);

describe("areas", () => {
  it("treats src-layout moves as the same path and splits the dominant package", () => {
    expect(normalizePath("src/click/core.py")).toBe("click/core.py");
    const paths = ["click/core.py", "src/click/core.py", "src/click/types.py", "click/utils.py", "docs/index.rst", "tests/test_a.py", "CHANGES.rst"];
    const areaOf = buildAreaMapper(paths);
    expect(areaOf("src/click/core.py")).toBe("click/core");
    expect(areaOf("click/core.py")).toBe("click/core");
    expect(areaOf("docs/api.rst")).toBe("docs");
    expect(areaOf("CHANGES.rst")).toBe("(root)");
  });
});

describe("detectEras", () => {
  const day = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m - 1, d));
  function commitsFor(year: number, files: string[], n: number, author = "Ada"): EraCommit[] {
    return Array.from({ length: n }, (_, i) => ({ sha: `${year}-${files[0]}-${i}`, date: day(year, 1 + (i % 12), 1 + (i % 27)), author, files }));
  }

  it("returns nothing for an empty history", () => {
    expect(detectEras([], [])).toEqual([]);
  });

  it("finds eras at shifts in where the work happens, covering every commit in order", () => {
    const commits = [
      ...commitsFor(2014, ["pkg/core.py"], 40),
      ...commitsFor(2015, ["pkg/core.py"], 30),
      ...commitsFor(2016, ["docs/a.rst"], 30),
      ...commitsFor(2017, ["docs/b.rst"], 30),
      ...commitsFor(2018, ["pkg/completion.py"], 30),
      ...commitsFor(2019, ["pkg/completion.py"], 30),
      ...commitsFor(2020, ["tests/t.py"], 30),
      ...commitsFor(2021, ["tests/t.py"], 30),
    ];
    const eras = detectEras(commits, [], { minEras: 4, maxEras: 4 });
    expect(eras).toHaveLength(4);
    expect(eras.flatMap((e) => e.commits)).toHaveLength(commits.length);
    for (let i = 1; i < eras.length; i++) expect(eras[i]!.start >= eras[i - 1]!.end).toBe(true);
    // Each era is dominated by one area, in historical order.
    expect(eras.map((e) => e.areas[0]!.area)).toEqual(["pkg/core", "docs", "pkg/completion", "tests"]);
  });

  it("uses release tags as window boundaries and lists releases per era", () => {
    const commits = [...commitsFor(2014, ["pkg/a.py"], 24), ...commitsFor(2015, ["pkg/a.py"], 24), ...commitsFor(2016, ["pkg/b.py"], 24)];
    const releases = ["1.0", "1.1", "1.2", "2.0", "2.1", "2.2", "3.0"].map((name, i) => ({ name, date: day(2014, 3 + i * 4, 15) }));
    const eras = detectEras(commits, releases, { minEras: 3, maxEras: 3 });
    expect(eras).toHaveLength(3);
    const all = eras.flatMap((e) => e.releases);
    expect(new Set(all).size).toBe(all.length);
    expect(eras[0]!.releases[0]).toBe("1.0");
  });
});

describe("citations", () => {
  it("resolves unique SHA prefixes only", () => {
    expect(index.resolveSha("3c4cacb")).toBe(SHAS[0]);
    expect(index.resolveSha("3c4cac")).toBeNull(); // too short
    expect(index.resolveSha("af24c8d")).toBe(SHAS[2]);
    expect(index.resolveSha("deadbee")).toBeNull();
  });

  it("keeps real citations and removes invented ones", () => {
    const text = "Completion was redesigned [3c4cacb, #1622]. It was later rewritten [deadbee1]. See also [#9999] and #1329. A [link](https://x.y) stays.";
    const checked = validateCitations(text, index);
    expect(checked.text).toBe("Completion was redesigned [3c4cacb, #1622]. It was later rewritten. See also and #1329. A [link](https://x.y) stays.");
    expect(checked.validShas).toEqual([SHAS[0]]);
    expect(checked.validNumbers.sort()).toEqual([1329, 1622]);
    expect(checked.invalid.sort()).toEqual(["#9999", "deadbee1"]);
  });

  it("checks bare SHAs in prose but ignores words, years and URLs", () => {
    const checked = validateCitations("Introduced in af24c8d, not abcdef12, in 2019. https://github.com/a/b/commit/abc1234ff", index);
    expect(checked.text).toBe("Introduced in af24c8d, not, in 2019. https://github.com/a/b/commit/abc1234ff");
    expect(findCitations("see [3c4cacb] and #7, not &#39;")).toEqual({ shas: ["3c4cacb"], numbers: [7] });
  });
});

describe("era narratives", () => {
  const draft = {
    start: new Date("2020-06-01T00:00:00Z"),
    end: new Date("2021-05-11T00:00:00Z"),
    commits: [
      { sha: SHAS[0]!, date: new Date("2020-08-04T00:00:00Z"), author: "Amy", files: ["src/click/shell_completion.py"] },
      { sha: SHAS[2]!, date: new Date("2020-09-01T00:00:00Z"), author: "David", files: ["docs/x.rst"] },
    ],
    areas: [
      { area: "click/shell_completion", share: 0.5 },
      { area: "docs", share: 0.5 },
    ],
    releases: ["8.0.0"],
  };
  const commitsBySha = new Map<string, EvidenceCommit>([
    [SHAS[0]!, { sha: SHAS[0]!, message: "redesign shell completion system", author: "Amy", date: draft.commits[0]!.date, linesChanged: 900 }],
    [SHAS[2]!, { sha: SHAS[2]!, message: "docs tweak", author: "David", date: draft.commits[1]!.date, linesChanged: 10 }],
  ]);
  const prs = [
    { number: 1622, title: "Redesign shell completion", body: "<!-- template -->\nThis replaces the old completion system with an extensible one.", mergedAt: new Date("2020-10-03T00:00:00Z"), linkedCommitShas: [SHAS[0]!] },
    { number: 7, title: "Old PR", body: null, mergedAt: new Date("2015-01-01T00:00:00Z"), linkedCommitShas: [] },
  ];

  it("builds evidence from PRs merged in the era and commits not covered by them", () => {
    const ev = buildEraEvidence(draft, prs, commitsBySha);
    expect(ev.keyPrs.map((p) => p.number)).toEqual([1622]);
    expect(ev.keyPrs[0]!.excerpt).toBe("This replaces the old completion system with an extensible one.");
    expect(ev.keyCommits.map((c) => c.sha)).toEqual(["af24c8d"]);
    expect(ev.topAuthors.map((a) => a.name).sort()).toEqual(["Amy", "David"]);
    expect(eraFingerprint(ev)).toBe(eraFingerprint(buildEraEvidence(draft, prs, commitsBySha)));
  });

  it("falls back to a cited, evidence-only narrative when the model output is unusable", async () => {
    const models = createModels({ config: loadModelConfig({}) });
    const ev = buildEraEvidence(draft, prs, commitsBySha);
    const out = await writeEraNarrative(models, ev, index);
    expect(out.fallback).toBe(true);
    expect(out.title).toBe("Release 8.0.0: shell_completion");
    expect(out.narrative).toContain("Redesign shell completion [#1622]");
    expect(out.narrative).toContain("docs tweak [af24c8d]");
    const cited = findCitations(out.narrative);
    expect(cited.shas.every((s) => index.resolveSha(s))).toBe(true);
    expect(cited.numbers.every((n) => index.hasNumber(n))).toBe(true);
  });

  it("uses model JSON when it is cited, dropping invented citations", async () => {
    const mock = new MockProvider({
      script: [
        {
          content: '```json\n{"title": "The completion rewrite", "narrative": "Amy redesigned completion [3c4cacb, #1622]. A ghost change [1234567abc]."}\n```',
          toolCalls: [],
          finishReason: "stop",
        },
      ],
    });
    const models = createModels({ config: loadModelConfig({}), providers: { mock } });
    const out = await writeEraNarrative(models, buildEraEvidence(draft, prs, commitsBySha), index);
    expect(out).toEqual({
      title: "The completion rewrite",
      narrative: "Amy redesigned completion [3c4cacb, #1622]. A ghost change.",
      fallback: false,
      invalidCitations: ["1234567abc"],
    });
  });

  it("produces a plain date title when there are no releases", () => {
    const ev = buildEraEvidence({ ...draft, releases: [] }, [], commitsBySha);
    expect(fallbackNarrative(ev).title).toBe("Jun 2020 – May 2021: shell_completion");
  });
});

describe("json helpers", () => {
  it("parses fenced JSON and rejects junk", () => {
    expect(parseJsonObject('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("[mock answer] nope")).toBeNull();
    expect(parseJsonObject("[1,2]")).toBeNull();
  });

  it("cleans PR bodies down to the first real paragraph", () => {
    expect(cleanExcerpt("<!-- hi -->\n## Checklist\n- [x] tests\n\nShort.\n\nThis fixes the parser when options repeat.")).toBe("This fixes the parser when options repeat.");
    expect(cleanExcerpt(null)).toBe("");
    expect(cleanExcerpt("Resolves #1484 Resolves #780 (Files and paths)\n\nThe new system lets each type define its own completions.")).toBe(
      "The new system lets each type define its own completions.",
    );
  });
});

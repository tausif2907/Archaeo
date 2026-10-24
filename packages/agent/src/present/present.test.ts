import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@archaeo/db";
import { createModels, loadModelConfig, MockProvider, type ChatOutput } from "@archaeo/models";
import type { AgentEvent } from "@archaeo/shared";
import { formatCodeRef, parseCodeRef, validateCodeCitations } from "./code-refs";
import { docSummary } from "./flow";
import { limitMessage, runLoop } from "./loop";
import { keywords, safeRepoPath, type AgentTool, type ToolContext } from "./tools";

const LIMITS = { maxToolCalls: 3, maxDurationMs: 5_000, maxCostUsd: 1 };
const ctx = { prisma: {} as PrismaClient, models: { embed: async () => [] }, repoId: "r", repoDir: "/tmp/none" } satisfies ToolContext;

function fakeTool(name: string, delayMs = 0): AgentTool & { calls: number } {
  const tool = {
    calls: 0,
    definition: { name, description: name, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    async run() {
      tool.calls++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { content: `result ${tool.calls}: src/app.py:${tool.calls * 10}-${tool.calls * 10 + 5}`, refs: [{ path: "src/app.py", startLine: tool.calls * 10, endLine: tool.calls * 10 + 5 }], summary: `${name} #${tool.calls}` };
    },
  };
  return tool;
}

const callTool = (id: string): ChatOutput => ({ content: "", toolCalls: [{ id, name: "search", arguments: { query: "x" } }], finishReason: "tool_calls" });

function modelsWith(script: ChatOutput[], pricing: Record<string, { inputPerM: number; outputPerM: number }> = {}) {
  const config = { ...loadModelConfig({}), pricing };
  return createModels({ config, providers: { mock: new MockProvider({ script }) } });
}

describe("code citations", () => {
  const lineCount = (p: string) => ({ "src/app.py": 50, "src/util.py": 10 })[p] ?? null;

  it("parses and formats refs", () => {
    expect(parseCodeRef("src/app.py:10-20")).toEqual({ path: "src/app.py", startLine: 10, endLine: 20 });
    expect(parseCodeRef("./src/app.py:7")).toEqual({ path: "src/app.py", startLine: 7, endLine: 7 });
    expect(parseCodeRef("src/app.py:20-10")).toBeNull();
    expect(formatCodeRef({ path: "a.ts", startLine: 3, endLine: 3 })).toBe("a.ts:3");
  });

  it("keeps real line ranges, clamps overlong ones and drops missing files or lines", () => {
    const checked = validateCodeCitations(
      "Parsing lives in [src/app.py:10-20]. Helpers [src/util.py:5-99, src/gone.py:1]. Bogus [src/app.py:400-410]. Mixed [src/app.py:1-2, #12]. A [link](http://x) stays.",
      lineCount,
    );
    expect(checked.text).toBe("Parsing lives in [src/app.py:10-20]. Helpers [src/util.py:5-10]. Bogus. Mixed [src/app.py:1-2, #12]. A [link](http://x) stays.");
    expect(checked.valid).toEqual([
      { path: "src/app.py", startLine: 10, endLine: 20 },
      { path: "src/util.py", startLine: 5, endLine: 10 },
      { path: "src/app.py", startLine: 1, endLine: 2 },
    ]);
    expect(checked.invalid).toEqual(["src/gone.py:1", "src/app.py:400-410"]);
  });
});

describe("agent loop limits", () => {
  it("answers normally when the model stops calling tools", async () => {
    const tool = fakeTool("search");
    const events: AgentEvent[] = [];
    const res = await runLoop({
      models: modelsWith([callTool("a"), { content: "Done [src/app.py:10-15]", toolCalls: [], finishReason: "stop" }]),
      tools: [tool],
      ctx,
      messages: [{ role: "user", content: "q" }],
      limits: LIMITS,
      onEvent: (e) => events.push(e),
    });
    expect(res).toMatchObject({ status: "succeeded", content: "Done [src/app.py:10-15]", limitReason: null, steps: 2 });
    expect(res.seen).toEqual([{ path: "src/app.py", startLine: 10, endLine: 15 }]);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("stops at the tool-call limit and gets one tool-free final answer", async () => {
    const tool = fakeTool("search");
    const events: AgentEvent[] = [];
    // The model keeps asking for tools forever; the 5th scripted reply is the forced final answer.
    const script = [callTool("1"), callTool("2"), callTool("3"), callTool("4"), { content: "Best effort [src/app.py:10-15]", toolCalls: [], finishReason: "stop" as const }];
    const res = await runLoop({ models: modelsWith(script), tools: [tool], ctx, messages: [{ role: "user", content: "q" }], limits: LIMITS, onEvent: (e) => events.push(e) });
    expect(tool.calls).toBe(3);
    expect(res).toMatchObject({ status: "limited", limitReason: "tool_calls", content: "Best effort [src/app.py:10-15]" });
    expect(events.find((e) => e.type === "limit")).toEqual({ type: "limit", reason: "tool_calls", message: "I stopped early because I reached the tool-call limit (3 calls)." });
  });

  it("stops at the time limit even if a tool hangs", async () => {
    const tool = fakeTool("search", 500);
    const started = Date.now();
    const res = await runLoop({ models: modelsWith([callTool("1"), callTool("2")]), tools: [tool], ctx, messages: [{ role: "user", content: "q" }], limits: { ...LIMITS, maxDurationMs: 100 } });
    expect(res.status).toBe("limited");
    expect(res.limitReason).toBe("time");
    expect(Date.now() - started).toBeLessThan(450);
  });

  it("stops at the cost limit", async () => {
    // Price the mock reason model so each call costs about $1.
    const pricing = { "muse-spark": { inputPerM: 1_000_000, outputPerM: 0 } };
    const res = await runLoop({
      models: modelsWith([callTool("1"), callTool("2"), callTool("3")], pricing),
      tools: [fakeTool("search")],
      ctx,
      messages: [{ role: "user", content: "q" }],
      limits: { ...LIMITS, maxCostUsd: 0.5 },
    });
    expect(res.status).toBe("limited");
    expect(res.limitReason).toBe("cost");
    expect(res.steps).toBe(1);
    expect(limitMessage("cost", { ...LIMITS, maxCostUsd: 0.5 })).toBe("I stopped early because I reached the cost limit ($0.50).");
  });

  it("reports unknown tools and tool errors back to the model instead of crashing", async () => {
    const broken: AgentTool = { definition: fakeTool("search").definition, run: async () => Promise.reject(new Error("boom")) };
    const res = await runLoop({
      models: modelsWith([
        { content: "", toolCalls: [{ id: "x", name: "nope", arguments: {} }], finishReason: "tool_calls" },
        callTool("y"),
        { content: "ok", toolCalls: [], finishReason: "stop" },
      ]),
      tools: [broken],
      ctx,
      messages: [{ role: "user", content: "q" }],
      limits: LIMITS,
    });
    expect(res.status).toBe("succeeded");
    expect(res.toolCalls.map((t) => t.summary)).toEqual(["Unknown tool nope", "search failed: boom"]);
  });
});

describe("tool helpers", () => {
  it("extracts search keywords without stopwords", () => {
    expect(keywords("Where is the zsh shell completion implemented?")).toEqual(["zsh", "shell", "completion"]);
    expect(keywords("How does Context.invoke handle callbacks")).toEqual(["context", "invoke", "callbacks"]);
  });

  it("keeps paths inside the clone and away from .git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archaeo-tools-"));
    expect(safeRepoPath(dir, "src/a.py")).toBe(join(dir, "src", "a.py"));
    expect(safeRepoPath(dir, "../etc/passwd")).toBeNull();
    expect(safeRepoPath(dir, ".git/config")).toBeNull();
    expect(safeRepoPath(dir, "/src/../../x")).toBeNull();
  });

  it("reads Python docstrings and JSDoc for flow explanations", () => {
    const py = ["def invoke(self, ctx):", '    """Given a context, this invokes the command. More text."""', "    return 1"];
    expect(docSummary(py, 1, 3)).toBe("Given a context, this invokes the command");
    const ts = ["/**", " * Creates the HTTP server.", " * @param port listen port", " */", "export function createServer() {", "}"];
    expect(docSummary(ts, 5, 6)).toBe("Creates the HTTP server");
    expect(docSummary(["def f():", "    return 1"], 1, 2)).toBeNull();
  });
});

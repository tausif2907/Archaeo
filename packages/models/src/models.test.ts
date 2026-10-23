import { describe, expect, it } from "vitest";
import { createModels, loadModelConfig, MockProvider, type ModelCallRecord, type ModelTask } from "./index";

function setup(script?: ConstructorParameters<typeof MockProvider>[0]) {
  const calls: ModelCallRecord[] = [];
  const config = loadModelConfig({ MODEL_PROVIDER: "mock", EMBED_DIM: "64" });
  const models = createModels({ config, recorder: { record: (c) => void calls.push(c) }, providers: { mock: new MockProvider(script) } });
  return { models, calls, config };
}

function expectRecorded(calls: ModelCallRecord[], task: ModelTask, model: string) {
  const call = calls.find((c) => c.task === task);
  expect(call).toBeDefined();
  expect(call?.model).toBe(model);
  expect(call?.tokensIn).toBeGreaterThan(0);
  expect(call?.latencyMs).toBeGreaterThanOrEqual(0);
  expect(call?.cost).toBeGreaterThanOrEqual(0);
}

describe("models contract (mock provider)", () => {
  it("defaults to mock mode with placeholder model IDs", () => {
    const config = loadModelConfig({});
    expect(config.mode).toBe("mock");
    expect(Object.values(config.tasks).every((t) => t.provider === "mock")).toBe(true);
    expect(loadModelConfig({ MODEL_PROVIDER: "live", MODEL_REASON: "x-spark" }).tasks.reason).toEqual({ provider: "meta", model: "x-spark" });
  });

  it("summarizeCheap returns text and records the call", async () => {
    const { models, calls, config } = setup();
    const out = await models.summarizeCheap({ text: "Adds a retry loop to the HTTP client so flaky requests recover.", maxWords: 5 });
    expect(out).toContain("[mock summary]");
    expect(out.length).toBeLessThan(80);
    expect(await models.summarizeCheap("plain string input")).toContain("plain string input");
    expectRecorded(calls, "summarizeCheap", config.tasks.summarizeCheap.model);
  });

  it("reason returns an AgentStep and supports scripted tool calls", async () => {
    const { models, calls, config } = setup({
      script: [{ content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.ts" } }], finishReason: "tool_calls" }],
    });
    const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
    const first = await models.reason([{ role: "user", content: "Where is auth?" }], tools, { runId: "run1" });
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls[0]?.name).toBe("read_file");
    const second = await models.reason([{ role: "user", content: "Where is auth?" }], tools);
    expect(second.finishReason).toBe("stop");
    expect(second.content).toContain("Where is auth?");
    expect(second.model).toBe(config.tasks.reason.model);
    expectRecorded(calls, "reason", config.tasks.reason.model);
    expect(calls[0]?.runId).toBe("run1");
  });

  it("writeCode returns a unified diff", async () => {
    const { models, calls, config } = setup();
    const step = await models.writeCode([{ role: "user", content: "Fix the bug" }]);
    expect(step.content).toMatch(/^--- a\//m);
    expect(step.content).toMatch(/^\+\+\+ b\//m);
    expectRecorded(calls, "writeCode", config.tasks.writeCode.model);
  });

  it("generateImage returns image data", async () => {
    const { models, calls, config } = setup();
    const img = await models.generateImage("architecture overview");
    expect(img.mimeType).toBe("image/png");
    expect(img.b64 ?? img.url).toBeTruthy();
    expectRecorded(calls, "generateImage", config.tasks.generateImage.model);
  });

  it("embed returns normalised, deterministic vectors of the configured size", async () => {
    const { models, calls, config } = setup();
    const [a, b, c] = await models.embed(["parse git history", "parse git history", "render the timeline ui"]);
    expect(a).toHaveLength(64);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(c).not.toEqual(a);
    expect(await models.embed([])).toEqual([]);
    expectRecorded(calls, "embed", config.tasks.embed.model);
  });
});

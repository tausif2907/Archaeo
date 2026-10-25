import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const completion = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider", () => {
  const config = { baseUrl: "https://api.example.test/v1", apiKey: "k" };

  it("times out slow requests with a clear message", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    const p = new OpenAICompatibleProvider("meta", config, { timeoutMs: 50, retries: 0 });
    await expect(p.chat("m", [{ role: "user", content: "x" }], undefined, {})).rejects.toThrow('Model provider "meta" timed out after 0 s (/chat/completions)');
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const calls: number[] = [];
    vi.stubGlobal("fetch", async () => {
      calls.push(Date.now());
      return calls.length < 3 ? new Response("busy", { status: calls.length === 1 ? 429 : 503 }) : ok(completion);
    });
    const p = new OpenAICompatibleProvider("meta", config, { retries: 2, retryDelayMs: 1 });
    const res = await p.chat("m", [{ role: "user", content: "x" }], undefined, {});
    expect(res.output.content).toBe("hi");
    expect(calls).toHaveLength(3);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response("bad key", { status: 401 });
    });
    const p = new OpenAICompatibleProvider("meta", config, { retries: 2, retryDelayMs: 1 });
    await expect(p.chat("m", [{ role: "user", content: "x" }], undefined, {})).rejects.toThrow('Model provider "meta" /chat/completions failed: 401 bad key');
    expect(n).toBe(1);
  });

  it("explains missing configuration", async () => {
    const p = new OpenAICompatibleProvider("meta", { baseUrl: "", apiKey: "" });
    await expect(p.embed("e", ["x"], 8, {})).rejects.toThrow("not configured");
  });
});

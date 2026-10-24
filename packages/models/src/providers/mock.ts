import type {
  CallOptions,
  ChatMessage,
  ChatOutput,
  ImageResult,
  ModelProvider,
  ProviderResult,
  SummarizeInput,
  ToolDefinition,
} from "../types";

/** Rough token estimate (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function messagesText(messages: ChatMessage[]): string {
  return messages.map((m) => m.content).join("\n");
}

function hash(str: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedding (hashing trick), L2-normalised.
 * Texts sharing words get similar vectors, so retrieval behaves sensibly offline.
 */
export function mockEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const token of tokens) {
    const h = hash(token);
    const idx = h % dim;
    vec[idx] = (vec[idx] ?? 0) + ((h & 1) === 0 ? 1 : -1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) {
    vec[hash(text) % dim] = 1;
    return vec;
  }
  return vec.map((v) => v / norm);
}

// 1x1 transparent PNG
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const MOCK_PATCH = [
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " # Project",
  "+Patched by the Archaeo mock provider.",
  "",
].join("\n");

const CODE_REF = /([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

/**
 * A deliberately simple "agent" so tool-calling flows run offline: first call whichever tool takes a
 * `query`, then answer by citing the `path:line` ranges that tool returned. Knows nothing about features.
 */
function mockAgentStep(messages: ChatMessage[], tools: ToolDefinition[], question: string): ChatOutput {
  const toolResults = messages.filter((m) => m.role === "tool");
  if (toolResults.length === 0) {
    const searchTool = tools.find((t) => {
      const required = (t.parameters as { required?: unknown }).required;
      return Array.isArray(required) && required.includes("query");
    });
    if (searchTool) {
      return { content: "", toolCalls: [{ id: "mock-call-1", name: searchTool.name, arguments: { query: question } }], finishReason: "tool_calls" };
    }
  }
  const evidence = toolResults.map((m) => m.content).join("\n");
  const refs = [...new Set([...evidence.matchAll(CODE_REF)].map((m) => `${m[1]}:${m[2]}${m[3] ? `-${m[3]}` : ""}`))].slice(0, 5);
  const content = refs.length
    ? `[mock answer] The most relevant code for "${question.slice(0, 120)}":\n${refs.map((r) => `- [${r}]`).join("\n")}`
    : `[mock answer] ${question.slice(0, 200)}`;
  return { content, toolCalls: [], finishReason: "stop" };
}

/**
 * Offline provider returning canned outputs so the whole app runs before API keys exist.
 * Tests can queue exact chat replies with `script`, e.g. to drive the agent loop through tool calls.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  private readonly script: ChatOutput[];

  constructor(options: { script?: ChatOutput[] } = {}) {
    this.script = [...(options.script ?? [])];
  }

  /** Queue chat replies; each chat call consumes one before falling back to the canned reply. */
  enqueue(...steps: ChatOutput[]): void {
    this.script.push(...steps);
  }

  async summarize(_model: string, input: SummarizeInput, _opts: CallOptions): Promise<ProviderResult<string>> {
    const words = input.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const max = input.maxWords ?? 30;
    const excerpt = words.slice(0, max).join(" ");
    const output = `[mock summary] ${excerpt}${words.length > max ? "…" : ""}`;
    return { output, usage: { tokensIn: estimateTokens(`${input.instruction ?? ""}${input.text}`), tokensOut: estimateTokens(output) } };
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    _opts: CallOptions,
  ): Promise<ProviderResult<ChatOutput>> {
    const tokensIn = estimateTokens(messagesText(messages));
    const scripted = this.script.shift();
    if (scripted) {
      return { output: scripted, usage: { tokensIn, tokensOut: estimateTokens(scripted.content || JSON.stringify(scripted.toolCalls)) } };
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (tools?.length) {
      const output = mockAgentStep(messages, tools, lastUser?.content ?? "");
      return { output, usage: { tokensIn, tokensOut: estimateTokens(output.content || JSON.stringify(output.toolCalls)) } };
    }
    const content = model.includes("code")
      ? `[mock patch]\n\`\`\`diff\n${MOCK_PATCH}\`\`\``
      : `[mock answer] ${(lastUser?.content ?? "").slice(0, 200)}`;
    return { output: { content, toolCalls: [], finishReason: "stop" }, usage: { tokensIn, tokensOut: estimateTokens(content) } };
  }

  async image(_model: string, prompt: string, _opts: CallOptions): Promise<ProviderResult<Omit<ImageResult, "model">>> {
    return { output: { mimeType: "image/png", b64: PIXEL_PNG }, usage: { tokensIn: estimateTokens(prompt), tokensOut: 0 } };
  }

  async embed(_model: string, texts: string[], dim: number, _opts: CallOptions): Promise<ProviderResult<number[][]>> {
    return {
      output: texts.map((t) => mockEmbedding(t, dim)),
      usage: { tokensIn: texts.reduce((s, t) => s + estimateTokens(t), 0), tokensOut: 0 },
    };
  }
}

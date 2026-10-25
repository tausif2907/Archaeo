import type {
  CallOptions,
  ChatMessage,
  ChatOutput,
  ImageResult,
  ModelProvider,
  ProviderResult,
  SummarizeInput,
  ToolCall,
  ToolDefinition,
} from "../types";
import type { HttpProviderConfig } from "../config";

/**
 * Provider for OpenAI-compatible HTTP APIs (Fireworks, Baseten, and likely the Meta Model API).
 * Wire format is unverified for Meta until kickoff; adjust here only, never in feature code.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    readonly name: string,
    private readonly config: HttpProviderConfig,
    private readonly http: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
  ) {}

  /** POST with a per-request timeout; 429 and 5xx responses are retried with exponential backoff. */
  private async post<T>(path: string, body: unknown, opts: CallOptions): Promise<T> {
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new Error(`Model provider "${this.name}" is not configured (missing base URL or API key)`);
    }
    const timeoutMs = this.http.timeoutMs ?? 60_000;
    const retries = this.http.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
      } catch (err) {
        if (timeout.aborted && !opts.signal?.aborted) throw new Error(`Model provider "${this.name}" timed out after ${Math.round(timeoutMs / 1000)} s (${path})`);
        throw err;
      }
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        throw new Error(`Model provider "${this.name}" ${path} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
      }
      await new Promise((r) => setTimeout(r, (this.http.retryDelayMs ?? 1000) * 2 ** attempt));
    }
  }

  async chat(model: string, messages: ChatMessage[], tools: ToolDefinition[] | undefined, opts: CallOptions): Promise<ProviderResult<ChatOutput>> {
    const data = await this.post<ChatCompletionResponse>(
      "/chat/completions",
      {
        model,
        messages: messages.map(toWireMessage),
        ...(tools?.length
          ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      },
      opts,
    );
    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJson(tc.function.arguments),
    }));
    const finish = choice?.finish_reason;
    return {
      output: {
        content: choice?.message.content ?? "",
        toolCalls,
        finishReason: toolCalls.length ? "tool_calls" : finish === "length" ? "length" : "stop",
      },
      usage: { tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 },
    };
  }

  async summarize(model: string, input: SummarizeInput, opts: CallOptions): Promise<ProviderResult<string>> {
    const instruction = input.instruction ?? `Summarize the following in at most ${input.maxWords ?? 60} words.`;
    const res = await this.chat(
      model,
      [
        { role: "system", content: instruction },
        { role: "user", content: input.text },
      ],
      undefined,
      opts,
    );
    return { output: res.output.content.trim(), usage: res.usage };
  }

  async image(model: string, prompt: string, opts: CallOptions): Promise<ProviderResult<Omit<ImageResult, "model">>> {
    const data = await this.post<{ data: { url?: string; b64_json?: string }[] }>(
      "/images/generations",
      { model, prompt, response_format: "b64_json" },
      opts,
    );
    const img = data.data[0];
    return { output: { mimeType: "image/png", url: img?.url, b64: img?.b64_json }, usage: { tokensIn: 0, tokensOut: 0 } };
  }

  async embed(model: string, texts: string[], dim: number, opts: CallOptions): Promise<ProviderResult<number[][]>> {
    const data = await this.post<{ data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } }>(
      "/embeddings",
      { model, input: texts, dimensions: dim },
      opts,
    );
    const output = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { output, usage: { tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: 0 } };
  }
}

interface ChatCompletionResponse {
  choices: {
    finish_reason?: string;
    message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

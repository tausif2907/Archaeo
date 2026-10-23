/** Task-level names. Feature code asks for a task, never a vendor or model ID. */
export type ModelTask = "summarizeCheap" | "reason" | "writeCode" | "generateImage" | "embed";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export interface AgentStep {
  content: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length";
  model: string;
  usage: Usage;
}

export interface ImageResult {
  model: string;
  mimeType: string;
  /** Either a hosted URL or base64 data, depending on the provider */
  url?: string;
  b64?: string;
}

export interface SummarizeInput {
  text: string;
  /** Extra guidance, e.g. "Summarize this commit in one sentence." */
  instruction?: string;
  maxWords?: number;
}

export interface CallOptions {
  /** AgentRun this call belongs to, for cost tracking */
  runId?: string;
  signal?: AbortSignal;
}

export interface ModelCallRecord {
  runId?: string;
  task: ModelTask;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  cost: number;
}

export interface CallRecorder {
  record(call: ModelCallRecord): Promise<void> | void;
}

/** Result a provider returns for one call; the router adds latency and cost. */
export interface ProviderResult<T> {
  output: T;
  usage: Usage;
}

export type ChatOutput = Pick<AgentStep, "content" | "toolCalls" | "finishReason">;

/** A backend that can serve one or more tasks. Implementations: mock, OpenAI-compatible HTTP. */
export interface ModelProvider {
  readonly name: string;
  summarize(model: string, input: SummarizeInput, opts: CallOptions): Promise<ProviderResult<string>>;
  chat(model: string, messages: ChatMessage[], tools: ToolDefinition[] | undefined, opts: CallOptions): Promise<ProviderResult<ChatOutput>>;
  image(model: string, prompt: string, opts: CallOptions): Promise<ProviderResult<Omit<ImageResult, "model">>>;
  embed(model: string, texts: string[], dim: number, opts: CallOptions): Promise<ProviderResult<number[][]>>;
}

/** The public contract (ARCHAEO_PLAN.md §3). */
export interface Models {
  summarizeCheap(input: SummarizeInput | string, opts?: CallOptions): Promise<string>;
  reason(messages: ChatMessage[], tools?: ToolDefinition[], opts?: CallOptions): Promise<AgentStep>;
  writeCode(messages: ChatMessage[], tools?: ToolDefinition[], opts?: CallOptions): Promise<AgentStep>;
  generateImage(prompt: string, opts?: CallOptions): Promise<ImageResult>;
  embed(texts: string[], opts?: CallOptions): Promise<number[][]>;
}

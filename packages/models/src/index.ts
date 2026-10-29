import { estimateCost, loadModelConfig, type ModelConfig, type ProviderName } from "./config";
import { MockProvider } from "./providers/mock";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type {
  AgentStep,
  CallOptions,
  CallRecorder,
  ChatMessage,
  ImageResult,
  ModelProvider,
  ModelTask,
  Models,
  ProviderResult,
  SummarizeInput,
  ToolDefinition,
} from "./types";

export * from "./types";
export { loadModelConfig, estimateCost, routeId, providersInUse, type ModelConfig, type Pricing, type ProviderName, type TaskRoute } from "./config";
export { MockProvider, MOCK_PATCH, mockEmbedding, estimateTokens } from "./providers/mock";
export { OpenAICompatibleProvider } from "./providers/openai-compatible";

export interface CreateModelsOptions {
  config?: ModelConfig;
  recorder?: CallRecorder;
  /** Override providers, e.g. a scripted MockProvider in tests */
  providers?: Partial<Record<ProviderName, ModelProvider>>;
}

function defaultProviders(config: ModelConfig): Record<ProviderName, ModelProvider> {
  return {
    mock: new MockProvider(),
    meta: new OpenAICompatibleProvider("meta", config.providers.meta, { timeoutMs: config.timeoutMs }),
    baseten: new OpenAICompatibleProvider("baseten", config.providers.baseten, { timeoutMs: config.timeoutMs }),
    fireworks: new OpenAICompatibleProvider("fireworks", config.providers.fireworks, { timeoutMs: config.timeoutMs }),
  };
}

/** Builds the task-based model client. Every call is timed, costed and passed to the recorder. */
export function createModels(options: CreateModelsOptions = {}): Models {
  const config = options.config ?? loadModelConfig();
  const providers = { ...defaultProviders(config), ...options.providers };
  const recorder = options.recorder;

  async function run<T>(
    task: ModelTask,
    opts: CallOptions,
    fn: (p: ModelProvider, model: string) => Promise<ProviderResult<T>>,
  ): Promise<{ output: T; model: string; tokensIn: number; tokensOut: number; cost: number }> {
    const route = config.tasks[task];
    const provider = providers[route.provider];
    const started = performance.now();
    const res = await fn(provider, route.model);
    const latencyMs = Math.round(performance.now() - started);
    const { tokensIn, tokensOut } = res.usage;
    const cost = estimateCost(config.pricing, route.model, tokensIn, tokensOut);
    await recorder?.record({ runId: opts.runId, task, model: route.model, tokensIn, tokensOut, latencyMs, cost });
    return { output: res.output, model: route.model, tokensIn, tokensOut, cost };
  }

  async function chatTask(task: "reason" | "writeCode", messages: ChatMessage[], tools: ToolDefinition[] | undefined, opts: CallOptions): Promise<AgentStep> {
    const r = await run(task, opts, (p, model) => p.chat(model, messages, tools, opts));
    return { ...r.output, model: r.model, usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut }, costUsd: r.cost };
  }

  return {
    async summarizeCheap(input, opts = {}) {
      const normalized: SummarizeInput = typeof input === "string" ? { text: input } : input;
      return (await run("summarizeCheap", opts, (p, model) => p.summarize(model, normalized, opts))).output;
    },
    reason: (messages, tools, opts = {}) => chatTask("reason", messages, tools, opts),
    writeCode: (messages, tools, opts = {}) => chatTask("writeCode", messages, tools, opts),
    async generateImage(prompt, opts = {}): Promise<ImageResult> {
      const r = await run("generateImage", opts, (p, model) => p.image(model, prompt, opts));
      return { ...r.output, model: r.model };
    },
    async embed(texts, opts = {}) {
      if (texts.length === 0) return [];
      return (await run("embed", opts, (p, model) => p.embed(model, texts, config.embedDim, opts))).output;
    },
  };
}

let defaultModels: Models | undefined;

/** Sets up the process-wide client (call once at startup, e.g. with a PrismaCallRecorder). */
export function configureModels(options: CreateModelsOptions = {}): Models {
  defaultModels = createModels(options);
  return defaultModels;
}

function models(): Models {
  return (defaultModels ??= createModels());
}

export const summarizeCheap: Models["summarizeCheap"] = (...args) => models().summarizeCheap(...args);
export const reason: Models["reason"] = (...args) => models().reason(...args);
export const writeCode: Models["writeCode"] = (...args) => models().writeCode(...args);
export const generateImage: Models["generateImage"] = (...args) => models().generateImage(...args);
export const embed: Models["embed"] = (...args) => models().embed(...args);

import type { ModelTask } from "./types";

/**
 * All model IDs, endpoints and prices live here; env vars (see .env.example) override them without
 * touching feature code. Defaults follow Meta's Model API docs (https://dev.meta.ai/docs): Muse Spark on
 * the Meta Model API, Muse Spark Open on Baseten, and an embedding model on Fireworks, since the Meta
 * Model API has no embeddings endpoint.
 */
export type ProviderName = "mock" | "meta" | "baseten" | "fireworks";
type HostName = Exclude<ProviderName, "mock" | "meta">;

export interface TaskRoute {
  provider: ProviderName;
  model: string;
}

export interface HttpProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface Pricing {
  /** USD per 1M input tokens */
  inputPerM: number;
  /** USD per 1M output tokens */
  outputPerM: number;
}

export interface ModelConfig {
  mode: "mock" | "live";
  embedDim: number;
  /** Per-request timeout for live model calls */
  timeoutMs: number;
  tasks: Record<ModelTask, TaskRoute>;
  providers: Record<Exclude<ProviderName, "mock">, HttpProviderConfig>;
  pricing: Record<string, Pricing>;
}

/**
 * Muse Code is Meta's coding agent built on Muse Spark, not a Model API ID, so patches come from Muse
 * Spark too (`muse-wonder-1.0` is Meta's pick for long coding work, if the event allows it).
 */
const DEFAULT_MODELS: Record<ModelTask, string> = {
  summarizeCheap: "meta-models/muse-spark-open",
  reason: "muse-spark-1.3",
  writeCode: "muse-spark-1.3",
  generateImage: "muse-image-1.0",
  embed: "accounts/fireworks/models/qwen3-embedding-0p6b",
};

/**
 * Mock mode uses names of its own, so mock calls are never priced as a real model, editing model IDs in .env
 * while offline does not mark stored data stale, and the mock can tell code writing (a "code" model) apart.
 */
const MOCK_MODELS: Record<ModelTask, string> = {
  summarizeCheap: "mock-summarize",
  reason: "mock-reason",
  writeCode: "mock-code",
  generateImage: "mock-image",
  embed: "mock-embed",
};

/** USD per 1M tokens from Meta's pricing page (Standard mode). MODEL_PRICING adds or overrides. */
const META_PRICING: Record<string, Pricing> = {
  "muse-spark-1.3": { inputPerM: 1.25, outputPerM: 4.25 },
  "muse-spark-1.2": { inputPerM: 1.25, outputPerM: 4.25 },
  "muse-spark-1.1": { inputPerM: 1.25, outputPerM: 4.25 },
  "muse-spark-1.3-contributor": { inputPerM: 0.1, outputPerM: 0.2 },
  "muse-spark-1.2-contributor": { inputPerM: 0.1, outputPerM: 0.2 },
  "muse-wonder-1.0": { inputPerM: 4, outputPerM: 20 },
};

const HOST = (v: string | undefined, fallback: HostName): HostName => (v === "baseten" || v === "fireworks" ? v : fallback);

const TASK_ENV: Record<ModelTask, string> = {
  summarizeCheap: "MODEL_SUMMARIZE",
  reason: "MODEL_REASON",
  writeCode: "MODEL_WRITE_CODE",
  generateImage: "MODEL_IMAGE",
  embed: "MODEL_EMBED",
};

/**
 * "provider/model" for a task, e.g. "fireworks/<embedding model>". Stored next to what a model produced
 * (embeddings, summaries, narratives) so a later model change is noticed and that data is redone.
 */
export function routeId(config: Pick<ModelConfig, "tasks">, task: ModelTask): string {
  const route = config.tasks[task];
  return `${route.provider}/${route.model}`;
}

/** Builds the config from environment variables. Mock mode is the default. */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const mode = env.MODEL_PROVIDER === "live" ? "live" : "mock";
  // Summaries go to the open-weights host (Muse Spark Open on Baseten); embeddings may use another one.
  const summarizeHost = HOST(env.OPENWEIGHTS_PROVIDER, "baseten");
  const taskProvider: Record<ModelTask, Exclude<ProviderName, "mock">> = {
    summarizeCheap: summarizeHost,
    reason: "meta",
    writeCode: "meta",
    generateImage: "meta",
    embed: HOST(env.EMBED_PROVIDER, "fireworks"),
  };

  const tasks = Object.fromEntries(
    (Object.keys(DEFAULT_MODELS) as ModelTask[]).map((task) => [
      task,
      (mode === "mock"
        ? { provider: "mock", model: MOCK_MODELS[task] }
        : { provider: taskProvider[task], model: env[TASK_ENV[task]] || DEFAULT_MODELS[task] }) satisfies TaskRoute,
    ]),
  ) as Record<ModelTask, TaskRoute>;

  return {
    mode,
    embedDim: Number(env.EMBED_DIM) || 1024,
    // Muse Spark always reasons before it answers, so allow more than a plain completion needs.
    timeoutMs: (Number(env.MODEL_TIMEOUT_SECONDS) || 120) * 1000,
    tasks,
    providers: {
      // Meta's docs call the key MODEL_API_KEY; META_API_KEY is Archaeo's name for it.
      meta: { baseUrl: env.META_API_BASE_URL || "https://api.meta.ai/v1", apiKey: env.META_API_KEY || env.MODEL_API_KEY || "" },
      baseten: { baseUrl: env.BASETEN_BASE_URL || "https://inference.baseten.co/v1", apiKey: env.BASETEN_API_KEY ?? "" },
      fireworks: { baseUrl: env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1", apiKey: env.FIREWORKS_API_KEY ?? "" },
    },
    // Unknown models cost 0, so tracking never blocks a call, but run cost limits then never trigger.
    pricing: { ...META_PRICING, ...parsePricing(env.MODEL_PRICING) },
  };
}

/** The providers live routes actually call, with the tasks each one serves. */
export function providersInUse(config: Pick<ModelConfig, "tasks">): Map<Exclude<ProviderName, "mock">, ModelTask[]> {
  const used = new Map<Exclude<ProviderName, "mock">, ModelTask[]>();
  for (const [task, route] of Object.entries(config.tasks) as [ModelTask, TaskRoute][]) {
    if (route.provider === "mock") continue;
    used.set(route.provider, [...(used.get(route.provider) ?? []), task]);
  }
  return used;
}

/** `MODEL_PRICING`: JSON of USD per 1M tokens by model ID, e.g. {"meta-models/muse-spark-open":{"inputPerM":1.25,"outputPerM":4.25}}. */
export function parsePricing(raw: string | undefined): Record<string, Pricing> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_PRICING must be JSON, e.g. {"muse-spark":{"inputPerM":1,"outputPerM":4}}');
  }
  const out: Record<string, Pricing> = {};
  for (const [model, p] of Object.entries((parsed ?? {}) as Record<string, Partial<Pricing>>)) {
    if (typeof p?.inputPerM !== "number" || typeof p.outputPerM !== "number") throw new Error(`MODEL_PRICING for ${model} needs numeric inputPerM and outputPerM`);
    out[model] = { inputPerM: p.inputPerM, outputPerM: p.outputPerM };
  }
  return out;
}

export function estimateCost(pricing: Record<string, Pricing>, model: string, tokensIn: number, tokensOut: number): number {
  const p = pricing[model];
  if (!p) return 0;
  return (tokensIn * p.inputPerM + tokensOut * p.outputPerM) / 1_000_000;
}

import type { ModelTask } from "./types";

/**
 * All model IDs, endpoints and prices live here. Exact Meta Model API details are TBD at kickoff:
 * set them through env vars (see .env.example) instead of editing feature code.
 */
export type ProviderName = "mock" | "meta" | "openweights";

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
  tasks: Record<ModelTask, TaskRoute>;
  providers: {
    meta: HttpProviderConfig;
    openweights: HttpProviderConfig & { host: "baseten" | "fireworks" };
  };
  pricing: Record<string, Pricing>;
}

/** Placeholder IDs until kickoff confirms the real ones. */
const DEFAULT_MODELS: Record<ModelTask, string> = {
  summarizeCheap: "openweights-summarizer-tbd",
  reason: "muse-spark",
  writeCode: "muse-code",
  generateImage: "muse-image",
  embed: "openweights-embedding-tbd",
};

const TASK_PROVIDER: Record<ModelTask, Exclude<ProviderName, "mock">> = {
  summarizeCheap: "openweights",
  reason: "meta",
  writeCode: "meta",
  generateImage: "meta",
  embed: "openweights",
};

const TASK_ENV: Record<ModelTask, string> = {
  summarizeCheap: "MODEL_SUMMARIZE",
  reason: "MODEL_REASON",
  writeCode: "MODEL_WRITE_CODE",
  generateImage: "MODEL_IMAGE",
  embed: "MODEL_EMBED",
};

/** Builds the config from environment variables. Mock mode is the default. */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const mode = env.MODEL_PROVIDER === "live" ? "live" : "mock";
  const host = env.OPENWEIGHTS_PROVIDER === "baseten" ? "baseten" : "fireworks";

  const tasks = Object.fromEntries(
    (Object.keys(DEFAULT_MODELS) as ModelTask[]).map((task) => [
      task,
      {
        provider: mode === "mock" ? "mock" : TASK_PROVIDER[task],
        model: env[TASK_ENV[task]] || DEFAULT_MODELS[task],
      } satisfies TaskRoute,
    ]),
  ) as Record<ModelTask, TaskRoute>;

  return {
    mode,
    embedDim: Number(env.EMBED_DIM) || 1024,
    tasks,
    providers: {
      meta: { baseUrl: env.META_API_BASE_URL ?? "", apiKey: env.META_API_KEY ?? "" },
      openweights:
        host === "baseten"
          ? { host, baseUrl: env.BASETEN_BASE_URL ?? "", apiKey: env.BASETEN_API_KEY ?? "" }
          : {
              host,
              baseUrl: env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1",
              apiKey: env.FIREWORKS_API_KEY ?? "",
            },
    },
    // Fill in real prices at kickoff. Unknown models cost 0 so tracking never blocks a call.
    pricing: {},
  };
}

export function estimateCost(pricing: Record<string, Pricing>, model: string, tokensIn: number, tokensOut: number): number {
  const p = pricing[model];
  if (!p) return 0;
  return (tokensIn * p.inputPerM + tokensOut * p.outputPerM) / 1_000_000;
}

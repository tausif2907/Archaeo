export interface AgentLimits {
  maxToolCalls: number;
  maxDurationMs: number;
  maxCostUsd: number;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Per-run limits (ARCHAEO_PLAN §8): 10 tool calls, 90 s, and a cost cap, all configurable. */
export function loadAgentLimits(env: NodeJS.ProcessEnv = process.env): AgentLimits {
  return {
    maxToolCalls: num(env, "AGENT_MAX_TOOL_CALLS", 10),
    maxDurationMs: num(env, "AGENT_MAX_SECONDS", 90) * 1000,
    maxCostUsd: num(env, "AGENT_MAX_COST_USD", 0.5),
  };
}

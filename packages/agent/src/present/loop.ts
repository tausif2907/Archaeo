import type { ChatMessage, Models } from "@archaeo/models";
import type { AgentEvent, AgentLimitReason, CodeRef } from "@archaeo/shared";
import type { AgentLimits } from "./limits";
import type { AgentTool, ToolContext } from "./tools";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  summary: string;
  ms: number;
}

export interface LoopResult {
  status: "succeeded" | "limited" | "failed";
  /** Final model text (before citation checks) */
  content: string;
  limitReason: AgentLimitReason | null;
  /** Every code range a tool showed the model */
  seen: CodeRef[];
  toolCalls: ToolCallRecord[];
  costUsd: number;
  steps: number;
  error?: string;
}

export interface LoopOptions {
  models: Pick<Models, "reason">;
  tools: AgentTool[];
  ctx: ToolContext;
  messages: ChatMessage[];
  limits: AgentLimits;
  onEvent?: (e: AgentEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  /** Injected clock for tests */
  now?: () => number;
}

class LimitHit extends Error {
  constructor(readonly reason: AgentLimitReason) {
    super(reason);
  }
}

const LIMIT_TEXT: Record<AgentLimitReason, (l: AgentLimits) => string> = {
  tool_calls: (l) => `the tool-call limit (${l.maxToolCalls} calls)`,
  time: (l) => `the time limit (${Math.round(l.maxDurationMs / 1000)} s)`,
  cost: (l) => `the cost limit ($${l.maxCostUsd.toFixed(2)})`,
};

export function limitMessage(reason: AgentLimitReason, limits: AgentLimits): string {
  return `I stopped early because I reached ${LIMIT_TEXT[reason](limits)}.`;
}

/** Races a promise against the remaining time budget. */
function withDeadline<T>(p: Promise<T>, msLeft: number): Promise<T> {
  if (msLeft <= 0) return Promise.reject(new LimitHit("time"));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LimitHit("time")), msLeft)))]).finally(() => clearTimeout(timer));
}

/**
 * Tool-calling agent loop. Stops on a final answer, or on any limit: tool calls, wall time, or cost.
 * When the tool budget runs out with time and money left, the model gets one last tool-free turn to answer.
 */
export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const { models, tools, ctx, limits } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  const emit = opts.onEvent ?? (() => {});
  const messages = [...opts.messages];
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const definitions = tools.map((t) => t.definition);
  const seen: CodeRef[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let costUsd = 0;
  let steps = 0;

  const msLeft = () => limits.maxDurationMs - (now() - started);
  const checkBudget = () => {
    if (msLeft() <= 0) throw new LimitHit("time");
    if (costUsd >= limits.maxCostUsd) throw new LimitHit("cost");
  };
  const callModel = async (withTools: boolean) => {
    checkBudget();
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(Math.max(1, msLeft()))]) : AbortSignal.timeout(Math.max(1, msLeft()));
    const step = await withDeadline(models.reason(messages, withTools ? definitions : undefined, { runId: opts.runId, signal }), msLeft());
    steps++;
    costUsd += step.costUsd;
    return step;
  };

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("Cancelled");
      const step = await callModel(true);
      if (step.toolCalls.length === 0) {
        return { status: "succeeded", content: step.content, limitReason: null, seen, toolCalls, costUsd, steps };
      }
      if (step.content.trim()) emit({ type: "thinking", text: step.content.trim() });
      messages.push({ role: "assistant", content: step.content, toolCalls: step.toolCalls });

      for (const call of step.toolCalls) {
        if (toolCalls.length >= limits.maxToolCalls) throw new LimitHit("tool_calls");
        checkBudget();
        emit({ type: "tool_call", id: call.id, name: call.name, args: call.arguments });
        const tool = byName.get(call.name);
        const t0 = now();
        let result;
        try {
          result = tool ? await withDeadline(tool.run(call.arguments, ctx), msLeft()) : { content: `Error: unknown tool ${call.name}`, refs: [], summary: `Unknown tool ${call.name}` };
        } catch (err) {
          if (err instanceof LimitHit) throw err;
          const message = err instanceof Error ? err.message : String(err);
          result = { content: `Error: ${message}`, refs: [], summary: `${call.name} failed: ${message}` };
        }
        toolCalls.push({ name: call.name, args: call.arguments, summary: result.summary, ms: now() - t0 });
        seen.push(...result.refs);
        emit({ type: "tool_result", id: call.id, name: call.name, summary: result.summary, refs: result.refs });
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
      }
    }
  } catch (err) {
    if (!(err instanceof LimitHit)) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", content: "", limitReason: null, seen, toolCalls, costUsd, steps, error: message };
    }
    const reason = err.reason;
    emit({ type: "limit", reason, message: limitMessage(reason, limits) });
    // Out of tool calls but not time/money: one tool-free turn to answer with what was gathered.
    let content = "";
    if (reason === "tool_calls") {
      try {
        messages.push({ role: "user", content: "Tool budget exhausted. Answer now using only the evidence above, citing only lines you have seen." });
        content = (await callModel(false)).content;
      } catch {
        content = "";
      }
    }
    return { status: "limited", content, limitReason: reason, seen, toolCalls, costUsd, steps };
  }
}

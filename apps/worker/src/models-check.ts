import "@archaeo/shared/load-env";
import { prisma } from "@archaeo/db";
import { createModels, loadModelConfig, providersInUse, routeId, type CallRecorder, type ModelCallRecord, type ModelTask } from "@archaeo/models";

/**
 * `pnpm models:check`: one small request per model route the app uses, so live keys, model IDs and the API's wire
 * format are confirmed before an ingest or a demo. Checks that the reasoning model returns tool calls (every agent
 * relies on them) and that embeddings fit the database's vector column. Never prints keys.
 */
const config = loadModelConfig();
const calls: ModelCallRecord[] = [];
const recorder: CallRecorder = { record: (c) => void calls.push(c) };
const models = createModels({ config, recorder });
let failed = false;

const [column] = await prisma.$queryRaw<{ dims: number }[]>`
  SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = '"Chunk"'::regclass AND attname = 'embedding'`;
await prisma.$disconnect();

console.log(`Mode: ${config.mode}`);
// In mock mode, show what live mode would call, so missing keys are visible before switching.
const live = config.mode === "live" ? config : loadModelConfig({ ...process.env, MODEL_PROVIDER: "live" });
for (const [name, tasks] of providersInUse(live)) {
  const p = live.providers[name];
  const ids = [...new Set(tasks.map((t) => live.tasks[t].model))].join(", ");
  console.log(`  ${name} (${tasks.join(", ")}; ${ids}): base URL ${p.baseUrl ? "set" : "missing"}, API key ${p.apiKey ? "set" : "missing"}`);
}
if (config.mode === "mock") {
  console.log("Nothing to check: every task uses the offline mock. Set MODEL_PROVIDER=live in .env to check the real models.");
  process.exit(0);
}

async function check(task: ModelTask, what: string, fn: () => Promise<string>): Promise<void> {
  const route = routeId(config, task);
  const before = calls.length;
  const started = Date.now();
  try {
    const note = await fn();
    const call = calls[before];
    const tokens = call ? `${call.tokensIn} in / ${call.tokensOut} out` : "no usage reported";
    const price = config.pricing[config.tasks[task].model] ? "" : "; no price set (MODEL_PRICING), so cost limits can't apply";
    console.log(`OK    ${task.padEnd(14)} ${route}: ${what}: ${note} (${Date.now() - started} ms, ${tokens}${config.mode === "live" ? price : ""})`);
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${task.padEnd(14)} ${route}: ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await check("reason", "tool call", async () => {
  const step = await models.reason(
    [
      { role: "system", content: "You can look up files. Use the tool to answer." },
      { role: "user", content: "How many lines does src/app.py have? Use the tool." },
    ],
    [{ name: "count_lines", description: "Counts the lines of a file in the repository.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  );
  const call = step.toolCalls[0];
  if (!call) throw new Error(`no tool call returned (finish reason ${step.finishReason}); the agents need tool calling. Reply: ${step.content.slice(0, 200)}`);
  return `called ${call.name}(${JSON.stringify(call.arguments)})`;
});

await check("reason", "JSON answer", async () => {
  const step = await models.reason([{ role: "user", content: 'Respond with JSON only: {"ok": true}' }]);
  const text = step.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  JSON.parse(text);
  return "valid JSON";
});

await check("writeCode", "unified diff", async () => {
  const step = await models.writeCode([
    { role: "user", content: "Write a unified diff that changes the line `x = 1` to `x = 2` in src/a.py. Reply with the diff only." },
  ]);
  if (!/^[-+]{3} /m.test(step.content) || !/^@@/m.test(step.content)) throw new Error(`no unified diff in the reply: ${step.content.slice(0, 200)}`);
  return "diff returned";
});

await check("summarizeCheap", "summary", async () => {
  const text = await models.summarizeCheap({ text: "def add(a, b):\n    return a + b\n", instruction: "Summarize this Python file in one sentence." });
  if (!text.trim()) throw new Error("empty summary");
  return JSON.stringify(text.slice(0, 80));
});

await check("embed", "embedding", async () => {
  const [a, b] = await models.embed(["parse command line arguments", "parse command-line options"]);
  if (!a || !b) throw new Error("no vectors returned");
  if (a.length !== column?.dims) {
    throw new Error(`vectors have ${a.length} dimensions but the Chunk.embedding column has ${column?.dims}; set EMBED_DIM and migrate the column`);
  }
  const cos = a.reduce((s, v, i) => s + v * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b));
  return `${a.length} dimensions, similar texts score ${cos.toFixed(2)}`;
});

process.exit(failed ? 1 : 0);

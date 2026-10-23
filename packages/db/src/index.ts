import { PrismaClient } from "@prisma/client";
import type { CallRecorder, ModelCallRecord } from "@archaeo/models";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Shared Prisma client. Reused across hot reloads in dev. */
export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Persists every model call to the ModelCall table. Failures are logged, never thrown. */
export class PrismaCallRecorder implements CallRecorder {
  constructor(private readonly client: PrismaClient = prisma) {}

  async record(call: ModelCallRecord): Promise<void> {
    try {
      await this.client.modelCall.create({
        data: {
          runId: call.runId ?? null,
          task: call.task,
          model: call.model,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          latencyMs: call.latencyMs,
          cost: call.cost,
        },
      });
    } catch (err) {
      console.warn("[db] failed to record model call", err);
    }
  }
}

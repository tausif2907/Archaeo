-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "parentRunId" TEXT;

-- AlterTable
ALTER TABLE "FixAttempt" ADD COLUMN     "applied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "applyError" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "baseSha" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "newFailures" TEXT[],
ADD COLUMN     "regressionTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reproduced" BOOLEAN,
ADD COLUMN     "testSummary" TEXT;

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "sandboxConfig" JSONB;

-- CreateIndex
CREATE INDEX "AgentRun_repoId_kind_createdAt_idx" ON "AgentRun"("repoId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

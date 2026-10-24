-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "output" JSONB;

-- AlterTable
ALTER TABLE "Module" ADD COLUMN     "fingerprint" TEXT;

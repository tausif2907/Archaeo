-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "githubSyncedAt" TIMESTAMP(3),
ADD COLUMN     "headSha" TEXT,
ADD COLUMN     "stage" TEXT;

-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "endLine" INTEGER,
ADD COLUMN     "path" TEXT,
ADD COLUMN     "startLine" INTEGER;

-- CreateIndex
CREATE INDEX "Chunk_repoId_path_idx" ON "Chunk"("repoId", "path");

-- CreateIndex
CREATE INDEX "Chunk_sourceId_idx" ON "Chunk"("sourceId");


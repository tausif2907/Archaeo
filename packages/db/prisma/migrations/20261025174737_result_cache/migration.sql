-- CreateTable
CREATE TABLE "ResultCache" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResultCache_repoId_kind_key_key" ON "ResultCache"("repoId", "kind", "key");

-- AddForeignKey
ALTER TABLE "ResultCache" ADD CONSTRAINT "ResultCache_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

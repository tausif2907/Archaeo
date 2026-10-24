-- AlterTable
ALTER TABLE "Era" ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "stats" JSONB;

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "mergeCommitSha" TEXT;

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "erasMessage" TEXT,
ADD COLUMN     "erasStatus" TEXT;

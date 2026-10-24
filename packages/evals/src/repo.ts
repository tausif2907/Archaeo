import "@archaeo/shared/load-env";
import { prisma, type Repo } from "@archaeo/db";

/** Finds an ingested repo by URL or exits with a helpful message. */
export async function requireReadyRepo(url: string): Promise<Repo> {
  const repo = await prisma.repo.findUnique({ where: { url } });
  if (!repo || repo.status !== "ready") {
    console.error(`${url} is not ingested (status: ${repo?.status ?? "missing"}). Ingest it from the web UI first.`);
    process.exit(2);
  }
  return repo;
}

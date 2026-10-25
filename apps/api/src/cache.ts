import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@archaeo/db";
import type { ModelConfig } from "@archaeo/models";

export type CacheKind = "why" | "flow" | "ask" | "trace";

/** Persistent store for finished agent results, so demo paths answer instantly, even after a restart. */
export interface ResultCache {
  get<T>(repo: { id: string; headSha: string | null }, kind: CacheKind, input: unknown): Promise<T | null>;
  set(repo: { id: string; headSha: string | null }, kind: CacheKind, input: unknown, value: unknown): Promise<void>;
}

/** Identifies the models whose output gets cached, so switching from mock to live (or to another model) misses. */
export function modelCacheKey(config: Pick<ModelConfig, "mode" | "tasks">): string {
  const { reason, embed } = config.tasks;
  return `${config.mode}|${reason.provider}/${reason.model}|${embed.provider}/${embed.model}`;
}

/** Trims and collapses whitespace in every string, so "Where  is X? " and "Where is X?" share an entry. */
function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

export function cacheKey(headSha: string | null, modelKey: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ headSha, modelKey, input: normalize(input) }))
    .digest("hex");
}

export function createResultCache(prisma: PrismaClient, modelKey: string): ResultCache {
  return {
    async get<T>(repo: { id: string; headSha: string | null }, kind: CacheKind, input: unknown) {
      const row = await prisma.resultCache.findUnique({
        where: { repoId_kind_key: { repoId: repo.id, kind, key: cacheKey(repo.headSha, modelKey, input) } },
        select: { value: true },
      });
      return (row?.value as T | undefined) ?? null;
    },

    async set(repo, kind, input, value) {
      const key = cacheKey(repo.headSha, modelKey, input);
      const json = value as Prisma.InputJsonValue;
      await prisma.resultCache.upsert({
        where: { repoId_kind_key: { repoId: repo.id, kind, key } },
        create: { repoId: repo.id, kind, key, value: json },
        update: { value: json, createdAt: new Date() },
      });
    },
  };
}

/** For tests and for running without a database: never hits. */
export const noCache: ResultCache = {
  async get() {
    return null;
  },
  async set() {},
};

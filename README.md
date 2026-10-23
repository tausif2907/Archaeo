# Archaeo

Point Archaeo at any GitHub repo to **understand its past, see its present, and fix its future**.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). The build plan and progress live in [ARCHAEO_PLAN.md](ARCHAEO_PLAN.md).

## Status

Phase 0 (setup) is done: monorepo, Postgres + pgvector, Redis, Prisma schema, a task-based model layer with an offline mock provider, and a web page that queues a repo for ingest. The ingest pipeline comes next (Phase 1).

## Quick start

Requires Node 22+, pnpm 9, and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:deploy
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000 (`GET /health`, `POST /repos`, `GET /repos/:id`)

With `MODEL_PROVIDER=mock` (the default), everything runs offline with canned model outputs.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs web, api, and worker in watch mode |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | ESLint over the workspace |
| `pnpm test` | Vitest in every package |
| `pnpm db:migrate` | Creates and applies a Prisma migration (dev) |

## Layout

```
apps/web       Next.js UI
apps/api       Fastify API
apps/worker    BullMQ workers
packages/db       Prisma schema and client
packages/models   All model calls: summarizeCheap, reason, writeCode, generateImage, embed
packages/shared   zod schemas and shared types
packages/ingest, agent, sandbox, evals   Later phases
```

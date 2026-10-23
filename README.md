# Archaeo

Point Archaeo at any GitHub repo to **understand its past, see its present, and fix its future**.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). The build plan and progress live in [ARCHAEO_PLAN.md](ARCHAEO_PLAN.md).

## Status

Phases 0–1 are done. Paste a GitHub URL and Archaeo clones it, parses it with tree-sitter (Python, TypeScript, JavaScript), builds import and call graphs, reads the full commit history plus merged PRs and issues, embeds code, commits and PRs into pgvector, and summarizes files and commits. The UI shows live stage-by-stage progress. Re-ingest only processes what changed. The Past (timeline of eras) comes next (Phase 2).

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
- API: http://localhost:4000 (`GET /health`, `POST /repos`, `GET /repos/:id`, `GET /repos/:id/progress`, `POST /repos/:id/ingest`)

With `MODEL_PROVIDER=mock` (the default), everything runs offline with canned model outputs. Set `GITHUB_TOKEN` in `.env`: without it, GitHub allows 60 API requests per hour, which is about one first-time ingest of a mid-sized repo.

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
packages/ingest   clone, tree-sitter parsing, import/call graph, git log, GitHub fetchers, chunking
packages/agent, sandbox, evals   Later phases
```

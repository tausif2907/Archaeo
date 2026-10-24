# Archaeo

Point Archaeo at any GitHub repo to **understand its past, see its present, and fix its future**.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). The build plan and progress live in [ARCHAEO_PLAN.md](ARCHAEO_PLAN.md).

## Status

Phases 0–2 are done. Paste a GitHub URL and Archaeo clones it, parses it with tree-sitter (Python, TypeScript, JavaScript), builds import and call graphs, reads the full commit history plus merged PRs and issues, embeds code, commits and PRs into pgvector, and summarizes files and commits. **The Past:** history is split into eras (release- and topic-aware) with cited narratives on an interactive timeline, and "Why does this exist?" explains any file or symbol from its introducing commit, PRs, major changes and blame. Every SHA and PR citation is validated. Next: the architecture map and Q&A agent (Phase 3).

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
- API: http://localhost:4000 (`GET /health`, `POST /repos`, `GET /repos/:id`, `GET /repos/:id/progress`, `POST /repos/:id/ingest`, `GET|POST /repos/:id/eras`, `POST /repos/:id/why`, `GET /repos/:id/files`, `GET /repos/:id/symbols`)

With `MODEL_PROVIDER=mock` (the default), everything runs offline with canned model outputs. Set `GITHUB_TOKEN` in `.env`: without it, GitHub allows 60 API requests per hour, which is about one first-time ingest of a mid-sized repo.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs web, api, and worker in watch mode |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | ESLint over the workspace |
| `pnpm test` | Vitest in every package |
| `pnpm db:migrate` | Creates and applies a Prisma migration (dev) |
| `pnpm eval:history` | Scores "why" answers against `packages/evals/datasets/history.json` (needs the repo ingested) |
| `pnpm check:citations` | Fails if any stored era narrative cites a commit or PR that doesn't exist |

## Layout

```
apps/web       Next.js UI
apps/api       Fastify API
apps/worker    BullMQ workers
packages/db       Prisma schema and client
packages/models   All model calls: summarizeCheap, reason, writeCode, generateImage, embed
packages/shared   zod schemas and shared types
packages/ingest   clone, tree-sitter parsing, import/call graph, git log, GitHub fetchers, chunking
packages/agent    History reasoning (eras, narratives, citations, why); agent loop comes in Phase 3
packages/evals    Eval datasets and runners
packages/sandbox  Later phases
```

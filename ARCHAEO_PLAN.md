# Archaeo — Build Plan

> Point Archaeo at any GitHub repo to **understand its past, see its present, and fix its future**.
> Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Theme: *Push the Frontier (software)*.

This file is the source of truth for building Archaeo. Work through it **phase by phase, in order**.

---

## 0. Instructions for Claude Code

- Work one phase at a time. **Do not start the next phase until every acceptance check in the current phase passes.**
- After finishing a task, tick its checkbox (`- [x]`) in this file and commit.
- Keep commits small and descriptive (`feat(ingest): parse imports with tree-sitter`).
- **Never add Claude as a co-author or contributor on commits or PRs.** No `Co-Authored-By` lines or "Generated with" footers.
- If a decision is not covered here, choose the simplest option that keeps the demo working, and write it under **Decisions log** at the bottom.
- Do not hard-code model names or endpoints in feature code. All model calls go through `packages/models` (see §3).
- Never commit secrets. Use `.env` (gitignored) and keep `.env.example` updated.
- Prefer working, demoable slices over completeness. If behind schedule, follow the **Cut list** (§11).

---

## 1. Product scope

| Pillar | What the user sees | Core capability |
|---|---|---|
| **Past** | Timeline of "eras", plus "why does this exist?" for any file or function | Commit and PR history turned into a narrated, cited story |
| **Present** | Interactive architecture map, codebase Q&A chat, request-flow walkthrough | Code graph plus agentic retrieval with file and line citations |
| **Future** | Paste an error or issue, see suspects and evidence, get a tested patch and PR | Bug-tracing agent, then a sandboxed fix loop, then a PR after human approval |

**Non-goals:** IDE plugin, private-repo auth beyond a GitHub token, more than 2 languages, multi-user teams.

---

## 2. Tech stack

- **Language:** TypeScript (Node 22+), pnpm workspaces
- **Web:** Next.js (App Router), Tailwind, React Flow (architecture map)
- **Agent API:** Node service, Server-Sent Events (SSE) streaming
- **Jobs:** BullMQ + Redis
- **DB:** PostgreSQL + pgvector, Prisma ORM
- **Code parsing:** tree-sitter (`web-tree-sitter` or `node-tree-sitter`): TypeScript/JavaScript and Python first
- **Git:** `simple-git` for local history, GitHub REST/GraphQL API for PRs and issues (Octokit)
- **Sandbox:** Modal Sandboxes (clone the repo, apply the patch, run tests)
- **Models:** Meta Model API (Muse Spark, Muse Code, Muse Image) and Meta open-weights models via Baseten or Fireworks
- **Testing:** Vitest (unit), Playwright (one end-to-end flow)
- **Deploy:** Docker Compose locally, then one hosted deploy (Render, Fly, or Vercel plus a separate API host)

---

## 3. Repository layout

```
archaeo/
├─ apps/
│  ├─ web/            # Next.js UI: repo input, timeline, map, chat, bug tracer
│  ├─ api/            # Agent API: chat, trace, fix endpoints (SSE)
│  └─ worker/         # BullMQ workers: ingest, summarize, embed, eras
├─ packages/
│  ├─ db/             # Prisma schema, migrations, pgvector setup
│  ├─ models/         # ONE place for all model clients (see below)
│  ├─ ingest/         # clone, tree-sitter parsing, call graph, git + GitHub fetchers
│  ├─ agent/          # agent loop, tool registry, run limits, cost tracking
│  ├─ sandbox/        # Modal sandbox wrapper: run tests, apply patch
│  ├─ shared/         # zod schemas and shared types
│  └─ evals/          # eval datasets plus runner
├─ docker-compose.yml # postgres (pgvector), redis
├─ .env.example
└─ ARCHAEO_PLAN.md
```

### `packages/models` contract

Expose task-based functions, not vendor-based ones, so the backing model can be swapped once real API details are confirmed at kickoff:

```ts
summarizeCheap(input): Promise<string>        // open-weights, high volume
reason(messages, tools?): Promise<AgentStep>  // Muse Spark, tool calling
writeCode(messages, tools?): Promise<AgentStep> // Muse Code
generateImage(prompt): Promise<ImageResult>   // Muse Image (optional)
embed(texts: string[]): Promise<number[][]>
```

Each call records model, tokens in/out, latency, and estimated cost to a `ModelCall` table.
**TBD at kickoff:** exact Meta Model API endpoints, model IDs, context limits, and tool-calling format. Put them in config, never in feature code.

---

## 4. Data model (initial Prisma sketch)

- `Repo` — url, defaultBranch, language, status (`queued|ingesting|ready|failed`), stats
- `File` — repoId, path, language, loc, summary, complexity, churn
- `Symbol` — fileId, kind (function/class/method), name, startLine, endLine, summary
- `Edge` — repoId, fromSymbolId/fromFileId, toSymbolId/toFileId, kind (`import|call`)
- `Commit` — repoId, sha, author, date, message, filesChanged, summary
- `PullRequest` — repoId, number, title, body, mergedAt, linkedCommitShas
- `Issue` — repoId, number, title, body, state, labels
- `Era` — repoId, title, startDate, endDate, narrative, keyCommitShas, keyPrNumbers
- `Module` — repoId, path (folder), summary, parentPath
- `Chunk` — repoId, sourceType (`code|commit|pr`), sourceId, text, embedding (vector)
- `AgentRun` — repoId, kind (`chat|trace|fix`), input, status, toolCalls, costEstimate
- `FixAttempt` — runId, patch, testOutput, passed, prUrl
- `ModelCall` — runId?, task, model, tokensIn, tokensOut, latencyMs, cost

---

## 5. Phase 0 — Setup (before Oct 26)

- [x] Init pnpm monorepo with the layout in §3
- [x] `docker-compose.yml` with Postgres (pgvector image) and Redis
- [x] Prisma schema from §4, first migration, pgvector extension enabled
- [x] `packages/models` with the contract in §3, backed by a **mock provider** returning canned outputs so everything runs before API keys exist
- [x] `.env.example` listing: `DATABASE_URL`, `REDIS_URL`, `GITHUB_TOKEN`, `META_API_KEY`, `META_API_BASE_URL`, `OPENWEIGHTS_PROVIDER`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`
- [x] Next.js app with a single page: repo URL input and a status card
- [x] CI: typecheck, lint, unit tests
- [x] Choose the **demo repo** and 2 backups. Criteria: 20–50k LOC, TypeScript or Python, multi-year history, real PR descriptions, test suite under 2 minutes, a few open bug issues. Record them under **Decisions log**.

**Acceptance**
- `docker compose up` plus `pnpm dev` runs web, api, and worker with no errors
- The mock model provider passes a unit test for every contract function
- The demo repo's tests run locally and pass

---

## 6. Phase 1 — Ingest (Days 1–2)

- [x] `POST /repos { url }` creates a `Repo` and enqueues `ingest`
- [ ] Clone (shallow for code, full history via `git log`) into a workspace dir, with size cap (e.g. 200k LOC, else fail with a clear message)
- [ ] tree-sitter parse: files, symbols, imports; build `import` edges; best-effort `call` edges
- [ ] Compute per-file LOC, simple complexity (e.g. branch count), and churn (commits touching the file)
- [ ] Fetch commits (message, files, diff stats) and PRs and issues via Octokit; link PRs to merge commits
- [ ] Chunk code by symbol, plus commits and PRs; embed them into `Chunk`
- [ ] `summarizeCheap` per file and per commit, as batched BullMQ jobs with concurrency and retry
- [ ] SSE or polling progress endpoint; UI progress bar with stages (clone, parse, history, embed, summarize)
- [ ] Idempotent re-ingest (skip unchanged files by hash)

**Acceptance**
- Pasting the demo repo URL reaches `ready`, and the counts of files, symbols, commits, and PRs match reality within reason
- Re-running ingest on the same repo is fast and creates no duplicates
- Unit tests cover the parser on fixtures for TypeScript and Python

---

## 7. Phase 2 — The Past (Days 3–4)

- [ ] **Era detection:** group commits by time windows and the top-level folders they touch; merge adjacent similar windows; target 5–12 eras per repo
- [ ] For each era, `reason()` writes a narrative: what changed, why (from PR bodies), and key contributors. **Every claim cites commit SHAs or PR numbers**
- [ ] Timeline UI: horizontal eras; clicking one shows the narrative plus linked commits and PRs (deep links to GitHub)
- [ ] **"Why does this exist?"** For a file or symbol, walk blame and history to its introducing and major-change commits, then explain with citations
- [ ] Store narratives in `Era`; regenerate on demand

**Acceptance**
- 5 hand-written history questions about the demo repo are answered correctly, with valid citations
- No narrative contains a SHA or PR number that does not exist (automated check)

---

## 8. Phase 3 — The Present (Days 4–6)

- [ ] Module summaries bottom-up: files, then folders, then a repo overview (`Module`)
- [ ] **Architecture map** (React Flow): nodes are modules; edges are aggregated imports; node size is LOC or complexity; color is churn (hotspots). Click a node to see its summary and key files
- [ ] **Agent loop** in `packages/agent`:
  - Tools: `search_code` (vector plus keyword), `read_file(path, startLine?, endLine?)`, `get_callers(symbol)`, `get_callees(symbol)`, `git_blame(path, line)`, `list_dir(path)`
  - Limits per run: max 10 tool calls, 90 s, cost cap; all configurable
  - Streams steps to the UI over SSE
- [ ] **Q&A chat** UI: answers must cite `path:line` ranges that link into a code viewer
- [ ] **Request-flow walkthrough:** given an entry point (route or CLI command), the agent traces the call path and the UI highlights each hop on the map with a one-line explanation
- [ ] (Optional) Muse Image overview illustration of the architecture

**Acceptance**
- 10 hand-written code questions answered correctly, with valid citations (cited lines exist and are relevant)
- The map renders the demo repo in under 3 s and stays usable (collapse or expand folders)
- Agent runs always stop within the limits; a test forces a limit and checks the graceful message

---

## 9. Phase 4 — The Future (Days 6–8)

### Bug tracer
- [ ] Input: pasted error or stack trace, or a GitHub issue URL
- [ ] Parse stack frames into files and lines; pull issue text and comments
- [ ] Candidate ranking: stack frames, then call-graph neighbors, then embedding similarity; keep the top 5 as **suspects**
- [ ] `reason()` investigates suspects with agent tools and outputs a structured report: root-cause hypothesis, evidence (path:line plus why), confidence, and the files to change
- [ ] UI: "case file" view with suspects, evidence, and the hypothesis

### Fixer
- [ ] `packages/sandbox`: create a Modal sandbox, clone the repo at a given SHA, install dependencies (cache the image per repo), and run the test command
- [ ] `writeCode()` produces a unified diff for the suspected files; apply it in the sandbox
- [ ] Run the tests. On failure, feed the test output back and retry (max 3 attempts)
- [ ] Optionally write a regression test for the bug when feasible
- [ ] Store each `FixAttempt` with the patch, test output, and pass/fail

### PR
- [ ] Show the diff plus test results; the user must click **Approve** before anything is pushed
- [ ] On approval: create a branch on a **fork** owned by the configured account, push, and open a PR with the explanation, evidence, and test results
- [ ] PR body and commits contain **no AI co-author or attribution lines**

**Acceptance**
- One real or historical bug in the demo repo goes end to end: issue, suspects, passing patch, PR on a fork
- A patch that breaks tests is never offered for approval
- Nothing is pushed without explicit approval (test covers this)

---

## 10. Phase 5 — Evals and hardening (Day 9)

- [ ] `packages/evals` datasets (JSON):
  - `history.json`: ~20 questions with expected facts and SHAs
  - `qa.json`: ~20 code questions with expected files
  - `bugs.json`: 5–10 historical bugs: pre-fix SHA, issue text, files changed in the real fix, test command
- [ ] Runner: `pnpm eval` writes a Markdown report with:
  - history answer accuracy and citation validity
  - Q&A answer accuracy and file recall
  - bug tracing: real fix file in top-1 and top-3
  - fixer: pass rate, average attempts
  - average cost and latency per run type
- [ ] Run on one backup repo in a second language to check generalization
- [ ] Fix the top failure modes; add caching for every demo path
- [ ] Error states in the UI for every failure (ingest fails, model timeout, sandbox fails)

**Acceptance**
- `pnpm eval` runs end to end and produces `evals/REPORT.md` with real numbers
- The demo path works three times in a row from a cold start with cached ingestion

---

## 11. Phase 6 — Demo and submission (Day 10, Nov 4)

- [ ] Deploy a public link with the demo repo **pre-ingested**
- [ ] README: problem, demo GIF, architecture diagram, which Meta model does what, eval results table, setup steps
- [ ] Record a 2–3 minute demo video:
  1. Paste repo URL, show the map appear
  2. Timeline: "Why was X rewritten?" with cited answer
  3. Chat: hard architecture question with `path:line` citations
  4. Paste a real issue: suspects, passing patch, approve, PR opened
  5. Flash the eval numbers
- [ ] Submit before **Nov 4, 9:00 PM ET (Nov 5, 7:30 AM IST)**; aim to submit by Nov 4 evening IST

### Cut list (if behind, cut in this order)
1. Muse Image visuals
2. Request-flow walkthrough (keep map plus chat)
3. Second-language support
4. Auto-PR (show the passing diff instead)

**Never cut:** the bug-to-tested-fix loop and the eval numbers.

---

## 12. Model routing

| Job | Function | Backing model |
|---|---|---|
| File and commit summaries | `summarizeCheap` | Meta open-weights (Baseten or Fireworks) |
| Era stories, Q&A, bug reasoning | `reason` | Muse Spark |
| Patches and tests | `writeCode` | Muse Code |
| Overview art | `generateImage` | Muse Image |
| Retrieval | `embed` | Open-weights embedding model (confirm at kickoff) |

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Huge repos blow context or cost | Size cap, hierarchical summaries, retrieval rather than stuffing |
| Slow or flaky test suites | Choose the demo repo for fast tests; cache sandbox images |
| Rate limits or credit limits | Batch and cache summaries; claim Baseten, Modal, and Fireworks credits on day 1 |
| Hallucinated citations | Automated check that every SHA, PR, and `path:line` exists; drop or flag invalid ones |
| Unsafe actions | Human approval before push; fork-only PRs; per-run limits |
| Model API details unknown until kickoff | Mock provider plus the `packages/models` contract |

---

## Decisions log

_Record decisions here as they are made (date, decision, reason)._

- **2026-10-24 — Demo repo: [`pallets/click`](https://github.com/pallets/click).** Python, ~30k LOC, history since 2014 (~3.4k commits), detailed PRs, active bug issues. Test suite: 2184 passed / 102 skipped in ~8 s locally (Python 3.12, `pytest`).
- **2026-10-24 — Backups: [`pallets/werkzeug`](https://github.com/pallets/werkzeug)** (Python, ~37.6k LOC, history since 2007) **and [`encode/httpx`](https://github.com/encode/httpx)** (Python, ~17.8k LOC, history since 2019). Phase 5 also needs a TypeScript repo for the second-language eval; pick it then.
- **2026-10-24 — Local ports 5442 (Postgres) and 6389 (Redis)**, overridable with `POSTGRES_PORT` / `REDIS_PORT`. The defaults clashed with other local projects.
- **2026-10-24 — Internal packages ship TypeScript source** (`exports` → `src/index.ts`), run with `tsx` and Next's `transpilePackages`. No build step to keep in sync.
- **2026-10-24 — API uses Fastify**; routes take injected dependencies (`RepoStore`, `enqueueIngest`) so they are unit-tested without Postgres or Redis.
- **2026-10-24 — Models: `MODEL_PROVIDER=mock|live`.** Mock is the default. Live routes `reason`/`writeCode`/`generateImage` to the Meta API and `summarizeCheap`/`embed` to Baseten or Fireworks, all through an OpenAI-compatible HTTP client. The Meta wire format is an assumption until kickoff. Model IDs come from `MODEL_*` env vars, with placeholders in `packages/models/src/config.ts`. Prices are empty (cost recorded as 0) until known.
- **2026-10-24 — Embedding dimension 1024** (`EMBED_DIM`, `vector(1024)` column). Changing it after kickoff needs a migration. The mock embedder uses feature hashing (bag of words), so offline retrieval still returns sensible matches.
- **2026-10-24 — `ModelCall` recording is injected** (`CallRecorder` interface in `models`, `PrismaCallRecorder` in `db`) so `models` does not depend on the DB.
- **2026-10-24 — Phase 0 worker is a stub:** it consumes the `ingest` queue and leaves the repo `queued` with "Ingest pipeline not implemented yet (Phase 1)".

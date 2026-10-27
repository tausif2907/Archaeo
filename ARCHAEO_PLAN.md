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
- [x] Clone (shallow for code, full history via `git log`) into a workspace dir, with size cap (e.g. 200k LOC, else fail with a clear message)
- [x] tree-sitter parse: files, symbols, imports; build `import` edges; best-effort `call` edges
- [x] Compute per-file LOC, simple complexity (e.g. branch count), and churn (commits touching the file)
- [x] Fetch commits (message, files, diff stats) and PRs and issues via Octokit; link PRs to merge commits
- [x] Chunk code by symbol, plus commits and PRs; embed them into `Chunk`
- [x] `summarizeCheap` per file and per commit, as batched BullMQ jobs with concurrency and retry
- [x] SSE or polling progress endpoint; UI progress bar with stages (clone, parse, history, embed, summarize)
- [x] Idempotent re-ingest (skip unchanged files by hash)

**Acceptance**
- Pasting the demo repo URL reaches `ready`, and the counts of files, symbols, commits, and PRs match reality within reason
- Re-running ingest on the same repo is fast and creates no duplicates
- Unit tests cover the parser on fixtures for TypeScript and Python

---

## 7. Phase 2 — The Past (Days 3–4)

- [x] **Era detection:** group commits by time windows and the top-level folders they touch; merge adjacent similar windows; target 5–12 eras per repo
- [x] For each era, `reason()` writes a narrative: what changed, why (from PR bodies), and key contributors. **Every claim cites commit SHAs or PR numbers**
- [x] Timeline UI: horizontal eras; clicking one shows the narrative plus linked commits and PRs (deep links to GitHub)
- [x] **"Why does this exist?"** For a file or symbol, walk blame and history to its introducing and major-change commits, then explain with citations
- [x] Store narratives in `Era`; regenerate on demand

**Acceptance**
- 5 hand-written history questions about the demo repo are answered correctly, with valid citations
- No narrative contains a SHA or PR number that does not exist (automated check)

---

## 8. Phase 3 — The Present (Days 4–6)

- [x] Module summaries bottom-up: files, then folders, then a repo overview (`Module`)
- [x] **Architecture map** (React Flow): nodes are modules; edges are aggregated imports; node size is LOC or complexity; color is churn (hotspots). Click a node to see its summary and key files
- [x] **Agent loop** in `packages/agent`:
  - Tools: `search_code` (vector plus keyword), `read_file(path, startLine?, endLine?)`, `get_callers(symbol)`, `get_callees(symbol)`, `git_blame(path, line)`, `list_dir(path)`
  - Limits per run: max 10 tool calls, 90 s, cost cap; all configurable
  - Streams steps to the UI over SSE
- [x] **Q&A chat** UI: answers must cite `path:line` ranges that link into a code viewer
- [x] **Request-flow walkthrough:** given an entry point (route or CLI command), the agent traces the call path and the UI highlights each hop on the map with a one-line explanation
- [ ] (Optional) Muse Image overview illustration of the architecture

**Acceptance**
- 10 hand-written code questions answered correctly, with valid citations (cited lines exist and are relevant)
- The map renders the demo repo in under 3 s and stays usable (collapse or expand folders)
- Agent runs always stop within the limits; a test forces a limit and checks the graceful message

---

## 9. Phase 4 — The Future (Days 6–8)

### Bug tracer
- [x] Input: pasted error or stack trace, or a GitHub issue URL
- [x] Parse stack frames into files and lines; pull issue text and comments
- [x] Candidate ranking: stack frames, then call-graph neighbors, then embedding similarity; keep the top 5 as **suspects**
- [x] `reason()` investigates suspects with agent tools and outputs a structured report: root-cause hypothesis, evidence (path:line plus why), confidence, and the files to change
- [x] UI: "case file" view with suspects, evidence, and the hypothesis

### Fixer
- [x] `packages/sandbox`: create a Modal sandbox, clone the repo at a given SHA, install dependencies (cache the image per repo), and run the test command _(Docker provider; the Modal adapter waits on Modal tokens, see Decisions log)_
- [x] `writeCode()` produces a unified diff for the suspected files; apply it in the sandbox
- [x] Run the tests. On failure, feed the test output back and retry (max 3 attempts)
- [x] Optionally write a regression test for the bug when feasible
- [x] Store each `FixAttempt` with the patch, test output, and pass/fail

### PR
- [x] Show the diff plus test results; the user must click **Approve** before anything is pushed
- [ ] On approval: create a branch on a **fork** owned by the configured account, push, and open a PR with the explanation, evidence, and test results _(implemented in `GitHubForkPublisher`; not yet run against GitHub: needs a `GITHUB_TOKEN` that can fork and open PRs)_
- [x] PR body and commits contain **no AI co-author or attribution lines**

**Acceptance**
- One real or historical bug in the demo repo goes end to end: issue, suspects, passing patch, PR on a fork
- A patch that breaks tests is never offered for approval
- Nothing is pushed without explicit approval (test covers this)

---

## 10. Phase 5 — Evals and hardening (Day 9)

- [x] `packages/evals` datasets (JSON):
  - `history.json`: ~20 questions with expected facts and SHAs
  - `qa.json`: ~20 code questions with expected files
  - `bugs.json`: 5–10 historical bugs: pre-fix SHA, issue text, files changed in the real fix, test command
- [x] Runner: `pnpm eval` writes a Markdown report with:
  - history answer accuracy and citation validity
  - Q&A answer accuracy and file recall
  - bug tracing: real fix file in top-1 and top-3
  - fixer: pass rate, average attempts
  - average cost and latency per run type
- [x] Run on one backup repo in a second language to check generalization
- [x] Fix the top failure modes; add caching for every demo path
- [x] Error states in the UI for every failure (ingest fails, model timeout, sandbox fails)

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
- **2026-10-24 — Parsing uses `web-tree-sitter` (wasm)** with the `.wasm` grammars shipped inside `tree-sitter-python` and `tree-sitter-typescript`. No native build on Windows or CI (`pnpm.neverBuiltDependencies` skips their node-gyp step). JavaScript is parsed with the TSX grammar.
- **2026-10-24 — Full clone instead of shallow.** `git log --numstat` needs every blob, so shallow or blobless clones would be slower overall. Re-ingest does `fetch` plus a hard reset of the workspace clone (`WORKSPACE_DIR`, default `.workspace/`).
- **2026-10-24 — Size cap is 200k non-blank LOC of parseable source** (`INGEST_MAX_LOC`). Files over 512 KB are treated as generated and skipped. Over the cap, the repo is marked `failed` with a clear message and not retried.
- **2026-10-24 — Call edges are best effort and never guessed:** same file, then imported files, then a repo-wide unique name. Ambiguous calls are dropped.
- **2026-10-24 — PR ↔ commit links** use the PR's merge commit SHA plus `Merge pull request #N` and a trailing `(#N)` on squash-merge subjects.
- **2026-10-24 — GitHub sync is incremental** (`Repo.githubSyncedAt`; PRs sorted by `updated`, issues via `since`). A GitHub failure, such as the rate limit without `GITHUB_TOKEN`, becomes a warning on the repo, not a failed ingest.
- **2026-10-24 — Summaries run as a BullMQ flow:** one `summarize` child job per 25 files or commits (3 attempts, exponential backoff), and a `finalize` parent marks the repo `ready`. Failed children don't block `ready`. Only the 1,000 most recent commits get a summary (`SUMMARIZE_MAX_COMMITS`) to bound live-model cost.
- **2026-10-24 — Progress uses polling** (`GET /repos/:id/progress`), with per-stage counts computed from the DB rather than stored counters. SSE is reserved for agent runs (Phase 3).
- **2026-10-24 — Chunks store `path`/`startLine`/`endLine`** so Phase 3 answers can cite `path:line` directly. Classes are chunked as their header only, so method bodies aren't embedded twice. No vector index yet: an exact scan over ~10k vectors per repo is fast enough. Add HNSW in Phase 3 if needed.
- **2026-10-24 — Phase 1 acceptance on pallets/click:** 91 files, 2,078 symbols, 3,379 commits, 1,086 merged PRs and 1,819 issues, all matching `git` and GitHub search. First ingest took ~2 min (mostly unauthenticated GitHub paging). Re-ingest took ~4 s with 0 new rows.
- **2026-10-24 — PR ↔ commit links include whole PR branches.** For every `Merge pull request #N` commit, the PR owns the commits reachable from its second parent and not from its first. These are found with git's date-ordered "paint" walk, in memory, from `%P` parents. This also covers PRs merged into maintenance branches. On click, commits linked to a PR went from 1,082 to the full branch history. `PullRequest.mergeCommitSha` is stored, and links are recomputed for every PR on each ingest.
- **2026-10-24 — Eras:** commits are bucketed into windows between major/minor release tags (calendar quarters when a repo has fewer than 6 releases). Adjacent windows are merged cheapest-first until the target count, `clamp(round(years × 0.75), 5, 12)`, is reached. Merge cost = area dissimilarity × √(smaller window) + penalties for eras much longer or larger than an even split. Areas are top-level folders with `src/` stripped (so the `click/` → `src/click/` move doesn't look like a new area). Any folder above 25% of activity is split into its modules. Bot commits count toward totals but carry no weight for areas or authorship. click comes out as 9 eras that follow its maintainer history.
- **2026-10-24 — Citations** use the syntax `[abc1234]` and `[#123]`. `validateCitations` removes any SHA (unique prefix, at least 7 characters) or PR/issue number that doesn't exist, bracketed or bare. `pnpm check:citations` re-checks every stored narrative.
- **2026-10-24 — Narratives fall back to evidence.** If `reason()` output isn't valid JSON or has no valid citation, the era narrative or why-answer is assembled from the evidence pack itself: stats, key PRs and commits, introducing commit, PR excerpt, blame. The mock provider always takes this path, so offline output is extractive but fully cited. Real narrative quality is unmeasured until the Meta API is live.
- **2026-10-24 — Narratives are reused while an era's evidence fingerprint is unchanged.** "Regenerate" forces a rewrite. Eras run on their own `eras` queue, queued automatically after ingest finalizes.
- **2026-10-24 — "Why does this exist?" runs synchronously in the API.** It uses `git log --follow` for files and `git log -L` for symbols or line ranges, plus `git blame -w -M`, and caches answers per repo HEAD. The API therefore needs the same `WORKSPACE_DIR` as the worker.
- **2026-10-24 — Phase 2 acceptance:** `pnpm eval:history` scores 5/5 on hand-checked click questions (introducing commit, linked PR, cited, no invalid citations). `pnpm check:citations` finds 0 invalid citations across 9 eras (17 commit and 40 PR citations).
- **2026-10-24 — Skipped the optional Muse Image overview illustration** (first item on the cut list, and it needs the live model API).
- **2026-10-24 — The mock provider acts as a minimal agent when tools are offered.** It calls whichever tool requires a `query`, then answers by citing the `path:line` ranges that tool returned. It knows nothing about features. This lets the agent loop, SSE streaming and UI run end to end offline. `AgentStep` carries `costUsd`, so the agent can enforce a cost cap.
- **2026-10-24 — Agent loop:** six tools (`search_code`, `read_file`, `get_callers`, `get_callees`, `git_blame`, `list_dir`). Limits are 10 tool calls, 90 s and $0.50 per run (`AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_SECONDS`, `AGENT_MAX_COST_USD`). Model calls and tools race the remaining time. Running out of tool calls gives the model one tool-free turn to answer; time and cost limits stop immediately. Every outcome ends in an answer that starts "I stopped early because I reached …". Unit tests force each limit.
- **2026-10-24 — `search_code` is hybrid:** pgvector cosine similarity plus IDF-weighted keyword matching (header, path and body), fused by reciprocal rank. tests/examples/docs rank lower unless the question mentions them.
- **2026-10-24 — Code citations use `[path:start-end]`.** Citations to missing files or lines are removed, and overlong ranges are clamped. If no valid citation is left, the answer falls back to the code the tools actually showed. Each Q&A run is saved as an `AgentRun` (tool calls, cost, answer). Q&A streams over SSE from `POST /repos/:id/ask`.
- **2026-10-24 — Chunk ranges are the lines a chunk contains.** Class chunks hold only the header, so citations never point at a 700-line class. `INDEX_VERSION` (worker) forces a full re-index of symbols, chunks and embeddings when parsing or chunking changes, keeping summaries for unchanged content.
- **2026-10-24 — Call-graph precision:** a closure (a function nested in a function) can only be called from its own file. The repo-wide unique-name rule never links application code to test code. An ambiguous `self.method()` call prefers the caller's own class. These rules removed false edges such as `_detect_program_name → test_path_option.exists`, and edges went from 1,830 to 2,118.
- **2026-10-24 — Module summaries are built bottom-up in the ingest finalize step:** files, then folders, then the repo overview (`Module.path = ""`). Each is reused while its fingerprint (the hash of its child summaries) is unchanged.
- **2026-10-24 — The architecture map uses a dependency-ordered grid instead of dagre.** On click's 20 visible modules with 76 import edges, every dagre setting needed ~0.35× zoom to fit. The grid (importers first, foundation modules last, wrapped to a 1.6:1 aspect) fits at ~0.85×. Selecting a node highlights its edges and fades the rest. Folders expand and collapse. Node width = LOC, color = churn percentile, and a "hot" badge marks nodes with both high churn and high complexity.
- **2026-10-24 — The request-flow walkthrough is a static call-graph trace.** Hops are chosen breadth-first (so make_context and invoke both appear) and shown depth-first as a call tree. Callees are ranked caller's own class, then same file, then body size and fan-out, and shown in call order with the calling line. Duplicate definitions (typing `@overload` stubs) resolve to the largest body. Explanations come from one `reason()` call, with docstrings as the fallback.
- **2026-10-24 — Playwright end-to-end tests** (`pnpm e2e`, needs the stack running with the demo repo ingested): the map draws nodes and edges in under 3 s (measured from navigation start) and folders expand and collapse; Q&A citations open the code viewer; the flow trace highlights hops on the map.
- **2026-10-24 — Phase 3 acceptance on click:** `pnpm eval:qa` passes 10/10 (a citation of at most 300 lines overlapping an expected symbol, and every citation valid). File recall is 10/10, and the first citation is in an expected file 6/10. Offline, the mock model only lists retrieved code, so this measures retrieval and citation checking, not answer quality. The map draws in ~0.95 s in dev mode. All three limit tests pass.
- **2026-10-25 — The sandbox runs on local Docker, not Modal.** There are no Modal tokens, so `packages/sandbox` defines a provider interface with a Docker implementation. Each run gets a fresh `git worktree` at the target commit, mounted into a container with `--network none`, 2 GB memory, 2 CPUs and a 512-process limit. Images are cached per repo by a hash of the dependency manifests. `SANDBOX_PROVIDER=modal` fails with a clear message until the adapter exists.
- **2026-10-25 — Sandbox images pin test dependencies from the repo's lock file** (`uv export --frozen --group tests`), falling back to `requirements/*test*.txt`, then plain `pytest`. An unpinned pytest 9.1 broke collection of click's 2026-06 commit, because its filterwarnings turned a deprecation into an error. Images include `git` and `less` (click's pager tests need `less`) and the project's build backend. Each run first does an offline editable install, `pip install --no-deps --no-build-isolation --no-index -e .`, because click's HEAD tests read the package metadata.
- **2026-10-25 — Patches are judged against a baseline run** at the base commit. A clean baseline must stay fully green. With a failing baseline, a patch passes only if pytest's failing test ids show no new failures. A failing baseline whose failures can't be parsed means nothing is offered. A patch must change non-test code. When a patch adds tests, those tests alone are also run against the unfixed code to check they fail (`reproduced`), which proves they target the bug. Without that check, an empty patch would "pass" at a commit where no test covers the bug.
- **2026-10-25 — Publishing happens only through `approveFixAttempt`.** The fix loop's `FixEnvironment` has no way to push. Approval requires the attempt to be the offered, passing, unpublished one, and records `approvedAt` before publishing (cleared again if publishing fails). `GitHubForkPublisher` forks into the token's account and pushes the base commit and the fix branch. With `PR_TARGET=fork` (the default) the PR opens **inside the fork**, against a branch pinned at the base commit, so demos never open PRs on the upstream project. `PR_TARGET=upstream` is opt-in. Commit author is `PR_AUTHOR_NAME`/`PR_AUTHOR_EMAIL`, else the token's GitHub user with their noreply email. PR text never carries AI attribution (tested).
- **2026-10-25 — Bug tracer:** Python and JS stack traces are parsed innermost-first and mapped onto repo files by the longest path suffix (`site-packages/click/core.py` → `src/click/core.py`). Suspects come from stack frames (decaying weight), call-graph neighbors of the two innermost frames, then code search. Test files are excluded unless the trace runs through them. The agent must return JSON (hypothesis, confidence, evidence refs, files to change). Invalid refs are dropped, and otherwise the report falls back to the ranking. Issues come from GitHub (title, body, first 10 comments), or the ingested copy when offline.
- **2026-10-25 — Keyword search matches at identifier boundaries with simple stemming.** In a bug report containing `[foo|bar|baz]`, "bar" ranked `progressbar` first under substring matching. Pure whole-word matching then lost "confirmation" → `confirm`. Boundary-plus-stem fixed both, and code Q&A first-citation accuracy went from 6/10 to 7/10.
- **2026-10-25 — Phase 4 acceptance on click.** Historical bug: `762c97e`, "Optional Choice arguments show doubled brackets", with pre-fix `8929d39`, described by symptom only.
  - Tracing ranks the real fix location, `Argument.make_metavar`, #2 (top-3 hit).
  - With the offline mock model, all 3 attempts fail to apply and nothing is offered.
  - `pnpm eval:bugs --replay` (a scripted model, a pipeline check rather than a model eval) runs a wrong patch first: 27 tests fail and it is refused. The real fix then gives 1,658 passing tests, and its regression tests fail without it. Approving the failing attempt is refused; the publisher has 0 calls before approval and exactly 1 after; the PR text has no attribution; re-approval is refused.
  - The Playwright test runs the Fix tab end to end in the real sandbox and confirms no Approve button appears for failing patches.
  - **Not yet done:** a PR on a real fork (needs a token) and a model-written passing patch (needs the live model). Historical-bug tracing currently uses the HEAD index, which already contains the fix; Phase 5 should index the pre-fix commit.
- **2026-10-25 — Phase 5 evals.** `pnpm eval` runs the history, Q&A and bug suites for every repo folder in `packages/evals/datasets/` and writes `evals/REPORT.md` (`--repo`, `--suite` and `--no-fix` narrow a run).
  - Each historical bug is traced against a temporary index of its pre-fix commit: a repo row whose URL ends in `#eval@<sha>`, hidden from the repo list and deleted afterwards. Tracing no longer sees the fix and ranks the real fix file first for 5 of 7 bugs; the HEAD index flattered it.
  - Datasets: click has 20 history questions, 20 Q&A questions and 7 sandbox-verified bugs. Left out: b7e5fd4 (fish completion), whose tests pin an internal output format no symptom report can specify, and f58ca3e, whose tests pass before the fix. got (TypeScript) has 12 history and 15 Q&A questions and no bug set yet.
  - Mock-mode results: history 20/20 (click) and 12/12 (got); Q&A 17/20 and 10/15; fixer 0/7, because the mock model writes no patch. Model numbers wait for API keys (`MODEL_PROVIDER=live`).
  - Mock embeddings are a bag-of-words hash, so vector search adds lexical noise (a large `types.ts` chunk resembles every question). The got Q&A misses were not tuned against it.
  - Fixed from eval failures. Code search keeps the 12 rarest of up to 30 terms (long bug reports used to stop at their first 12 words) and ignores `foo`/`bar`/`baz` placeholders (the demo trace ranked `progressbar` first). "Why does this exist?" reads up to 1,000 line-history commits (was 100), and a symbol's history starts at the commit that first added its definition line when that line is unique in the file: `git log -L` carried `NoSuchCommand` back to an unrelated 2014 class.
  - Dataset correction: `Group` is in click's initial commit (4101de3), not 955beb8.
- **2026-10-25 — Caching for demo paths.** Finished why, flow, ask and trace results live in a `ResultCache` table, keyed by repo, kind and a hash of HEAD, the reasoning and embedding model routes, and the whitespace-normalized input. A new commit, a model change or a re-ingest misses. Fallback results are not cached. A repeat ask or trace replays the original run (same run id and events), so its case file and Fix button keep working. After an API restart, every demo path answered three times in a row, each within about 3.7 s.
- **2026-10-26 — Deploy: one Docker host, not Render/Fly/Vercel.** The fixer needs Docker, which those platforms don't give an app. `docker-compose.prod.yml` runs Postgres, Redis, a migration step, the API, the workers, the web app, and Caddy in front, from one image built by the root `Dockerfile`. Caddy serves the API under `/api` on the same origin, so there's no CORS setup, SSE is flushed immediately, and a domain gets HTTPS automatically. The worker uses the host's Docker socket for sandboxes, so the data folder (`ARCHAEO_DATA`, default `/srv/archaeo`) is mounted at the same path in the containers, which keeps sandbox bind mounts valid on the host. Modal stays unimplemented.
- **2026-10-26 — Public demo mode.** `PUBLIC_DEMO=true` limits visitors to the pre-ingested repos. Adding, re-ingesting, regenerating eras and publishing are refused by the API (403) and hidden in the UI, and no publisher is created even with a token. Asking, tracing and sandboxed fix runs still work. `pnpm demo:prepare` ingests `demo/demo.json` through the database and queue, so it works with the demo on, then warms the demo answers through the API and flags any that fell back (and so weren't cached).
- **2026-10-27 — Switching from mock to live models.** Ingest only filled in missing embeddings and summaries, and eras reused narratives by evidence alone, so mock output would have survived the switch and mixed mock vectors into live vector search. Each repo's stats now record the embedding and summary model routes (`provider/model`), and each era records the model that wrote it. A re-ingest clears what another model produced, an unrecorded route counts as changed, and an era narrative is reused only when the same model wrote it without falling back. `pnpm demo:prepare` re-ingests repos built with other models, and `pnpm eval` skips them. `pnpm models:check` sends one small request per route: tool calling (every agent needs it), JSON, a unified diff, a summary, and an embedding whose size must match the 1,024-dimension column. `MODEL_PRICING` (JSON, USD per 1M tokens) replaces the empty price table, without which `AGENT_MAX_COST_USD` could never trigger.

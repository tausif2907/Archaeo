# Demo video script (2–3 minutes)

Before recording: `pnpm demo:prepare` with live models, so steps 2–3 answer from the cache. Every input below must match `demo/demo.json` exactly, apart from whitespace.

| # | Time | On screen | Type or click |
|---|---|---|---|
| 1 | 0:00–0:25 | Home page → repo page, the map appears | Paste `https://github.com/pallets/click`, click **Excavate** (or open it from the list on a public demo). Expand `src/click`, point at the `core.py` hotspot. |
| 2 | 0:25–0:55 | **Timeline**, then **Why** | Click an era, then a cited PR. In **Why**, enter `src/click/shell_completion.py`: it was rewritten in #1622, "Redesign Completion System". |
| 3 | 0:55–1:30 | **Ask** | `How does a command parse its arguments and pass them to my function?` Click a `path:line` citation to open the code viewer. |
| 4 | 1:30–2:30 | **Fix** | Paste a real bug report, show suspects and evidence, click **Generate a tested fix**, show the passing patch and its test results, then **Approve** to open the pull request. |
| 5 | 2:30–2:50 | `evals/REPORT.md` | The summary table: history, Q&A, bug tracing and fixer results. |

Step 4 needs a bug that exists at the ingested commit. A bug fixed upstream cannot be fixed again at HEAD, so the bug has to come from one of these:
- an open issue in the demo repo that the fixer can solve, found once live models are in;
- a fork of the demo repo kept at the commit before a known fix (for click, `8929d39`, the parent of `762c97e`, which shows doubled brackets for optional `Choice` arguments). Its fix passes 1,658 tests in the sandbox.

On a public demo (`PUBLIC_DEMO=true`) the Approve button is off, so record step 4 locally.

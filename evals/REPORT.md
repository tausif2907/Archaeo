# Archaeo eval report

Generated 2026-10-25 18:23 UTC with `pnpm eval` (Archaeo `c8a08b5`).

- **Repos:** pallets/click at `2247b35`; sindresorhus/got at `05b4476`
- **Models:** mock mode. Reasoning `mock/muse-spark`, code writing `mock/muse-code`, embeddings `mock/openweights-embedding-tbd`.
- **Datasets:** `packages/evals/datasets/<repo>/`. Ground truth comes from git history and reading the source, not from Archaeo.

> **Mock mode.** No model API keys were configured, so every agent ran end to end against the offline stand-in model.
> These numbers measure retrieval, ranking, citation checking and the fallbacks, not answer quality. The fixer cannot
> write a working patch in mock mode. Set `MODEL_PROVIDER=live` and the API keys in `.env`, then rerun `pnpm eval`.

## Summary

| Repo | Suite | Metric | Result |
|---|---|---|---|
| pallets/click | history | Answer accuracy (found, cited, all citations valid) | 20/20 (100%) |
| pallets/click | history | Introducing commit and PR found | 20/20 (100%) |
| pallets/click | history | Answer cites them | 20/20 (100%) |
| pallets/click | history | Citation validity (every cited SHA/PR exists) | 20/20 (100%) |
| pallets/click | qa | Answer accuracy (cites the expected code, all citations valid) | 17/20 (85%) |
| pallets/click | qa | File recall (an expected file is cited) | 19/20 (95%) |
| pallets/click | qa | First citation in an expected file | 13/20 (65%) |
| pallets/click | qa | Citation validity | 20/20 (100%) |
| pallets/click | bugs | Tracing: real fix file ranked #1 | 5/7 (71%) |
| pallets/click | bugs | Tracing: real fix file in top 3 | 5/7 (71%) |
| pallets/click | bugs | Fixer: passing patch offered | 0/7 (0%) |
| sindresorhus/got | history | Answer accuracy (found, cited, all citations valid) | 12/12 (100%) |
| sindresorhus/got | history | Introducing commit and PR found | 12/12 (100%) |
| sindresorhus/got | history | Answer cites them | 12/12 (100%) |
| sindresorhus/got | history | Citation validity (every cited SHA/PR exists) | 12/12 (100%) |
| sindresorhus/got | qa | Answer accuracy (cites the expected code, all citations valid) | 10/15 (67%) |
| sindresorhus/got | qa | File recall (an expected file is cited) | 11/15 (73%) |
| sindresorhus/got | qa | First citation in an expected file | 5/15 (33%) |
| sindresorhus/got | qa | Citation validity | 15/15 (100%) |

## Cost and latency per run type

| Repo | Run type | Runs | Avg latency | Avg model calls | Avg cost |
|---|---|---|---|---|---|
| pallets/click | Why does this exist? (history) | 20 | 800 ms | 1.0 | $0.0000 |
| pallets/click | Code Q&A | 20 | 261 ms | 3.0 | $0.0000 |
| pallets/click | Bug trace + fix | 7 | 61 s | 36.1 | $0.0000 |
| sindresorhus/got | Why does this exist? (history) | 12 | 426 ms | 1.0 | $0.0000 |
| sindresorhus/got | Code Q&A | 15 | 152 ms | 3.0 | $0.0000 |

Costs are $0 in mock mode. Latency is real: retrieval, tool calls, git and the sandbox.

## pallets/click: history

- Answer accuracy (found, cited, all citations valid): **20/20 (100%)**
- Introducing commit and PR found: **20/20 (100%)**
- Answer cites them: **20/20 (100%)**
- Citation validity (every cited SHA/PR exists): **20/20 (100%)**
- Fallback answers (model output unusable): 20/20

| Item | Result | Latency | Detail |
|---|---|---|---|
| shell-completion-origin | pass | 584 ms | introduced 3c4cacb (#1622), fallback answer |
| compat-origin | pass | 537 ms | introduced 0ed40c8, fallback answer |
| globals-origin | pass | 416 ms | introduced 695ca34 (#379), fallback answer |
| testing-origin | pass | 545 ms | introduced 3f695c6, fallback answer |
| parameter-source-origin | pass | 1.1 s | introduced af24c8d (#1329), fallback answer |
| termui-impl-origin | pass | 583 ms | introduced 64d7fcf, fallback answer |
| winconsole-origin | pass | 565 ms | introduced bcf8fec (#451), fallback answer |
| textwrap-origin | pass | 539 ms | introduced da0a164, fallback answer |
| utils-private-origin | pass | 444 ms | introduced b64ea07, fallback answer |
| editor-origin | pass | 746 ms | introduced 721e527, fallback answer |
| clirunner-origin | pass | 785 ms | introduced c265355, fallback answer |
| context-origin | pass | 1.8 s | introduced 4101de3, fallback answer |
| get-parameter-source-origin | pass | 1.2 s | introduced af24c8d (#1329), fallback answer |
| to-info-dict-origin | pass | 851 ms | introduced 4f38446 (#1623), fallback answer |
| fish-complete-origin | pass | 716 ms | introduced 3c4cacb (#1622), fallback answer |
| add-completion-class-origin | pass | 699 ms | introduced 3c4cacb (#1622), fallback answer |
| no-such-command-origin | pass | 696 ms | introduced 831c8f0 (#3228), fallback answer |
| get-pager-file-origin | pass | 763 ms | introduced c69643b (#1572), fallback answer |
| sentinel-origin | pass | 649 ms | introduced b64ea07, fallback answer |
| group-origin | pass | 1.7 s | introduced 4101de3, fallback answer |

## pallets/click: qa

- Answer accuracy (cites the expected code, all citations valid): **17/20 (85%)**
- File recall (an expected file is cited): **19/20 (95%)**
- First citation in an expected file: **13/20 (65%)**
- Citation validity: **20/20 (100%)**
- Fallback answers (model output unusable): 0/20

| Item | Result | Latency | Detail |
|---|---|---|---|
| zsh-completion | pass | 265 ms | cited src/click/shell_completion.py:448-453, src/click/shell_completion.py:278-306, src/click/shell_completion.py:466-481; 1 tool calls |
| envvar-values | pass | 277 ms | cited src/click/core.py:2868-2911, src/click/core.py:3057-3117, src/click/core.py:3772-3818; 1 tool calls |
| progress-bar | pass | 124 ms | cited src/click/termui.py:443-599, src/click/_termui_impl.py:349-380, src/click/_termui_impl.py:250-294; 1 tool calls |
| clirunner-output | pass | 283 ms | cited tests/test_testing.py:679-722, src/click/testing.py:317-359, src/click/testing.py:596-739; 1 tool calls |
| path-validation | pass | 296 ms | cited src/click/types.py:1059-1106, tests/typing/typing_path.py:1-35, tests/test_types/test_Path.py:189-190; 1 tool calls |
| open-editor | pass | 246 ms | cited src/click/termui.py:848-920, src/click/_termui_impl.py:751-796, src/click/_termui_impl.py:743-744; 1 tool calls |
| help-formatting | pass | 246 ms | cited src/click/core.py:1307-1323, src/click/formatting.py:31-107, src/click/formatting.py:110-126; 1 tool calls |
| option-parser | pass | 244 ms | cited src/click/parser.py:298-314, src/click/core.py:989-1049, src/click/core.py:2929-3015; 1 tool calls |
| help-option | pass | 228 ms | cited src/click/core.py:1222-1254, src/click/decorators.py:603-627, tests/test_commands.py:422-469; 1 tool calls |
| confirm-prompt | pass | 225 ms | cited src/click/core.py:3057-3117, src/click/termui.py:168-286, src/click/core.py:238-298; 1 tool calls |
| bash-completion | pass | 252 ms | cited src/click/shell_completion.py:395-426, src/click/shell_completion.py:389-394, src/click/shell_completion.py:278-306; 1 tool calls |
| program-name | **fail** | 230 ms | cited src/click/core.py:1515-1649, src/click/formatting.py:158-202, src/click/testing.py:596-739; 1 tool calls |
| version-option | pass | 175 ms | cited src/click/decorators.py:421-558, src/click/decorators.py:561-600, src/click/decorators.py:501-548; 1 tool calls |
| app-dir | pass | 210 ms | cited src/click/termui.py:923-949, src/click/types.py:1059-1106, src/click/utils.py:472-518; 1 tool calls |
| styling | **fail** | 305 ms | cited src/click/utils.py:240-334, src/click/termui.py:780-811, src/click/_termui_impl.py:548-632; 1 tool calls |
| pager | pass | 362 ms | cited src/click/_termui_impl.py:496-517, src/click/_termui_impl.py:383-396, tests/test_termui.py:1138-1167; 1 tool calls |
| prompt | pass | 222 ms | cited src/click/termui.py:168-286, src/click/core.py:3698-3746, src/click/core.py:3820-3874; 1 tool calls |
| bad-parameter | pass | 347 ms | cited src/click/types.py:478-490, src/click/exceptions.py:146-156, src/click/core.py:2929-3015; 1 tool calls |
| subcommand-dispatch | **fail** | 375 ms | cited src/click/core.py:1703-1761, src/click/core.py:1853-1892, src/click/core.py:1946-1989; 1 tool calls |
| int-range | pass | 310 ms | cited src/click/types.py:809-816, src/click/types.py:744-760, src/click/testing.py:231-261; 1 tool calls |

<details><summary>Why items failed</summary>

- **program-name**: no precise citation overlaps _detect_program_name
- **styling**: no precise citation overlaps style / unstyle
- **subcommand-dispatch**: no precise citation overlaps Group.resolve_command / Group.get_command

</details>

## pallets/click: bugs

- Tracing: real fix file ranked #1: **5/7 (71%)**
- Tracing: real fix file in top 3: **5/7 (71%)**
- Fixer: passing patch offered: **0/7 (0%)**
- Average trace latency: 779 ms
- Average fixer attempts: 3.0
- Average fix latency (sandbox + attempts): 53 s
- Each bug is traced against a fresh index of its pre-fix commit, so the fix is not visible to the tracer.

| Item | Result | Latency | Detail |
|---|---|---|---|
| choice-double-brackets | **fail** | 68 s | fix file not found; top suspects src/click/termui.py, src/click/types.py, src/click/utils.py; fallback report; fixer failed after 3 attempt(s) |
| short-help-abbreviation | **fail** | 78 s | fix file #4; top suspects src/click/core.py, src/click/termui.py, src/click/_textwrap.py; fallback report; fixer failed after 3 attempt(s) |
| style-black-color | **fail** | 70 s | fix file #1; top suspects src/click/termui.py, src/click/_termui_impl.py, src/click/parser.py; fallback report; fixer failed after 3 attempt(s) |
| deprecated-label-space | **fail** | 49 s | fix file #1; top suspects src/click/core.py, src/click/formatting.py, src/click/_termui_impl.py; fallback report; fixer failed after 3 attempt(s) |
| write-usage-no-args | **fail** | 52 s | fix file #1; top suspects src/click/formatting.py, src/click/core.py, src/click/utils.py; fallback report; fixer failed after 3 attempt(s) |
| hidden-prompt-error-message | **fail** | 47 s | fix file #1; top suspects src/click/termui.py, src/click/types.py, src/click/core.py; fallback report; fixer failed after 3 attempt(s) |
| version-option-import-name | **fail** | 66 s | fix file #1; top suspects src/click/decorators.py, src/click/utils.py, src/click/core.py; fallback report; fixer failed after 3 attempt(s) |

<details><summary>Why items failed</summary>

- **choice-double-brackets**: real fix file not among suspects; no passing patch: No passing patch after 3 attempts.
- **short-help-abbreviation**: real fix file ranked #4; no passing patch: No passing patch after 3 attempts.
- **style-black-color**: no passing patch: No passing patch after 3 attempts.
- **deprecated-label-space**: no passing patch: No passing patch after 3 attempts.
- **write-usage-no-args**: no passing patch: No passing patch after 3 attempts.
- **hidden-prompt-error-message**: no passing patch: No passing patch after 3 attempts.
- **version-option-import-name**: no passing patch: No passing patch after 3 attempts.

</details>

## sindresorhus/got: history

- Answer accuracy (found, cited, all citations valid): **12/12 (100%)**
- Introducing commit and PR found: **12/12 (100%)**
- Answer cites them: **12/12 (100%)**
- Citation validity (every cited SHA/PR exists): **12/12 (100%)**
- Fallback answers (model output unusable): 12/12

| Item | Result | Latency | Detail |
|---|---|---|---|
| retry-delay-origin | pass | 418 ms | introduced b15ce1d (#830), fallback answer |
| link-header-origin | pass | 419 ms | introduced 3c23eea (#1667), fallback answer |
| dns-cache-origin | pass | 560 ms | introduced bfc400b (#2463), fallback answer |
| http2-client-origin | pass | 589 ms | introduced 1e157c4 (#2464), fallback answer |
| diagnostics-channel-origin | pass | 407 ms | introduced 3e2a781, fallback answer |
| timed-out-origin | pass | 477 ms | introduced be0f17f (#501), fallback answer |
| decompress-origin | pass | 383 ms | introduced b9b6b1e (#1248), fallback answer |
| strip-url-auth-origin | pass | 322 ms | introduced 8e392f3, fallback answer |
| unix-socket-origin | pass | 320 ms | introduced 861ccd9 (#2047), fallback answer |
| weakable-map-origin | pass | 330 ms | introduced 2abacff, fallback answer |
| create-origin | pass | 453 ms | introduced b54b680 (#500), fallback answer |
| as-promise-origin | pass | 433 ms | introduced 286e31e (#1051), fallback answer |

## sindresorhus/got: qa

- Answer accuracy (cites the expected code, all citations valid): **10/15 (67%)**
- File recall (an expected file is cited): **11/15 (73%)**
- First citation in an expected file: **5/15 (33%)**
- Citation validity: **15/15 (100%)**
- Fallback answers (model output unusable): 0/15

| Item | Result | Latency | Detail |
|---|---|---|---|
| retry-delay | **fail** | 209 ms | cited source/core/index.ts:841-882, source/core/index.ts:840-889, source/core/index.ts:1769-1857; 1 tool calls |
| link-header | pass | 157 ms | cited source/core/parse-link-header.ts:40-93, source/types.ts:1-120, source/core/parse-link-header.ts:1-38; 1 tool calls |
| dns-cache | pass | 112 ms | cited source/core/utils/dns-cache.ts:93-99, source/core/utils/dns-cache.ts:118-123, source/core/utils/dns-cache.ts:78-91; 1 tool calls |
| timeouts | pass | 148 ms | cited source/core/index.ts:531-750, source/core/index.ts:1769-1857, source/core/timed-out.ts:55-234; 1 tool calls |
| decompress | **fail** | 185 ms | cited source/core/index.ts:1155-1719, source/core/options.ts:1878-1880, source/as-promise/index.ts:39-312; 1 tool calls |
| extend | pass | 143 ms | cited source/types.ts:1-120, source/create.ts:28-28, source/create.ts:46-412; 1 tool calls |
| promise-api | pass | 158 ms | cited source/as-promise/index.ts:39-312, source/as-promise/index.ts:46-252, source/as-promise/index.ts:60-75; 1 tool calls |
| redirects | **fail** | 168 ms | cited source/core/options.ts:2555-2559, source/core/options.ts:2551-2553, source/core/utils/http2-client.ts:215-239; 1 tool calls |
| errors | pass | 148 ms | cited source/core/timed-out.ts:35-39, source/core/errors.ts:212-217, source/core/index.ts:2922-2971; 1 tool calls |
| merge-options | pass | 170 ms | cited source/types.ts:1-120, source/create.ts:46-412, source/create.ts:66-164; 1 tool calls |
| http2 | **fail** | 139 ms | cited source/types.ts:1-120, source/create.ts:46-412, source/core/index.ts:1769-1857; 1 tool calls |
| progress | pass | 120 ms | cited source/types.ts:1-120, source/as-promise/index.ts:264-285, source/core/index.ts:302-312; 1 tool calls |
| diagnostics | pass | 120 ms | cited source/core/diagnostics-channel.ts:109-113, source/core/diagnostics-channel.ts:123-125, source/core/diagnostics-channel.ts:115-117; 1 tool calls |
| http-cache | pass | 148 ms | cited source/core/response.ts:182-184, source/core/index.ts:1155-1719, source/core/index.ts:2475-2484; 1 tool calls |
| cookies | **fail** | 148 ms | cited source/core/options.ts:2828-2843, source/types.ts:1-120, source/core/errors.ts:58-140; 1 tool calls |

<details><summary>Why items failed</summary>

- **retry-delay**: no precise citation overlaps calculateRetryDelay
- **decompress**: no precise citation overlaps decompressResponseBody
- **redirects**: no precise citation overlaps Request._onResponseBase
- **http2**: no precise citation overlaps Http2Agent / Http2ClientRequest / requestHttp2
- **cookies**: no precise citation overlaps Request._makeRequest.getCookieHeader

</details>

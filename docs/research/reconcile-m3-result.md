# M3 reconciliation result — AgentLens vs `ccusage` (regression gate)

Machine-readable gate: `apps/cli/test/reconcile-ccusage.test.ts`
(`./node_modules/.bin/vitest run apps/cli/test/reconcile-ccusage.test.ts`).
This file records what that gate measured on the machine that owns the corpus, so the
numbers are auditable without re-running it. De-identified: aggregates only — no prompt
content, no session ids, no paths beyond the `~/.claude/projects/**/*.jsonl` pattern.

* Window: `2026-08-22` → `2026-09-21`, UTC, both endpoints inclusive — identical to
  `docs/research/reconcile-ccusage.mjs`.
* Oracle: `docs/research/ccusage-baseline.json`
  (`ccusage@20.0.23 claude daily -j -b -O -z UTC --since 20260822 --until 20260921`).
  ccusage is **not** a dependency and is **not** invoked by the test.
* Path under test: claude-code adapter → collector `scanSource` (driven by the production
  `runScan`) → `insertEvents` (content layer OFF, §3.2/§10) → §7 cube. No framing, dedupe
  or cost logic is re-implemented in the test.
* Ingest: 93 sources (every `~/.claude/projects/**/*.jsonl` session file plus the
  `history.jsonl` index), 79,806 events, 0 parse failures, fold recorded for
  `claude-code` = `request_max` (`subagentsIncluded=true`).
* Runtime: whole file ≈ 11 s (cold scan of the store is the bulk of it).

## 1. Tokens — ZERO deviation (§15 M3 hard requirement met)

| field | AgentLens | ccusage baseline | Δ | Δ % |
|---|---:|---:|---:|---:|
| input | 17,613 | 17,613 | **0** | 0.0% |
| output | 4,178,865 | 4,178,865 | **0** | 0.0% |
| cache read | 2,022,111,976 | 2,022,111,976 | **0** | 0.0% |
| cache creation | 24,491,988 | 24,491,988 | **0** | 0.0% |
| four-bucket total | 2,050,800,442 | 2,050,800,442 (`totalTokens`) | **0** | 0.0% |

Per-day rows: the day set is identical (15 days) and all four fields are equal **for every
single day**, not just in aggregate — the check a totals-only comparison would survive.
Per-model token fields are asserted equal as well (`claude-sonnet-5`, `claude-opus-5`,
`claude-opus-4-7`, `claude-haiku-4-5-20251001`, `deepseek-flash`).

One nuance the oracle has no counterpart for: `tokens_reasoning`. The logs carry
**1,858,274** thinking tokens in this window, and Anthropic bills thinking *inside*
`output`. The gate therefore compares the four buckets above, and additionally asserts
`reasoning ≤ output` (else it is double counted) and
`tokens_total == four buckets + reasoning` (else a bucket is dropped or added twice).
Consequence for the UI/CLI: for `claude-code`, the cube's 5-bucket `tokens_total` is
0.09 % above ccusage's `totalTokens` by construction and must not be placed side by side
with it.

## 2. Cost — the anchor, and exactly why it does not match yet

| | USD |
|---|---:|
| ccusage anchor (`sum daily.totalCost`, = `totals.totalCost`) | **667.9641** |
| AgentLens `cost_api_equiv` (litellm snapshot, `request_max` fold) | **620.0226** |
| AgentLens shortfall | **−47.9415 (−7.18 %)** |
| Same tokens repriced with *our* committed snapshot (`computeCost`) | 620.0226 → Δ **$0.0000** |
| Maximum possible 1-hour-cache-write pricing gap (bound) | 48.6169 |

The delta was **not** absorbed by a wider tolerance: it was decomposed per model, and the
whole of it is one identified cause.

| model | tokens (in/out/cRead/cCreate) | AgentLens $ | ccusage $ | Δ$ | Δ$ as share of cache-creation |
|---|---|---:|---:|---:|---|
| `claude-sonnet-5` | 9,808 / 3,091,584 / 1,766,985,794 / 19,130,060 | 432.1578 | 460.2259 | +28.0681 | 97.8 % of creation tokens at the 1 h rate |
| `claude-opus-5` | 2,038 / 1,073,304 / 251,486,337 / 4,932,707 | 183.4154 | 201.9130 | +18.4977 | 100.0 % |
| `claude-opus-4-7` | 27 / 10,964 / 3,554,579 / 367,418 | 4.3479 | 5.7257 | +1.3778 | 100.0 % |
| `claude-haiku-4-5-20251001` | 26 / 2,735 / 85,266 / 61,803 | 0.0995 | 0.0995 | **+0.0000** | 0 % (all writes were 5-minute) |
| `deepseek-flash` | 5,714 / 278 / 0 / 0 | 0.0020 | 0.0000 | −0.0020 | ccusage lists it `unpriced`; litellm has it |

Reading of the table:

1. **The input / output / cache-read rates agree with ccusage.** Wherever a model's cache
   writes were all 5-minute (`claude-haiku-4-5-20251001`), AgentLens and ccusage produce
   the same cost to **<$0.0001**. That is the achievable zero-deviation and it is what the
   gate asserts (tolerance $0.01).
2. **The whole residual is the cache-write *tier*, not a rate.** litellm's
   `cache_creation_input_token_cost` is the 5-minute rate (= 1.25 × input: sonnet-5 $2.50,
   opus $6.25, haiku $1.25). ccusage reads the sub-detail
   `message.usage.cache_creation.ephemeral_1h_input_tokens` and bills those at 2 × input
   (sonnet-5 $4.00, opus $10.00). The adapter collapses every cache write into the single
   `cacheWriteTokens` column, so AgentLens prices 1-hour writes at the 5-minute rate. The
   implied 1-hour share lands inside `[0, 100 %]` of each model's creation tokens for every
   model, which is what makes that explanation arithmetic-tight rather than a story.
3. **`deepseek-flash` is the only place AgentLens is dearer**, by $0.002 (0.2 cents):
   ccusage reports it in `unpricedModels` and charges $0, litellm prices it. The gate pins
   this with a `−$0.005` floor per model so an over-price cannot grow silently.

**Source change required for the literal M3 wording (cost with ZERO deviation) — not made
here:** model the 5m/1h cache-write split. Scope: `adapters/claude-code` (keep
`cache_creation.ephemeral_{5m,1h}_input_tokens` distinct), the `events` usage columns /
`Usage` type, `packages/pricing` (a 1-hour cache-write rate), and the cube's cost buckets.
Until then the gate asserts: (a) AgentLens cost == ccusage's tokens repriced with our own
snapshot to within $0.01, and (b) `0 ≤ anchor − AgentLens cost ≤ Σ (2×input − 5mWrite) ×
cacheCreate`, per model and in total. Anything outside (b) is by construction a systematic
per-token price difference, which is the failure this gate exists to catch.

## 3. Negative control — the gate cannot pass by measuring the wrong thing

Naive per-record `SUM` over the **same ingested rows** (folded with `aggregateUsage` under
`per_record_sum`, i.e. event-model's own kernel, not a test-local sum):

| | four-bucket total | vs baseline |
|---|---:|---:|
| naive per-record SUM | 3,695,195,626 | **1.802× (+80.2 %)** |
| shipped `request_max` fold | 2,050,800,442 ≈ 2.051 B | **1.000× (0.0 %)** |

§1.5 measured +80.2 % and per-day inflation 1.65–2.62×; the test asserts the ratio lands in
`(1.5, 3)` and that the naive total is *not* the baseline total. If the corpus ever stopped
duplicating usage blocks, this control fails loudly instead of the token gate silently
becoming vacuous. The two other口径 traps stay documented in
`docs/research/reconcile-result.txt`: grouping by `message.id` instead of `requestId` loses
16.2 % of input, and taking the first block instead of the max loses 1.5 % of output
(`output_tokens` is cumulative).

## 4. Two defects this gate exposed in the shipped path (reported, not fixed)

1. **`agentlens scan` cannot detect any adapter today.** §5.1 defines
   `HostContext.dataRoot` as *the agent's* root ("e.g. `~/.claude`") and every adapter's
   `rootOf` honours that, but `apps/cli/src/context.ts::makeHostCtx` seeds it with
   `ctx.homedir`, and `runScan` calls `makeHostCtx(ctx)` before detection. Measured:
   `claude-code.detect` returns `present:false, reason:"no projects directory at
   ~/{user}/projects"`. The test works around it with the switch `paths.ts` documents as
   authoritative (`CLAUDE_CONFIG_DIR`), pointing at the same real store, so the gate still
   runs the product path. Fix belongs in `makeHostCtx`/`runScan`, not in the test.
2. **No adapter is linked into the CLI.** `getAdapters()` loads satellites through a variable
   specifier (§5.4) and `apps/cli/package.json` declares no adapter dependency, so the built
   CLI resolves an empty registry — measured on the first run: `getAdapters()` returned `[]`,
   0 sources, 0 events. Under `vitest` the alias map does resolve the packages, so the registry
   contents are build-environment dependent. The gate stubs only that lookup, in its own file,
   and says so on stderr; the stub also pins the set to `claude-code` alone, the only adapter an
   oracle for this corpus can be compared against. `detect/discover/parse/normalize/scanSource/
   insertEvents/query` all run unmocked.

## 5. Where the gate runs

Hosted CI (`pnpm test`) self-skips this file — conspicuously: the skip reason is part of the
suite name and is printed — because `~/.claude/projects` exists only on this machine. The
skip condition is: `~/.claude/projects` missing, not a directory, or not readable (plus
`~/.claude` unreadable). The reconciliation therefore belongs in a job that runs on a
machine with agent logs; on hosted CI the committed baseline above is the honest fixture.
`~/.claude` is treated strictly as read-only evidence: the scan only reads JSONL, never a
`.db`/`.sqlite` file, and the database under test lives in a temp directory that is removed
afterwards.

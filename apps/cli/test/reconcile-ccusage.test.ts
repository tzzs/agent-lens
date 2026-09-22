/**
 * M3 hard acceptance gate (docs/plan-v2.md §15 M3, §1.5, §4.4, §7, §8): the ad-hoc
 * reconciler `docs/research/reconcile-ccusage.mjs` promoted to a regression test.
 *
 * It drives the SHIPPED pipeline end to end over the REAL local corpus on this machine
 *   claude-code adapter → collector `scanSource` (through `runScan`, the only sanctioned
 *   driver) → `insertEvents` (content layer OFF, §3.2/§10) → the §7 cube
 * and compares it with the committed `ccusage claude daily -j -b -O -z UTC` oracle for
 * the window recorded in that file (UTC, both endpoints inclusive; it ends on the last
 * closed day — see the note on `BASELINE_WINDOW`). Nothing here
 * re-implements framing, dedupe or cost: a green run means the product path itself
 * reproduces ccusage.
 *
 * ccusage stays a test-only tool and never a product dependency: the oracle is the
 * committed JSON file, so this test never shells out to ccusage.
 *
 * The corpus exists on exactly one machine, so the whole file self-skips when
 * `~/.claude/projects` is absent/unreadable — conspicuously, in the suite name and on
 * stdout (see SKIP_NOTE), never silently. Hosted CI stays green; the reconciliation job,
 * the mechanised version of "users believe the numbers" (§11), runs where the logs are.
 */
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Usage } from '@agentlens/event-model'
import { aggregateUsage } from '@agentlens/event-model'
import { computeCost, type PriceEntry } from '@agentlens/pricing'
import { query } from '@agentlens/query'
import { loadAgentAggregations, migrate, openDatabase } from '@agentlens/storage'
import { FlagView } from '../src/args.ts'
import type { Ctx } from '../src/context.ts'
import { queryDeps, redactHome } from '../src/context.ts'
import { loadPricing } from '../src/pricing-store.ts'
import { runScan } from '../src/commands/scan.ts'

// Adapters ship as optional satellite packages (§5.4) and `getAdapters` loads them through a
// variable specifier, so a missing one degrades to "no adapters installed". `@agentlens/cli`
// declares no adapter dependency (apps/cli/package.json), so the built CLI resolves none of
// them — measured on the first run of this gate: `getAdapters() === []`, 0 sources, 0 events.
// The registry lookup is therefore stubbed and the SHIPPED claude-code adapter handed to
// `runScan` directly; the stub also pins the set to claude-code alone, which is what a
// single-agent oracle can be compared against deterministically. Everything downstream —
// detect, discover, parse, normalize, `scanSource`, `insertEvents`, the §7 cube — runs
// unmocked. This file is the only place adapters are installed for the CLI.
vi.mock('../src/adapters.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/adapters.ts')>()
  const adapter = await import('@agentlens/adapter-claude-code')
  console.warn(
    `[reconcile-ccusage] adapter registry stubbed for THIS FILE ONLY: ${adapter.claudeCodeAdapter?.id ?? '???'} only (see the comment above)`,
  )
  return { ...mod, getAdapters: async () => [adapter.claudeCodeAdapter] }
})

// ---- window + oracle: byte-identical to docs/research/reconcile-ccusage.mjs ----
const HOME = homedir()
const PROJECTS_DIR = join(HOME, '.claude/projects')
const BASELINE_PATH = fileURLToPath(new URL('../../../docs/research/ccusage-baseline.json', import.meta.url))

/**
 * The window is READ FROM the oracle instead of being hardcoded. ccusage is run over a
 * corpus that is still being appended to, so the snapshot must stop on the last CLOSED UTC
 * day: `until` is deliberately one day before `capturedAt`. Hardcoding a window that runs
 * to "today" made this gate fail on the next day's run for a reason that is not a bug
 * (measured: 1.61M tokens on the post-snapshot day), and a gate that fails because the
 * calendar moved gets ignored, which is worse than no gate.
 */
const BASELINE_WINDOW = (
  JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
    window: { since: string; until: string; capturedAt: string; command: string }
  }
).window
const SINCE = BASELINE_WINDOW.since
const UNTIL = BASELINE_WINDOW.until // ccusage --since/--until are UTC and inclusive
const SINCE_MS = Date.parse(`${SINCE}T00:00:00Z`)
const UNTIL_MS = Date.parse(`${UNTIL}T23:59:59.999Z`)
/** The §15 M3 cost anchor, measured on this machine. */
const ANCHOR_USD = 667.96
/** $0.01: see the tolerance rationale on the cost test. */
const COST_TOLERANCE_USD = 0.01


/** ccusage's four reported token buckets ↔ the cube's metrics ↔ our Bucket key. */
const FIELDS = [
  { cube: 'tokens_input', base: 'inputTokens', key: 'input', label: 'input' },
  { cube: 'tokens_output', base: 'outputTokens', key: 'output', label: 'output' },
  { cube: 'tokens_cache_read', base: 'cacheReadTokens', key: 'cacheRead', label: 'cacheRead' },
  { cube: 'tokens_cache_write', base: 'cacheCreationTokens', key: 'cacheCreate', label: 'cacheCreate' },
] as const
const TOKEN_METRICS = FIELDS.map((f) => f.cube)
type FieldKey = (typeof FIELDS)[number]['key']

interface Bucket {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
}
type Totals = Pick<Bucket, FieldKey>
const emptyBucket = (): Bucket => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 })
const bucketTotal = (b: Pick<Bucket, FieldKey>): number => b.input + b.output + b.cacheRead + b.cacheCreate
const fmt = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(3) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n))
const usd = (v: number | null): string => (v === null || Number.isNaN(v) ? 'n/a' : `$${v.toFixed(4)}`)

interface Baseline {
  byDay: Map<string, Bucket>
  byModel: Map<string, Bucket>
  totals: Bucket
  anchorCost: number
  totalTokens: number
}

function readBaseline(): Baseline {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
    daily: {
      date: string
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      totalCost: number
      totalTokens: number
      modelBreakdowns?: { modelName: string; cost?: number }[]
    }[]
    totals: { totalTokens: number }
  }
  const byDay = new Map<string, Bucket>()
  const byModel = new Map<string, Bucket>()
  const totals = emptyBucket()
  let anchorCost = 0
  for (const day of raw.daily) {
    const b = emptyBucket()
    for (const f of FIELDS) b[f.key] = Number((day as unknown as Record<string, number>)[f.base] ?? 0)
    b.cost = day.totalCost
    byDay.set(day.date, b)
    anchorCost += day.totalCost
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreate', 'cost'] as const) totals[k] += b[k]
    for (const m of day.modelBreakdowns ?? []) {
      const mb = byModel.get(String(m.modelName)) ?? emptyBucket()
      const src = m as unknown as Record<string, number>
      for (const f of FIELDS) mb[f.key] += Number(src[f.base] ?? 0)
      mb.cost += Number(m.cost ?? 0)
      byModel.set(String(m.modelName), mb)
    }
  }
  return { byDay, byModel, totals, anchorCost, totalTokens: raw.totals.totalTokens }
}

// ---- self-skip: the live corpus exists on exactly one machine ----
function corpusSkipReason(): string | null {
  let st
  try {
    st = statSync(PROJECTS_DIR)
  } catch {
    return `no Claude Code corpus at ~/.claude/projects`
  }
  if (!st.isDirectory()) return '~/.claude/projects is not a directory'
  try {
    accessSync(PROJECTS_DIR, constants.R_OK)
    accessSync(join(HOME, '.claude'), constants.R_OK)
  } catch {
    return '~/.claude/projects is not readable'
  }
  return null
}

const SKIP_REASON = corpusSkipReason()
/** Conspicuous, never silent: the skip reason is part of the suite name AND printed. */
const SKIP_NOTE = SKIP_REASON ? `SKIPPED — live corpus missing (${SKIP_REASON})` : `LIVE CORPUS ~/.claude/projects`
console.warn(`\n[reconcile-ccusage] M3 reconciliation gate — ${SKIP_NOTE}`)

describe.skipIf(SKIP_REASON !== null)(
  `ccusage reconciliation regression · shipped pipeline vs ccusage ${SINCE}→${UNTIL} [${SKIP_NOTE}]`,
  () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agentlens-reconcile-'))
    const dbPath = join(tmp, 'agentlens-reconcile.db')
    const db: DatabaseSync = openDatabase(dbPath)
    const cliLines: string[] = []
    let policyUsed = 'not recorded'
    let scanSummary = 'scan did not run'

    /** The product's own host context (§5.1): real fs, read-only, never a fixture. */
    function ctx(): Ctx {
      return {
        argv: ['scan'],
        out: (l) => cliLines.push(l),
        err: (l) => cliLines.push(l),
        homedir: HOME,
        // No env override: this gate must drive the same default detection a user gets
        // (`rootOf` falls back to ~/.claude, paths.ts:12), otherwise it would certify a
        // path nobody walks. `corpusSkipReason` below checks that same directory.
        env: {},
        now: () => Date.now(),
      }
    }

    function scanFlags(): FlagView {
      return new FlagView(
        { agent: ['claude-code'], 'no-content': true }, // §3.2/§10: content layer OFF
        { agent: { kind: 'repeat' }, 'no-content': { kind: 'boolean' } },
      )
    }

    beforeAll(async () => {
      migrate(db)
      const outcome = await runScan(db, scanFlags(), ctx())
      const agg = loadAgentAggregations(db)['claude-code']
      policyUsed = agg ? `${agg.mode} (subagentsIncluded=${agg.subagentsIncluded})` : 'absent → cube default request_max'
      scanSummary = `${outcome.sourcesScanned} sources · ${outcome.events} events · ${outcome.failures} parse failures`
      // A vacuous scan must never be able to "pass" a reconciliation.
      expect(outcome.adaptersFound, `claude-code not detected: ${cliLines.join('\n')}`).toBe(1)
      expect(outcome.sourcesScanned, 'no sources discovered under ~/.claude/projects').toBeGreaterThan(0)
      expect(outcome.events, 'no events ingested').toBeGreaterThan(0)
      // redactHome keeps the absolute home directory out of the log, as everywhere else (§11).
      console.warn(`[reconcile-ccusage] scanned (read-only) ${redactHome(PROJECTS_DIR, HOME)}: ${scanSummary}; fold=${policyUsed}`)
    }, 30 * 60_000)

    afterAll(() => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    })

    function cube(dims: ('day' | 'model')[]) {
      return query(
        db,
        {
          metrics: [...TOKEN_METRICS, 'tokens_reasoning', 'tokens_total', 'cost_api_equiv', 'events'],
          dims,
          filter: { since: SINCE_MS, until: UNTIL_MS },
        },
        queryDeps(db, dbPath, ctx()),
      )
    }

    function bucketOf(row: Record<string, unknown>): Bucket {
      const b = emptyBucket()
      for (const f of FIELDS) b[f.key] = Number(row[f.cube] ?? 0)
      b.cost = row.cost_api_equiv === null || row.cost_api_equiv === undefined ? Number.NaN : Number(row.cost_api_equiv)
      return b
    }

    const daysOf = (res: ReturnType<typeof cube>): Map<string, Bucket> =>
      new Map(res.rows.map((r) => [String(r.day), bucketOf(r)]))

    /** The actionable failure text §15 M3 demands: per-day table, fold used, window bounds. */
    function diagnostics(ours: Map<string, Bucket>, base: Baseline, extra = ''): string {
      const days = [...new Set([...base.byDay.keys(), ...ours.keys()])].sort()
      const head = `  ${'day'.padEnd(11)}${'lens in'.padStart(11)}${'base in'.padStart(11)}${'lens out'.padStart(11)}${'base out'.padStart(11)}${'lens cRd'.padStart(13)}${'base cRd'.padStart(13)}${'lens cWt'.padStart(12)}${'base cWt'.padStart(12)}${'Δ tokens'.padStart(14)}`
      const lines = days.map((d) => {
        const o = ours.get(d)
        const b = base.byDay.get(d)
        if (!o || !b) return `  ${d.padEnd(11)}${(o ? 'present here, absent in baseline' : 'absent here, present in baseline').padStart(52)}`
        const delta = bucketTotal(o) - bucketTotal(b)
        const dt = delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${fmt(delta)}`
        return `  ${d.padEnd(11)}${fmt(o.input).padStart(11)}${fmt(b.input).padStart(11)}${fmt(o.output).padStart(11)}${fmt(b.output).padStart(11)}${fmt(o.cacheRead).padStart(13)}${fmt(b.cacheRead).padStart(13)}${fmt(o.cacheCreate).padStart(12)}${fmt(b.cacheCreate).padStart(12)}${dt.padStart(14)}`
      })
      return [
        '',
        `--- AgentLens (${scanSummary}) vs ccusage baseline ---`,
        `window: ${SINCE}T00:00:00Z → ${UNTIL}T23:59:59.999Z (UTC, inclusive; since=${SINCE_MS} until=${UNTIL_MS})`,
        `aggregation policy recorded for claude-code: ${policyUsed}`,
        `source of truth for the basis: docs/research/reconcile-result.txt — naive +80.2%, message.id grouping loses 16.2% of input, first-not-max loses 1.5% of output`,
        head,
        ...lines,
        extra,
        '---',
      ].join('\n')
    }

    function totalsOf(map: Map<string, Bucket>): Totals {
      const t = emptyBucket()
      for (const b of map.values()) for (const k of ['input', 'output', 'cacheRead', 'cacheCreate'] as const) t[k] += b[k]
      return t
    }

    function fieldDiffMessage(label: string, got: number, want: number): string {
      return `ccusage deviation on ${label}: AgentLens ${fmt(got)} vs baseline ${fmt(want)} (Δ ${got - want === 0 ? 0 : `${got - want > 0 ? '+' : ''}${fmt(got - want)}`}, ${((got / (want || 1) - 1) * 100).toFixed(3)}%)`
    }

    it('folds claude-code with the request_max rule the gate was calibrated on (§18)', () => {
      // The cube folds per agent, so a wrong persisted policy would silently change every
      // number compared below. request_max = MAX per request_id, then SUM across groups.
      expect(policyUsed.startsWith('request_max'), `claude-code folded with ${policyUsed}, expected request_max`).toBe(true)
    })

    it('token totals match ccusage with ZERO deviation, per field', () => {
      const base = readBaseline()
      const res = cube(['day'])
      const ours = daysOf(res)
      const got = totalsOf(ours)
      const want: Totals = { input: base.totals.input, output: base.totals.output, cacheRead: base.totals.cacheRead, cacheCreate: base.totals.cacheCreate }
      for (const f of FIELDS) {
        expect(got[f.key], fieldDiffMessage(f.label, got[f.key], want[f.key]) + diagnostics(ours, base)).toBe(want[f.key])
      }
      // The cube's own per-bucket totals must agree with the grouped rows (no drift between
      // the two SQL paths) and with ccusage's reported totalTokens.
      for (const f of FIELDS) {
        expect(Number(res.totals[f.cube]), `totals.${f.cube} disagrees with the per-day rows (${got[f.key]})` + diagnostics(ours, base)).toBe(got[f.key])
      }
      expect(
        bucketTotal(got),
        fieldDiffMessage('four-bucket total', bucketTotal(got), base.totalTokens) + diagnostics(ours, base),
      ).toBe(base.totalTokens)
      // `reasoning` is an AgentLens-only bucket with no ccusage counterpart: Anthropic bills
      // thinking INSIDE output, so the four fields above are the like-for-like comparison.
      // This window measures 1,858,274 reasoning tokens (docs/research/reconcile-m3-result.md),
      // which is exactly why the cube's 5-bucket `tokens_total` must never be put next to
      // ccusage's totalTokens for claude-code. Assert the relationship, not emptiness: reasoning
      // must stay a subset of output (else it is double counted) and must be the only delta
      // between the compared buckets and `tokens_total` (else a bucket is being dropped).
      const reasoning = Number(res.totals.tokens_reasoning ?? 0)
      console.warn(
        `[reconcile-ccusage] token Δ vs ccusage: ${FIELDS.map((f) => `${f.label}=${got[f.key] - want[f.key]}`).join(' ')} ` +
          `(total ${fmt(bucketTotal(got))} over ${ours.size} days, reasoning bucket ${fmt(reasoning)} has no ccusage counterpart)`,
      )
      expect(
        reasoning,
        `reasoning tokens ${fmt(reasoning)} exceed output tokens ${fmt(got.output)}: thinking cannot be a subset of output any more, so the buckets double-count and the 4-field gate is no longer comparable with ccusage` +
          diagnostics(ours, base),
      ).toBeLessThanOrEqual(got.output)
      expect(
        Number(res.totals.tokens_total),
        `tokens_total ${fmt(Number(res.totals.tokens_total))} != the four ccusage-comparable buckets ${fmt(bucketTotal(got))} + reasoning ${fmt(reasoning)} — a token bucket is being dropped or added twice` +
          diagnostics(ours, base),
      ).toBe(bucketTotal(got) + reasoning)
    })

    it('per-day token rows match ccusage (totals-only would survive a wrong day split)', () => {
      const base = readBaseline()
      const ours = daysOf(cube(['day']))
      const baseDays = [...base.byDay.keys()].sort()
      // The window ends on the snapshot's last day, so anything outside it is excluded by the
      // filter rather than asserted about. Report the excluded growth: silently narrowing the
      // gate is how a gate stops meaning anything.
      const later = query(db, { metrics: ['tokens_total'], dims: ['day'], filter: { since: UNTIL_MS + 1 } }, queryDeps(db, dbPath, ctx()))
      if (later.rows.length > 0) {
        console.warn(
          `[reconcile-ccusage] ${later.rows.length} day(s) after ${UNTIL} are outside the oracle window and unjudged ` +
            `(${later.rows.map((r) => `${r.day}=${fmt(Number(r.tokens_total))}`).join(' ')}); ` +
            `regenerate the snapshot with \`${BASELINE_WINDOW.command}\` to cover them`,
        )
      }
      expect(
        [...baseDays.filter((d) => !ours.has(d)), ...[...ours.keys()].filter((d) => !base.byDay.has(d))].sort(),
        'the set of days differs from the baseline: a day we invented or dropped means the window bound or the timestamp→UTC-day mapping drifted' +
          diagnostics(ours, base),
      ).toEqual([])
      for (const [day, b] of base.byDay) {
        const o = ours.get(day)
        if (!o) continue // already covered by the key-set assertion
        expect(
          [o.input, o.output, o.cacheRead, o.cacheCreate, bucketTotal(o)],
          `day ${day}: AgentLens in=${fmt(o.input)} out=${fmt(o.output)} cacheRead=${fmt(o.cacheRead)} cacheCreate=${fmt(o.cacheCreate)} total=${fmt(bucketTotal(o))} vs ccusage in=${fmt(b.input)} out=${fmt(b.output)} cacheRead=${fmt(b.cacheRead)} cacheCreate=${fmt(b.cacheCreate)} total=${fmt(bucketTotal(b))}` +
            diagnostics(ours, base),
        ).toEqual([b.input, b.output, b.cacheRead, b.cacheCreate, bucketTotal(b)])
      }
    })

    it('cost matches the $667.96/30d anchor, with the only residual pinned to the 1h cache-write tier', () => {
      // TOLERANCE (and its evidence): $0.01 absolute between AgentLens' cost and "ccusage's own
      // token counts repriced with the committed litellm snapshot" — i.e. zero deviation on the
      // shipped口径 (proof it is achievable: every model whose cache writes are all 5-minute,
      // e.g. claude-haiku-4-5-20251001, matches ccusage's cost to <$0.0001). Against the raw
      // $667.96 anchor the gap is ~$48 and is NOT slack: it is pinned per model to the maximum
      // 1-hour-cache-write difference (2×input − 5mWrite) × cacheCreationTokens, because the
      // snapshot prices every cache write at the 5-minute rate while ccusage bills
      // `cache_creation.ephemeral_1h_input_tokens` at 2× input. Evidence + arithmetic:
      // docs/research/reconcile-m3-result.md. Widening this bound = a systematic price change.
      const base = readBaseline()
      const dayRes = cube(['day'])
      const modelRes = cube(['model'])
      const ours = daysOf(dayRes)
      const cost = dayRes.totals.cost_api_equiv as number | null
      const { table } = loadPricing(dbPath)
      const entryFor = (model: string): PriceEntry | null =>
        table.lookup('anthropic', model, SINCE_MS + (UNTIL_MS - SINCE_MS) / 2)
      const modelOurs = new Map<string, { bucket: Bucket; cost: number | null }>()
      for (const row of modelRes.rows) {
        modelOurs.set(String(row.model), {
          bucket: bucketOf(row),
          cost: row.cost_api_equiv === null || row.cost_api_equiv === undefined ? null : Number(row.cost_api_equiv),
        })
      }
      const modelTable = () => perModelLines(base, modelOurs, entryFor)

      expect(
        cost,
        'cost came back n/a, not a number: some model with tokens in the window has no price (§8 forbids turning a gap into $0) — ' +
          [...modelOurs.entries()]
            .filter(([, o]) => o.cost === null && bucketTotal(o.bucket) > 0)
            .map(([m, o]) => `unpriced ${m} (${fmt(bucketTotal(o.bucket))} tokens)`)
            .join('; ') + diagnostics(ours, base, modelTable()),
      ).not.toBeNull()

      // (1) like-for-like: ccusage's tokens × AgentLens' committed price table (shipped math).
      let likeForLike = 0
      for (const [model, b] of base.byModel) {
        const usage: Usage = {
          inputTokens: b.input,
          outputTokens: b.output,
          cacheReadTokens: b.cacheRead,
          cacheWriteTokens: b.cacheCreate,
          reasoningTokens: 0,
        }
        const c = computeCost(usage, entryFor(model), 'api').apiEquivalentUsd
        if (c !== null) likeForLike += c
      }
      expect(
        Math.abs((cost as number) - likeForLike),
        `AgentLens ${usd(cost)} vs the same tokens priced with our snapshot ${usd(likeForLike)}: the cube's cost arithmetic or its price table drifted` +
          diagnostics(ours, base, modelTable()),
      ).toBeLessThan(COST_TOLERANCE_USD)

      // (2) the anchor: residual ≥ 0 (we are never dearer) and ≤ the 1h-tier bound.
      const residual = base.anchorCost - (cost as number)
      let tierBound = 0
      for (const [model, b] of base.byModel) {
        const e = entryFor(model)
        if (!e) continue
        tierBound += Math.max(0, (2 * e.inputPerMTok - e.cacheWritePerMTok) * (b.cacheCreate / 1e6))
      }
      expect(
        residual,
        `AgentLens ${usd(cost)} is ABOVE the ccusage anchor ${usd(base.anchorCost)}: over-pricing can never be the cache-tier gap` +
          diagnostics(ours, base, modelTable()),
      ).toBeGreaterThanOrEqual(-COST_TOLERANCE_USD)
      expect(
        residual,
        `cost gap ${usd(residual)} exceeds the maximum possible 1-hour-cache-write pricing gap ${usd(tierBound)} — a systematic input/output/cache-read price difference is present, which is exactly what this gate exists to catch (see the per-model Δ$ column)` +
          diagnostics(ours, base, modelTable()),
      ).toBeLessThanOrEqual(tierBound + COST_TOLERANCE_USD)
      expect(Math.abs(base.anchorCost - ANCHOR_USD), `the committed baseline no longer carries the ${ANCHOR_USD} anchor`).toBeLessThan(1)
      console.warn(
        `[reconcile-ccusage] cost: AgentLens ${usd(cost)} vs same-tokens-repriced-with-our-snapshot ${usd(likeForLike)} (Δ ${usd(Math.abs((cost as number) - likeForLike))}) ` +
          `· vs anchor ${usd(base.anchorCost)} (Δ ${usd(residual)}, max 1h-cache-tier ${usd(tierBound)}) · per model lens/ccusage: ` +
          [...base.byModel.keys()].sort().map((m) => `${m}=${usd(modelOurs.get(m)?.cost ?? null)}/${usd(base.byModel.get(m)?.cost ?? 0)}`).join(' '),
      )

      // (3) per-model attribution: tokens identical per model, and each model's Δ$ inside
      // its own tier bound. A drifted rate on one model cannot hide behind another model.
      for (const [model, b] of base.byModel) {
        const o = modelOurs.get(model)
        expect(o, `model ${model} is in the baseline but the cube reports no row for it` + diagnostics(ours, base, modelTable())).toBeDefined()
        if (!o) continue
        for (const f of FIELDS) {
          expect(o.bucket[f.key], `model ${model} ${f.label}: cube ${fmt(o.bucket[f.key])} vs baseline ${fmt(b[f.key])}` + modelTable()).toBe(b[f.key])
        }
        const e = entryFor(model)
        const bound = e ? Math.max(0, (2 * e.inputPerMTok - e.cacheWritePerMTok) * (b.cacheCreate / 1e6)) : 0
        if (o.cost === null) {
          expect(b.cost, `model ${model} is unpriced by AgentLens but ccusage bills ${usd(b.cost)}` + modelTable()).toBe(0)
          continue
        }
        const d = b.cost - o.cost
        expect(
          d,
          `model ${model}: ccusage ${usd(b.cost)} − AgentLens ${usd(o.cost)} = ${usd(d)} is below −$0.005 (we charge more than ccusage for identical tokens)` + modelTable(),
        ).toBeGreaterThanOrEqual(-0.005)
        expect(
          d,
          `model ${model}: residual ${usd(d)} > its 1-hour-cache-write bound ${usd(bound)} — not explainable by the cache tier alone` + modelTable(),
        ).toBeLessThanOrEqual(bound + 0.005)
      }
      for (const [model, o] of modelOurs) {
        expect(
          base.byModel.has(model) || bucketTotal(o.bucket) === 0,
          `the cube reports ${fmt(bucketTotal(o.bucket))} tokens for ${model}, which ccusage never saw — a model the oracle did not count` + modelTable(),
        ).toBe(true)
      }
    })

    it('negative control: the naive per-record SUM over the SAME ingested rows does NOT match (it inflates)', () => {
      // §1.5 measured 1.802× (+80.2%) on this corpus. If this ever passes "by accident",
      // the token assertions above are measuring the wrong thing.
      const base = readBaseline()
      const rows = db
        .prepare(
          `SELECT id, request_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
           FROM events
           WHERE agent_id = 'claude-code' AND timestamp >= ? AND timestamp <= ?
             AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                  OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL
                  OR reasoning_tokens IS NOT NULL)`,
        )
        .all(SINCE_MS, UNTIL_MS)
        .map((raw) => {
          const r = { ...raw } as Record<string, number | string | null>
          return {
            id: String(r.id),
            agentId: 'claude-code',
            requestId: r.request_id ? String(r.request_id) : null,
            usage: {
              inputTokens: Number(r.input_tokens ?? 0),
              outputTokens: Number(r.output_tokens ?? 0),
              cacheReadTokens: Number(r.cache_read_tokens ?? 0),
              cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
              reasoningTokens: Number(r.reasoning_tokens ?? 0),
            },
          } as unknown as AgentEvent
        })
      expect(rows.length, 'no usage rows inside the window: the negative control would be vacuous').toBeGreaterThan(0)
      // Folded with event-model's own kernel under the naive policy — not a test-local SUM.
      const naive = aggregateUsage(rows, { mode: 'per_record_sum', subagentsIncluded: true })
      const naiveTotal = bucketTotal({
        input: naive.usage.inputTokens,
        output: naive.usage.outputTokens,
        cacheRead: naive.usage.cacheReadTokens,
        cacheCreate: naive.usage.cacheWriteTokens,
      })
      const ratio = naiveTotal / base.totalTokens
      const ours = daysOf(cube(['day']))
      const dayRes = cube(['day'])
      expect(
        naiveTotal,
        `naive per-record sum ${fmt(naiveTotal)} equals the baseline total ${fmt(base.totalTokens)} exactly — either the corpus stopped duplicating usage blocks or this test is summing the wrong rows; in both cases the token gate above proves nothing` +
          diagnostics(ours, base),
      ).not.toBe(base.totalTokens)
      expect(
        ratio,
        `naive/baseline = ${ratio.toFixed(3)}×; §1.5 measured 1.802× and the per-day spread was 1.65–2.62×. A ratio outside that band means the ingest changed shape — investigate before touching any threshold` +
          diagnostics(ours, base),
      ).toBeGreaterThan(1.5)
      expect(
        ratio,
        `naive/baseline = ${ratio.toFixed(3)}× is implausibly large for this corpus (measured range 1.65–2.62×)` + diagnostics(ours, base),
      ).toBeLessThan(3)
      console.warn(
        `[reconcile-ccusage] RESULT naive ${naiveTotal} vs folded ${base.totalTokens} (${ratio.toFixed(3)}×, +${((ratio - 1) * 100).toFixed(1)}%) · ` +
          `cost AgentLens ${usd(dayRes.totals.cost_api_equiv as number)} vs ccusage anchor ${usd(base.anchorCost)} (Δ ${usd(base.anchorCost - Number(dayRes.totals.cost_api_equiv))})`,
      )
    })
  },
)

/** Per-model cost/token diff: the evidence a red cost assertion must come with. */
function perModelLines(
  base: Baseline,
  ours: Map<string, { bucket: Bucket; cost: number | null }>,
  entryFor: (model: string) => PriceEntry | null,
): string {
  const head =
    `  ${'model'.padEnd(28)}${'lens in'.padStart(11)}${'base in'.padStart(11)}${'lens out'.padStart(11)}${'base out'.padStart(11)}${'lens cRd'.padStart(13)}${'base cRd'.padStart(13)}${'lens cWt'.padStart(12)}${'base cWt'.padStart(12)}${'lens $'.padStart(11)}${'base $'.padStart(11)}${'Δ$ (base−lens)'.padStart(16)}${'1h-tier ≤'.padStart(12)}`
  const rows = [...base.byModel.keys()].sort().map((model) => {
    const b = base.byModel.get(model) as Bucket
    const o = ours.get(model)
    const e = entryFor(model)
    const bound = e ? Math.max(0, (2 * e.inputPerMTok - e.cacheWritePerMTok) * (b.cacheCreate / 1e6)) : 0
    const d = o && o.cost !== null ? b.cost - o.cost : Number.NaN
    const cell = (v: number | undefined) => fmt(v ?? 0)
    return (
      `  ${model.padEnd(28)}${cell(o?.bucket.input).padStart(11)}${fmt(b.input).padStart(11)}${cell(o?.bucket.output).padStart(11)}${fmt(b.output).padStart(11)}` +
      `${cell(o?.bucket.cacheRead).padStart(13)}${fmt(b.cacheRead).padStart(13)}${cell(o?.bucket.cacheCreate).padStart(12)}${fmt(b.cacheCreate).padStart(12)}` +
      `${usd(o?.cost ?? null).padStart(11)}${usd(b.cost).padStart(11)}${(Number.isNaN(d) ? 'n/a' : d.toFixed(3)).padStart(16)}${usd(bound).padStart(12)}`
    )
  })
  return ['', '--- per model (AgentLens vs ccusage baseline) ---', head, ...rows, '---'].join('\n')
}

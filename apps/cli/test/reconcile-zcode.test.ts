/**
 * §15 M3's acceptance gate, promoted for the seventh adapter: the ad-hoc
 * `docs/research/reconcile-zcode-ccusage.mjs` as a regression test.
 *
 * It drives the SHIPPED pipeline end to end — `runScan` → the collector's WAL snapshot
 * (`snapshotsDirFor`) → `insertEvents` (content layer OFF, §3.2/§10) → the persisted
 * `aggregation_policy` → the §7 cube — and nothing here re-implements framing, folding or
 * cost. A green run means the product path, not a re-reading of it, produces the numbers.
 *
 * Two corpora, one path:
 *  - FIXTURE: a synthetic ZCode store (`adapters/zcode/fixtures/build-host.ts`) with a live
 *    WAL writer, scanned through `ZCODE_HOME` into a throwaway database. Always runs, so a
 *    hosted CI still certifies ingest → storage → cube → fold for this agent.
 *  - LIVE: this machine's real `~/.zcode`, compared field-by-field and day-by-day with the
 *    committed `ccusage zcode` oracle. Self-skips, conspicuously, when the store is absent.
 *
 * The fixture case carries its own oracle: the store's RAW column sums, read back with SQL
 * after the scan. That is what lets the test say "the mapping subtracted the cached share
 * once" rather than "the test agrees with the code" — see the negative control below.
 *
 * ccusage stays a test-only tool and never a product dependency: the oracle is the committed
 * JSON file, so this test never shells out to it.
 */
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '@agentlens/query'
import { loadAgentAggregations, migrate, openDatabase } from '@agentlens/storage'
import {
  buildHost,
  FIXTURE_MODEL_USAGE,
  modelUsageColumnTotals,
  type BuiltHost,
} from '../../../adapters/zcode/fixtures/build-host.ts'
import { FlagView } from '../src/args.ts'
import type { Ctx } from '../src/context.ts'
import { queryDeps, redactHome } from '../src/context.ts'
import { runScan, snapshotsDirFor } from '../src/commands/scan.ts'

const HOME = homedir()
const LIVE_DB = join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')
const BASELINE_PATH = fileURLToPath(new URL('../../../docs/research/ccusage-zcode-baseline.json', import.meta.url))

interface Baseline {
  window: { since: string; until: string; capturedAt: string; command: string }
  totals: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    totalTokens: number
    totalCost: number
    unpricedModels: string[]
  }
  daily: { date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }[]
  derived: { subagentTokens: { totalTokens: number }; rawColumnSums: Record<string, number> }
}
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
/**
 * The window is READ FROM the oracle, never hardcoded (same lesson as `reconcile-ccusage`):
 * ZCode's tables are append-only, so pinning the last two days the store contains keeps the
 * comparison exact while the corpus grows. A gate that fails because the calendar moved is a
 * gate that gets ignored.
 */
const SINCE_MS = Date.parse(`${BASELINE.window.since}T00:00:00Z`)
const UNTIL_MS = Date.parse(`${BASELINE.window.until}T23:59:59.999Z`)

/** ccusage's buckets ↔ the cube's metrics ↔ the baseline's keys. */
const FIELDS = [
  { cube: 'tokens_input', base: 'inputTokens' },
  { cube: 'tokens_output', base: 'outputTokens' },
  { cube: 'tokens_cache_read', base: 'cacheReadTokens' },
  { cube: 'tokens_cache_write', base: 'cacheCreationTokens' },
] as const
const TOKEN_METRICS = [...FIELDS.map((f) => f.cube), 'tokens_reasoning', 'tokens_total', 'cost_api_equiv', 'events']

const sum = (row: Record<string, unknown> | undefined): number => Number(row?.tokens_total ?? 0)

interface Scanned {
  db: DatabaseSync
  dbPath: string
  tmp: string
  events: number
  failures: number
  sources: number
  refusals: number
  adaptersFound: number
  lines: string[]
}

/** One scan, one throwaway database, the same flags a user would get. */
async function scan(env: NodeJS.ProcessEnv): Promise<Scanned> {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-zcode-reconcile-'))
  const dbPath = join(tmp, 'agentlens.db')
  const db = openDatabase(dbPath)
  migrate(db)
  const lines: string[] = []
  const ctx: Ctx = {
    argv: ['scan'],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: HOME,
    env,
    now: () => Date.now(),
    // The real store is WAL (§18 row 7), and so is the fixture's: without a snapshot dir both
    // would stay refused, which is correct behaviour but not what this gate is about.
    snapshotDir: snapshotsDirFor(dbPath),
  }
  const flags = new FlagView(
    { agent: ['zcode'], 'no-content': true },
    { agent: { kind: 'repeat' }, 'no-content': { kind: 'boolean' } },
  )
  const outcome = await runScan(db, flags, ctx)
  return {
    db,
    dbPath,
    tmp,
    events: outcome.events,
    failures: outcome.failures,
    sources: outcome.sourcesScanned,
    refusals: outcome.refusals.length,
    adaptersFound: outcome.adaptersFound,
    lines,
  }
}

function cubeOf(s: Scanned, filter: Record<string, unknown> = {}) {
  const ctx: Ctx = {
    argv: ['usage'],
    out: () => {},
    err: () => {},
    homedir: HOME,
    env: {},
    now: () => Date.now(),
  }
  return query(
    s.db,
    // The window is NOT applied by default: the fixture's seeded instants sit wherever
    // `build-host.ts` chose them, and silently filtering them out would make every total
    // below agree at zero. The live gate passes the oracle's window explicitly.
    { metrics: TOKEN_METRICS, dims: ['day'], filter },
    queryDeps(s.db, s.dbPath, ctx),
  )
}

/** The live corpus's window, from the committed oracle. */
const WINDOW = { since: SINCE_MS, until: UNTIL_MS }

function usageRows(s: Scanned): number {
  return Number(s.db.prepare(`SELECT COUNT(*) n FROM events WHERE agent_id = 'zcode' AND input_tokens IS NOT NULL`).get().n)
}

function sourceTables(s: Scanned): string[] {
  return (
    s.db.prepare(`SELECT sqlite_table FROM sources WHERE agent_id = 'zcode' ORDER BY sqlite_table`).all() as {
      sqlite_table: string | null
    }[]
  ).map((r) => String(r.sqlite_table))
}

// ------------------------------------------------------------------ fixture corpus

describe('zcode shipped-pipeline reconciliation · synthetic store (always runs)', () => {
  let host: BuiltHost
  let scanned: Scanned

  beforeAll(async () => {
    // A live WAL writer retained on purpose: a WAL fixture whose last connection closed has
    // been checkpointed and no longer tests §18 row 7 (§19's fixture lesson).
    host = await buildHost({ subdir: 'cli/db', wal: true, retainWriter: true })
    scanned = await scan({ ZCODE_HOME: host.dir })
  }, 120_000)

  afterAll(async () => {
    await host?.close()
    scanned?.db.close()
    if (scanned?.tmp) rmSync(scanned.tmp, { recursive: true, force: true })
    if (host?.dir) rmSync(host.dir, { recursive: true, force: true })
  })

  it('ingests the store through the WAL snapshot without refusing or losing rows', () => {
    expect(scanned.adaptersFound, scanned.lines.join('\n')).toBe(1)
    // snapshotDir was supplied, so the WAL store is read through a copy — not refused (§18 row 7).
    expect(scanned.refusals).toBe(0)
    expect(scanned.sources).toBe(5)
    expect(scanned.events).toBeGreaterThan(50)
    // The one seeded undecodable `part.data` blob is a counted failure, never a dropped row.
    expect(scanned.failures).toBe(1)
  })

  it('names exactly the five tables as sources, and no rollup table', () => {
    expect(sourceTables(scanned)).toEqual(['message', 'model_usage', 'part', 'session', 'tool_usage'])
    // §三: five copies of one call's tokens exist in this store. Ingesting a rollup as a sixth
    // source would double the bill, so "which tables became sources" is itself the assertion.
    for (const rollup of ['turn_usage', 'session_target', 'session_entry', 'input_history', 'todo']) {
      expect(sourceTables(scanned)).not.toContain(rollup)
    }
  })

  it('persists the declared fold and reads it back at query time (§18 row 2)', () => {
    const policy = loadAgentAggregations(scanned.db)['zcode']
    expect(policy).toEqual({ mode: 'per_record_sum', subagentsIncluded: true })
  })

  it('the cube reproduces the store once, against the store’s own raw columns', () => {
    // Independent oracle: the seeded column sums of the store, added up in plain JS by the
    // fixture builder — neither a restated constant nor a second reading of the mapping.
    const raw = modelUsageColumnTotals(FIXTURE_MODEL_USAGE)
    // §四's identity: subtracting the cached share from input leaves four buckets that re-add
    // to the store's own `computed_total`, which is `input + output` on 1395/1395 live rows.
    const correct = raw.input + raw.output
    const naive = raw.input + raw.output + raw.cacheRead + raw.cacheCreation // field-to-field copy: cache counted twice

    const totals = cubeOf(scanned).totals
    expect(Number(totals.tokens_input)).toBe(raw.input - raw.cacheRead - raw.cacheCreation)
    expect(Number(totals.tokens_cache_read)).toBe(raw.cacheRead)
    expect(Number(totals.tokens_output)).toBe(raw.output)
    expect(Number(totals.tokens_total)).toBe(correct)
    // The negative control: the wrong cache direction inflates by exactly the cached share, and
    // it is the shipped mapping that matches the store's own stated total.
    expect(naive - correct).toBe(raw.cacheRead + raw.cacheCreation)
    expect(Number(totals.tokens_total)).toBe(raw.computedTotal)
    // One usage row per model call — no duplicate carrier anywhere in the pipeline.
    expect(usageRows(scanned)).toBe(FIXTURE_MODEL_USAGE.length)
  })

  it('subagent rows are counted by default and switchable at the cube', () => {
    const withSub = sum(cubeOf(scanned).totals)
    const withoutSub = sum(
      cubeOf(scanned, { includeSubagentThreads: false }).totals,
    )
    const child = Number(
      scanned.db
        .prepare(
          `SELECT SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) n
             FROM events WHERE agent_id='zcode' AND input_tokens IS NOT NULL
               AND json_extract(metadata,'$.subagentThread') = 1`,
        )
        .get().n,
    )
    expect(child).toBeGreaterThan(0)
    expect(withSub - withoutSub).toBe(child)
  })

  it('reports no cost as measured, because the store bills by plan (§18 row 1)', () => {
    const reported = scanned.db
      .prepare(`SELECT COUNT(*) n FROM events WHERE agent_id = 'zcode' AND cost_source = 'reported'`)
      .get() as { n: number }
    expect(reported.n).toBe(0)
    // ZCode's own `cost` columns are uniformly 0 under the plan; publishing them would turn an
    // unknown into a $0. The cube must therefore report no API-equivalent cost either, since the
    // fixture's model is deliberately an unpriced name.
    expect(cubeOf(scanned).totals.cost_api_equiv ?? null).toBeNull()
  })
})

// ------------------------------------------------------------------ live corpus gate

function liveSkipReason(): string | null {
  try {
    if (!statSync(LIVE_DB).isFile()) return `${redactHome(LIVE_DB, HOME)} is not a file`
    accessSync(LIVE_DB, constants.R_OK)
    accessSync(join(HOME, '.zcode'), constants.R_OK)
  } catch {
    return `no readable ZCode store at ${redactHome(LIVE_DB, HOME)}`
  }
  return null
}

const SKIP_REASON = liveSkipReason()
console.warn(
  `\n[reconcile-zcode] ccusage gate — ${SKIP_REASON ? `SKIPPED — no live store (${SKIP_REASON})` : `LIVE CORPUS ~/.zcode (read-only, snapshotted)`}`,
)

describe.skipIf(SKIP_REASON !== null)(
  `zcode reconciliation regression · shipped pipeline vs ccusage ${BASELINE.window.since}→${BASELINE.window.until} [${
    SKIP_REASON ? 'skipped' : 'LIVE CORPUS ~/.zcode'
  }]`,
  () => {
    let scanned: Scanned

    beforeAll(async () => {
      // No env override: the gate must drive the same default detection a user gets.
      scanned = await scan({})
      expect(scanned.adaptersFound, scanned.lines.join('\n')).toBe(1)
      expect(scanned.refusals, 'the live store stayed refused; the gate proves nothing').toBe(0)
      expect(scanned.sources).toBe(5)
      expect(scanned.events).toBeGreaterThan(10_000)
      console.warn(
        `[reconcile-zcode] scanned (read-only) ${redactHome(LIVE_DB, HOME)}: ${scanned.events} events over ${scanned.sources} tables, ${scanned.failures} parse failures`,
      )
    }, 10 * 60_000)

    afterAll(() => {
      scanned?.db.close()
      if (scanned?.tmp) rmSync(scanned.tmp, { recursive: true, force: true })
    })

    it('matches ccusage on all four token buckets with ZERO deviation', () => {
      const totals = cubeOf(scanned, WINDOW).totals
      for (const f of FIELDS) {
        expect(Number(totals[f.cube]), `${f.cube} vs the ${BASELINE.window.capturedAt} oracle`).toBe(
          Number(BASELINE.totals[f.base]),
        )
      }
      expect(Number(totals.tokens_total)).toBe(BASELINE.totals.totalTokens)
    })

    it('matches per day, because totals-only would survive a wrong day split', () => {
      const rows = cubeOf(scanned, WINDOW).rows as Record<string, unknown>[]
      const ours = new Map(rows.map((r) => [String(r.day), r]))
      expect([...ours.keys()].sort()).toEqual(BASELINE.daily.map((d) => d.date).sort())
      for (const day of BASELINE.daily) {
        const row = ours.get(day.date)
        expect(row, `day ${day.date} missing`).toBeDefined()
        for (const f of FIELDS) expect(Number(row?.[f.cube])).toBe(Number(day[f.base]))
        expect(sum(row)).toBe(day.totalTokens)
      }
    })

    it('counts subagents in the headline, which is what ccusage does (−9.3% otherwise)', () => {
      const excluded = sum(cubeOf(scanned, { ...WINDOW, includeSubagentThreads: false }).totals)
      expect(sum(cubeOf(scanned, WINDOW).totals) - excluded).toBe(BASELINE.derived.subagentTokens.totalTokens)
    })

    it('leaves the plan’s $0 unpublished and the model unpriced, as the oracle does', () => {
      const reported = scanned.db
        .prepare(`SELECT COUNT(*) n FROM events WHERE agent_id = 'zcode' AND cost_source = 'reported'`)
        .get() as { n: number }
      expect(reported.n).toBe(0)
      expect(cubeOf(scanned, WINDOW).totals.cost_api_equiv ?? null).toBeNull()
      expect(BASELINE.totals.unpricedModels.length).toBeGreaterThan(0)
    })
  },
)

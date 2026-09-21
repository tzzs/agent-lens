/**
 * §14's whole claim in one file: CLI doctor and served /api/doctor read ONE identical
 * database and must not disagree about it. The two reports phrase things differently, so
 * this test compares the served JSON against the CLI's PRINTED lines (its numbers fed back
 * through `formatTokens`/`formatCount`) and against the per-agent rows deep-equal.
 *
 * The fold used to be the broken half: the server applied a single GLOBAL `request_max`
 * while the CLI read each agent's persisted policy (§18 row 2), so `last_call_sum` agents
 * lost tokens in the web report only. Every number below is synthetic; no real agent log
 * is opened.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentEvent, AggregationPolicy, Detection } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, setAgentAggregations, updateSourceProgress } from '@agentlens/storage'
import { createApp } from '@agentlens/server'
import type { Ctx } from '../src/context.ts'
import { GLYPH, formatCount, formatTokens } from '../src/render.ts'
import { measureUsageQuality, renderUsageQuality, type AgentQuality } from '../src/commands/doctor-usage.ts'
import { probeAdapters, renderGuessedTimestamps, renderParsing, renderRetention, renderSubagentLinkage } from '../src/commands/doctor.ts'

const DIR = mkdtempSync(join(tmpdir(), 'agentlens-doctor-agreement-'))
const NOW = Date.UTC(2026, 8, 21)
/** The parser version both ends are told the adapters are on right now. */
const PARSER_V = 7

function usage(input: number, output: number): AgentEvent['usage'] {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function ev(over: Partial<AgentEvent> & { id: string; agentId: string }): AgentEvent {
  return {
    schemaVersion: 1,
    hostId: over.agentId,
    sourceId: `src-${over.agentId}`,
    sessionId: `sess-${over.agentId}`,
    projectId: 'proj-1',
    timestamp: 1_700_000_000_000,
    type: 'message.assistant',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

/**
 * claude-code duplicates one request (§3.1) so a fold has work to do; codex ships per-call
 * rows under a single request id, which is exactly the shape a global fold destroys.
 */
function buildTree(db: DatabaseSync): void {
  insertEvents(db, [
    ev({ id: 'cc1', agentId: 'claude-code', requestId: 'r1', usage: usage(300, 100) }),
    ev({ id: 'cc2', agentId: 'claude-code', requestId: 'r1', usage: usage(300, 100), rawSeq: 2 }),
    ev({ id: 'cc3', agentId: 'claude-code', requestId: null, usage: usage(10, 5), usageSource: 'estimated', rawSeq: 3 }),
    ev({ id: 'cc4', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'tool.start', rawSeq: 4 }),
    ev({ id: 'cc5', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'subagent.start', parentEventId: null, rawSeq: 5 }),
    ev({ id: 'cc6', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'subagent.end', parentEventId: 'cc5', rawSeq: 6 }),
    ev({ id: 'cx1', agentId: 'codex', requestId: 'r9', usage: usage(20, 4), rawSeq: 1 }),
    ev({ id: 'cx2', agentId: 'codex', requestId: 'r9', usage: usage(30, 6), rawSeq: 2 }),
    ev({ id: 'cx3', agentId: 'codex', usage: null, usageSource: 'missing', type: 'subagent.start', parentEventId: null, rawSeq: 3 }),
    // §5.2/§19: rows whose source stated no time at all — the date is a labelled stand-in.
    ev({ id: 'cc7', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'tool.start', metadata: { timestampGuess: 'ingest-clock' }, rawSeq: 7 }),
    ev({ id: 'cc8', agentId: 'claude-code', usage: null, usageSource: 'missing', type: 'tool.start', metadata: { timestampGuess: 'file-mtime' }, rawSeq: 8 }),
    ev({ id: 'cx4', agentId: 'codex', usage: null, usageSource: 'missing', type: 'tool.start', metadata: { timestampGuess: 'ingest-clock' }, rawSeq: 4 }),
  ])
  setAgentAggregations(db, {
    'claude-code': { mode: 'request_max', subagentsIncluded: true },
    codex: { mode: 'last_call_sum', subagentsIncluded: false },
  })
  const progress = (
    id: string,
    agentId: string,
    parserVersion: number | null,
    status: 'active' | 'gone' | 'rotated',
  ): void => {
    updateSourceProgress(db, {
      id,
      agentId,
      path: join(DIR, `${id}.jsonl`),
      kind: 'jsonl',
      inode: 100 + id.length,
      size: 10,
      mtimeMs: 1,
      lastOffset: 10,
      parserVersion,
      sessionIdHint: null,
      status,
      rowsIngested: 1,
      scanStartedAt: 0,
      scanFinishedAt: 1,
      lastError: null,
    })
  }
  progress('p-cc-current', 'claude-code', PARSER_V, 'active')
  progress('p-cc-stale', 'claude-code', PARSER_V - 2, 'active')
  progress('p-cx-current', 'codex', PARSER_V, 'active')
  progress('p-cx-gone', 'codex', PARSER_V, 'gone')
}

/** detect/discover only: a doctor must never parse, and this test needs no real store. */
function fakeAdapter(opts: { id: string; aggregation: AggregationPolicy }): AgentAdapter {
  const detection: Detection = { present: false, agentVersion: null, dataRoot: DIR, reason: 'synthetic fixture' }
  return {
    id: opts.id,
    displayName: opts.id,
    parserVersion: PARSER_V,
    aggregation: opts.aggregation,
    async detect(): Promise<Detection> {
      return detection
    },
    discover(): AsyncIterable<never> {
      return { async *[Symbol.asyncIterator]() { /* nothing: not detected */ } }
    },
    parse: () => {
      throw new Error('doctor must never parse')
    },
    normalize: async () => ({ events: [] as AgentEvent[] }),
  } as unknown as AgentAdapter
}

const adapters: AgentAdapter[] = [
  fakeAdapter({ id: 'claude-code', aggregation: { mode: 'request_max', subagentsIncluded: true } }),
  fakeAdapter({ id: 'codex', aggregation: { mode: 'last_call_sum', subagentsIncluded: false } }),
]

interface RecordingCtx extends Ctx {
  outLines: string[]
}

function recordingCtx(): RecordingCtx {
  const outLines: string[] = []
  return { argv: [], homedir: DIR, env: {}, now: () => NOW, out: (l: string) => outLines.push(l), err: (l: string) => outLines.push(l), outLines }
}

const pct = (n: number, d: number): string => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1))

let db: DatabaseSync
/** Served JSON, straight from the route. */
let served: any
/** What `agl doctor` printed for the same rows and the same adapter set. */
let cli: string[]
let cliRows: AgentQuality[]

beforeAll(async () => {
  db = openDatabase(join(DIR, 'test.db'))
  migrate(db)
  buildTree(db)

  const rctx = recordingCtx()
  cliRows = measureUsageQuality(db, adapters)
  renderUsageQuality(rctx, cliRows, adapters)
  renderParsing(db, rctx, await probeAdapters(adapters, rctx, db))
  renderSubagentLinkage(db, rctx)
  renderGuessedTimestamps(db, rctx)
  renderRetention(db, rctx)
  cli = rctx.outLines

  const app = createApp({ db, now: () => NOW, adapters: async () => adapters, homedir: DIR })
  served = await (await app.request('/api/doctor')).json()
})

afterAll(() => {
  db.close()
  rmSync(DIR, { recursive: true, force: true })
})

const servedRow = (id: string): any => served.usageQuality.perAgent.find((r: { agentId: string }) => r.agentId === id)
const cliLine = (prefix: string): string => cli.find((l) => l.includes(prefix)) ?? '<missing>'

describe('agl doctor vs GET /api/doctor on one database (§14)', () => {
  it('CLI doctor and served /api/doctor fold the same database identically (§14)', () => {
    // `agrees` is the served report's own cube-vs-event-model verdict; the CLI reaches the
    // same conclusion inside `folded === modelFolded`, so strip it and compare the numbers.
    const fromServer = served.usageQuality.perAgent.map(({ agrees, ...q }: any) => q)
    expect(fromServer).toEqual(cliRows)
    expect(fromServer.map((q: any) => q.agentId)).toEqual(['claude-code', 'codex'])

    // The per-agent rule, anchored on absolute numbers so a shared bug cannot pass quietly:
    // codex's 2 per-call rows must SUM (60), and 36 is what a global request_max would have
    // printed for them.
    expect(servedRow('claude-code')).toMatchObject({ naive: 815, folded: 415, modelFolded: 415, globalFolded: 415, groups: 2, usageRows: 3 })
    expect(servedRow('codex')).toMatchObject({ naive: 60, folded: 60, modelFolded: 60, globalFolded: 36, usageRows: 2 })
    expect(served.usageQuality.naiveTokens).toBe(875)
    expect(served.usageQuality.dedupedTokens).toBe(475)
    expect(served.usageQuality.dedupedTokens).not.toBe(451)

    // Headline roll-ups are the same sums the CLI prints per agent.
    const sum = (k: keyof AgentQuality): number => cliRows.reduce((a, q) => a + Number(q[k]), 0)
    expect(served.usageQuality.reported).toBe(sum('reported'))
    expect(served.usageQuality.estimated).toBe(sum('estimated'))
    expect(served.usageQuality.missing).toBe(sum('missing'))
    expect(served.usageQuality.withoutRequestId).toBe(sum('noRequestId'))
    expect(served.usageQuality.naiveTokens).toBe(sum('naive'))
    expect(served.usageQuality.dedupedTokens).toBe(sum('folded'))
    expect(served.usageQuality.modes).toEqual(['last_call_sum', 'request_max'])
  })

  it('prints the served fold, including the no-dedup agent and the mixed-fold warning', () => {
    const cc = servedRow('claude-code')
    const cx = servedRow('codex')
    expect(cliLine('claude-code      request_id dedup active')).toContain(`raw sum ${formatTokens(cc.naive)} → ${formatTokens(cc.folded)}`)
    expect(cliLine('claude-code      request_id dedup active')).toContain(
      `${formatCount(cc.groups)} folded groups from ${formatCount(cc.usageRows)} usage rows`,
    )
    expect(cliLine(`${GLYPH.none} codex`)).toContain(`no request_id dedup: raw sum ${formatTokens(cx.naive)} = ${formatTokens(cx.folded)}`)
    expect(cliLine(`${GLYPH.none} codex`)).toContain(`${formatCount(cx.usageRows)} usage rows summed once each`)
    expect(cliLine('reported')).toContain(
      `reported ${pct(cc.reported, cc.events)}% · estimated ${pct(cc.estimated, cc.events)}% · missing ${pct(cc.missing, cc.events)}%`,
    )
    expect(cliLine('records without request_id')).toContain(`${formatCount(cc.noRequestId)} records without request_id`)
    expect(cli).toContain(
      `${GLYPH.warn} codex declares ${cx.policy.mode}: one GLOBAL request_max would have reported ` +
        `${formatTokens(cx.globalFolded)} instead of ${formatTokens(cx.folded)} (§18 row 2 — the fold is per agent)`,
    )
    expect(cli).toContain(
      `${GLYPH.warn} mixed folds in one database (${served.usageQuality.modes.join(', ')}): every total above is that agent's own fold, ` +
        'no global rule was applied and none would be correct (§18 row 2)',
    )
    expect(cli).toContain(`${GLYPH.ok} cube (SQL) and event-model folds agree on every agent`)
  })

  it('agrees on parser_version drift, subagent orphans and retention (§11 depth, §14)', () => {
    const drift = served.parsing.parserDrift
    expect(drift).toMatchObject({ checked: 4, drifted: 1, unmapped: 0, unscanned: 2, stale: [{ agentId: 'claude-code', parserVersion: 5, sources: 1 }] })
    expect(cli).toContain(
      `${GLYPH.warn} ${formatCount(drift.drifted)} of ${formatCount(drift.checked)} sources carry a stale parser_version → ` +
        'the next scan re-reads them in full (§5.3)',
    )
    expect(cli).toContain(`events ${formatCount(served.parsing.events)} · parse_errors 0 (0.0%) · unknown types 0 rows`)

    expect(served.subagents).toEqual([
      { agentId: 'claude-code', total: 2, orphan: 1, orphanPct: 50 },
      { agentId: 'codex', total: 1, orphan: 1, orphanPct: 100 },
    ])
    for (const s of served.subagents) {
      expect(cli).toContain(
        `${s.orphan === 0 ? GLYPH.ok : GLYPH.warn} ${s.agentId}: ${formatCount(s.orphan)} of ${formatCount(s.total)} subagent events ` +
          `(${pct(s.orphan, s.total)}%) have parent_event_id NULL — §4.4 row 8 links to "the nearest preceding Agent call" with no foreign key to fall back on`,
      )
    }
    expect(cli).toContain('  → their tokens and cost ARE counted; only the timeline tree placement is unknown')

    expect(served.retention).toEqual({ gone: 1, rotated: 0, active: 5 })
    const gone = served.retention.gone + served.retention.rotated
    expect(cli).toContain(
      `${GLYPH.warn} ${formatCount(gone)} known source(s) no longer readable (gone/rotated) — the events already ingested from them stay, nothing new can arrive`,
    )
    expect(cli).toContain(
      `${GLYPH.warn} ${formatCount(served.retention.active)} source(s) read to their end · ` +
        'coverage stops where upstream retention stops (§4.4 row 4)',
    )
  })

  it('agrees on the timestamps no source stated (§5.2, §19)', () => {
    expect(served.guessedTimestamps).toEqual([
      { agentId: 'claude-code', events: 8, guessed: 2, guessedPct: 25, fromIngestClock: 1, fromFileMtime: 1 },
      { agentId: 'codex', events: 4, guessed: 1, guessedPct: 25, fromIngestClock: 1, fromFileMtime: 0 },
    ])
    for (const g of served.guessedTimestamps) {
      expect(cli).toContain(
        `${GLYPH.warn} ${g.agentId}: ${formatCount(g.guessed)} of ${formatCount(g.events)} events ` +
          `(${pct(g.guessed, g.events)}%) carry a timestamp the source never stated — ` +
          `${formatCount(g.fromIngestClock)} dated by the scan clock, ${formatCount(g.fromFileMtime)} by the source file's mtime`,
      )
    }
    expect(cli).toContain('  → time-windowed numbers (`--since`, the Overview window) include these rows whatever their real date is')
  })

  it('names the same agents in both reports', () => {
    expect(served.adaptersInstalled).toBe(true)
    for (const q of cliRows) {
      expect(cliLine(q.agentId.padEnd(16))).not.toBe('<missing>')
      expect(served.agents.map((r: { id: string }) => r.id)).toContain(q.agentId)
    }
  })
})

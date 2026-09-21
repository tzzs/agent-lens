/**
 * §11 doctor sections against a SYNTHETIC, de-identified tree: every live-filesystem
 * behaviour here runs under a temp directory, never `~/.claude`. The adapters are fakes whose
 * `detect`/`discover` return paths inside that tree, which is also the proof that `doctor`
 * needs nothing but a `HostContext` to describe a store.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deriveSessionId,
  type AgentAdapter,
  type AgentEvent,
  type AggregationPolicy,
  type CapabilityCatalog,
  type Detection,
  type HostContext,
  type SourceSpec,
  type Usage,
} from '@agentlens/event-model'
import {
  insertEvents,
  migrate,
  openDatabase,
  recordParseFailure,
  setAgentAggregations,
  updateSourceProgress,
} from '@agentlens/storage'
import { writeSnapshot } from '../src/pricing-store.ts'
import type { Ctx } from '../src/context.ts'
import {
  accessOf,
  commonStoreDir,
  describeAccess,
  formatBytes,
  probeSqlite,
  readHistoryIndex,
  sessionStoreRoot,
  sqliteRefusal,
  surveySessionStore,
} from '../src/coverage.ts'
import { measureUsageQuality, renderUsageQuality, usagePolicies, type AgentQuality } from '../src/commands/doctor-usage.ts'
import { measureCapabilities, renderCapabilities } from '../src/commands/doctor-caps.ts'
import {
  doctorCtx,
  probeAdapters,
  renderAgents,
  renderCoverage,
  renderParsing,
  renderPermissions,
  renderPricing,
  renderRetention,
  renderSubagentLinkage,
  type AdapterProbe,
} from '../src/commands/doctor.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'agentlens-doctor-'))
const HOME = join(ROOT, 'home')
const CLAUDE = join(HOME, '.claude')
const PROJECTS = join(CLAUDE, 'projects')
const SESSION_A = join(PROJECTS, 'proj-alpha', 'sess-a.jsonl')
const SESSION_B = join(PROJECTS, 'proj-beta', 'nested', 'sess-b.jsonl')
const EMPTY_PROJECT = join(PROJECTS, 'proj-gamma')
const LOCKED_PROJECT = join(PROJECTS, 'proj-locked')
const HISTORY = join(CLAUDE, 'history.jsonl')
const WAL_DB = join(CLAUDE, 'state.db')
/** Root-owned CI runs ignore mode bits, so the unreadable claims are skipped there. */
const modeBitsApply = process.getuid?.() !== 0

afterAll(() => {
  if (modeBitsApply) chmodSync(LOCKED_PROJECT, 0o755)
  rmSync(ROOT, { recursive: true, force: true })
})

const SESSION_BYTES = (p: string): number => readFileSync(p).length

/** A SQLite file that never gets opened: only its 100-byte header has to be right. */
function sqliteHeader(path: string, writeFormat: number): void {
  const buf = Buffer.alloc(100)
  buf.write('SQLite format 3\0', 0, 'utf8')
  buf.writeUInt16BE(4096, 16)
  buf[18] = writeFormat
  buf[19] = writeFormat
  writeFileSync(path, buf)
}

function buildTree(): void {
  mkdirSync(join(PROJECTS, 'proj-alpha'), { recursive: true })
  mkdirSync(join(PROJECTS, 'proj-beta', 'nested'), { recursive: true })
  mkdirSync(EMPTY_PROJECT, { recursive: true })
  mkdirSync(LOCKED_PROJECT, { recursive: true })
  writeFileSync(SESSION_A, '{"type":"user","version":"9.9.9","session_id":"sess-a"}\n')
  writeFileSync(SESSION_B, '{"type":"assistant","session_id":"sess-b"}\n')
  writeFileSync(join(LOCKED_PROJECT, 'sess-locked.jsonl'), '{"type":"user"}\n')
  // §4.4 row 4: sess-a has its own file, sess-c is only named here AND ingested from this
  // index, sess-d is only named here and never ingested, and one line is not JSON (§5.3).
  writeFileSync(
    HISTORY,
    [
      JSON.stringify({ display: 'private prompt text', timestamp: 1, project: '/secret/work', sessionId: 'sess-a' }),
      JSON.stringify({ display: 'x', timestamp: 2, project: '/secret/work', sessionId: 'sess-b' }),
      JSON.stringify({ display: 'y', timestamp: 3, project: '/secret/work', sessionId: 'sess-c' }),
      JSON.stringify({ display: 'z', timestamp: 4, project: '/secret/work', sessionId: 'sess-d' }),
      '{not json',
    ].join('\n') + '\n',
  )
  sqliteHeader(WAL_DB, 2)
  if (modeBitsApply) chmodSync(LOCKED_PROJECT, 0)
}
buildTree()

/** Safety net for §18 row 7: `doctor` must not add a single entry under the data root. */
function treeListing(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      out.push(join(dir, ent.name))
      if (ent.isDirectory() && ent.name !== 'proj-locked') walk(join(dir, ent.name))
    }
  }
  walk(root)
  return out.sort()
}

interface RecordingCtx extends Ctx {
  outLines: string[]
  text(): string
}

function recordingCtx(homedir: string, env: NodeJS.ProcessEnv = {}): RecordingCtx {
  const outLines: string[] = []
  return {
    argv: [],
    homedir,
    env,
    now: () => Date.UTC(2026, 8, 21),
    out: (l: string) => outLines.push(l),
    err: (l: string) => outLines.push(l),
    outLines,
    text: () => outLines.join('\n'),
  }
}

/** The minimum an `AgentAdapter` must be for `doctor`: it lists sources, it never parses. */
function fakeAdapter(opts: {
  id: string
  detection: Detection
  sources?: SourceSpec[]
  parserVersion?: number
  aggregation?: AggregationPolicy
  capabilities?: CapabilityCatalog[]
}): AgentAdapter {
  const adapter: Partial<AgentAdapter> = {
    id: opts.id,
    displayName: opts.id,
    parserVersion: opts.parserVersion ?? 3,
    aggregation: opts.aggregation ?? { mode: 'request_max', subagentsIncluded: true },
    async detect(): Promise<Detection> {
      return opts.detection
    },
    discover(): AsyncIterable<SourceSpec> {
      const list = opts.sources ?? []
      return {
        async *[Symbol.asyncIterator]() {
          for (const s of list) yield s
        },
      }
    },
    parse: () => {
      throw new Error('doctor must never parse')
    },
    normalize: async () => ({ events: [] as AgentEvent[] }),
  }
  if (opts.capabilities) adapter.capabilities = async () => opts.capabilities ?? []
  return adapter as AgentAdapter
}

const CLAUDE_SOURCES: SourceSpec[] = [
  { id: 'src-a', path: SESSION_A, kind: 'jsonl', sessionHint: 'sess-a' },
  { id: 'src-b', path: SESSION_B, kind: 'jsonl', sessionHint: 'sess-b' },
  { id: 'src-history', path: HISTORY, kind: 'jsonl', sessionHint: null },
  { id: 'src-db', path: WAL_DB, kind: 'sqlite', sessionHint: null, sqliteTable: 'messages' },
]

const adapters: AgentAdapter[] = [
  fakeAdapter({
    id: 'claude-code',
    detection: { present: true, agentVersion: '2.1.275', dataRoot: CLAUDE },
    sources: CLAUDE_SOURCES,
    aggregation: { mode: 'request_max', subagentsIncluded: true },
    capabilities: [
      { type: 'skill', name: 'review', source: 'skills-dir' },
      { type: 'skill', name: 'commit', source: 'skills-dir' },
      { type: 'mcp', name: 'srv-local', source: 'config' },
      { type: 'mcp', name: 'srv-auth', source: 'config' },
      { type: 'mcp', name: 'srv-broken', source: 'config' },
      { type: 'hook', name: 'PreToolUse:Bash', source: 'settings' },
    ],
  }),
  fakeAdapter({
    id: 'codex',
    detection: { present: false, agentVersion: null, dataRoot: join(HOME, '.codex'), reason: 'no sessions dir' },
    aggregation: { mode: 'last_call_sum', subagentsIncluded: false },
  }),
  fakeAdapter({
    id: 'locked-agent',
    detection: { present: false, agentVersion: null, dataRoot: LOCKED_PROJECT, reason: 'unreadable store' },
    aggregation: { mode: 'per_record_sum', subagentsIncluded: true },
  }),
]

const dbPath = join(ROOT, 'agentlens.db')
const db = openDatabase(dbPath)
migrate(db)

function usage(input: number, output: number): Usage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function ev(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-a',
    sessionId: deriveSessionId('claude-code', 'sess-a'),
    projectId: 'proj-x',
    timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...overrides,
  }
}

/** 19 claude-code + 2 codex rows; usage totals are asserted digit-for-digit below. */
const events: AgentEvent[] = [
  // §3.1: claude-code duplicates usage across content blocks of one request.
  ev({ id: 'cc1', requestId: 'r1', usage: usage(1000, 100), model: { provider: 'testprovider', name: 'test-priced' } }),
  ev({ id: 'cc2', requestId: 'r1', usage: usage(1000, 100), model: { provider: 'testprovider', name: 'test-priced' } }),
  ev({ id: 'cc3', requestId: 'r1', usageSource: 'missing', type: 'tool.end', capability: { type: 'tool', name: 'Bash' }, rawSeq: 2 }),
  // No request_id at all: counted individually, never multiplied.
  ev({ id: 'cc4', requestId: null, usage: usage(500, 50), usageSource: 'estimated', type: 'message.assistant', rawSeq: 3 }),
  ev({ id: 'cc5', requestId: null, usageSource: 'missing', type: 'session.start', rawSeq: 4 }),
  // sess-b: a second host sharing the same store (§1.5).
  ev({
    id: 'cd1', requestId: 'r2', usage: usage(10, 5), hostId: 'claude-desktop', sourceId: 'src-b',
    sessionId: deriveSessionId('claude-code', 'sess-b'), rawSeq: 1,
  }),
  // sess-c: this session exists ONLY as a history.jsonl line.
  ev({
    id: 'ch1', type: 'session.start', sourceId: 'src-history', sessionId: deriveSessionId('claude-code', 'sess-c'),
    usageSource: 'missing', rawSeq: 1, rawOffset: 40,
  }),
  // Codex ships per-call rows: request_max would undercount them (§18 row 2).
  ev({ id: 'cx1', agentId: 'codex', hostId: 'codex', sourceId: 'src-cx', sessionId: deriveSessionId('codex', 'thread-1'), requestId: 'r9', usage: usage(200, 20) }),
  ev({ id: 'cx2', agentId: 'codex', hostId: 'codex', sourceId: 'src-cx', sessionId: deriveSessionId('codex', 'thread-1'), requestId: 'r9', usage: usage(300, 30), rawSeq: 2 }),
  ev({ id: 'cs1', type: 'skill.invoke', capability: { type: 'skill', name: 'review' }, usageSource: 'missing', rawSeq: 5, rawOffset: 80 }),
  ev({ id: 'ch2', type: 'hook.fire', capability: { type: 'hook', name: 'PreToolUse:Bash' }, usageSource: 'missing', rawSeq: 6, rawOffset: 120 }),
  ev({ id: 'ch3', type: 'hook.fire', capability: { type: 'hook', name: 'PostToolUse:fail' }, status: 'error', usageSource: 'missing', rawSeq: 7, rawOffset: 160 }),
  ev({ id: 'ch4', type: 'hook.fire', capability: { type: 'hook', name: 'PostToolUse:fail' }, status: 'error', usageSource: 'missing', rawSeq: 8, rawOffset: 200 }),
  ev({ id: 'cm1', type: 'mcp.invoke', capability: { type: 'mcp', name: 'srv-local' }, usageSource: 'missing', rawSeq: 9, rawOffset: 240 }),
  // §5.3: the MCP health states ride in on an unmapped attachment record.
  ev({
    id: 'cdd1', type: 'unknown', subtype: 'attachment:deferred_tools_delta', usageSource: 'missing', rawSeq: 10, rawOffset: 280,
    metadata: { needs_auth_mcp_servers: ['srv-auth'], failed_mcp_servers: ['srv-broken'], pending_mcp_servers: ['srv-wait'] },
  }),
  // §4.4 row 8: a subagent whose parent the time heuristic could not resolve.
  ev({ id: 'csub1', type: 'subagent.start', usageSource: 'missing', parentEventId: null, rawSeq: 11, rawOffset: 320 }),
  ev({ id: 'csub2', type: 'subagent.end', usageSource: 'missing', parentEventId: 'csub1', rawSeq: 12, rawOffset: 360 }),
  ev({ id: 'cz1', type: 'unknown', subtype: 'attachment:cursed_new_kind', usageSource: 'missing', rawSeq: 13, rawOffset: 400 }),
  ev({ id: 'cz2', type: 'unknown', subtype: 'attachment:cursed_new_kind', usageSource: 'missing', rawSeq: 14, rawOffset: 440 }),
]

beforeAll(() => {
  insertEvents(db, events)
  insertEvents(db, [
    ev({ id: 'cno1', requestId: 'r3', usage: usage(10, 10), model: { provider: 'testprovider', name: 'test-nooutput' }, rawSeq: 15 }),
    ev({ id: 'cno2', requestId: 'r4', usage: usage(10, 10), model: { provider: 'testprovider', name: 'test-unpriced' }, rawSeq: 16 }),
  ])
  // sess-c's only evidence is the history index; sess-a/sess-b have their own file sources.
  updateSourceProgress(db, {
    id: 'src-history', agentId: 'claude-code', path: HISTORY, kind: 'jsonl', inode: 1, size: 200, mtimeMs: 1,
    lastOffset: 200, parserVersion: 3, sessionIdHint: null, status: 'active', rowsIngested: 1, scanStartedAt: 0, scanFinishedAt: 1, lastError: null,
  })
  updateSourceProgress(db, {
    id: 'src-a', agentId: 'claude-code', path: SESSION_A, kind: 'jsonl', inode: 2, size: 50, mtimeMs: 1,
    // v2 while the adapter is at v3: the §5.3 drift signal.
    lastOffset: 50, parserVersion: 2, sessionIdHint: 'sess-a', status: 'active', rowsIngested: 16, scanStartedAt: 0, scanFinishedAt: 1, lastError: null,
  })
  updateSourceProgress(db, {
    id: 'src-b', agentId: 'claude-code', path: SESSION_B, kind: 'jsonl', inode: 3, size: 40, mtimeMs: 1,
    lastOffset: 40, parserVersion: 3, sessionIdHint: 'sess-b', status: 'active', rowsIngested: 1, scanStartedAt: 0, scanFinishedAt: 1, lastError: null,
  })
  updateSourceProgress(db, {
    id: 'src-gone', agentId: 'claude-code', path: join(EMPTY_PROJECT, 'sess-old.jsonl'), kind: 'jsonl', inode: 4, size: null, mtimeMs: null,
    lastOffset: 0, parserVersion: 3, sessionIdHint: 'sess-old', status: 'gone', rowsIngested: 0, scanStartedAt: 0, scanFinishedAt: 1, lastError: 'ENOENT',
  })
  updateSourceProgress(db, {
    id: 'src-db', agentId: 'claude-code', path: WAL_DB, kind: 'sqlite', inode: 5, size: 100, mtimeMs: 1,
    lastOffset: 0, parserVersion: 3, sessionIdHint: null, status: 'error', rowsIngested: 0, scanStartedAt: 0, scanFinishedAt: 1, lastError: 'unable to open database file',
  })
  setAgentAggregations(db, {
    'claude-code': { mode: 'request_max', subagentsIncluded: true },
    codex: { mode: 'last_call_sum', subagentsIncluded: false },
  })
  recordParseFailure(db, { reason: 'line is not JSON', rawLine: '{oops', offset: 12, rawSeq: 3, upstreamType: 'file-history-snapshot', sourceId: 'src-a', agentId: 'claude-code', path: SESSION_A })
  recordParseFailure(db, { reason: 'line is not JSON', rawLine: '{oops', offset: 13, rawSeq: 4, upstreamType: 'file-history-snapshot', sourceId: 'src-a', agentId: 'claude-code', path: SESSION_A })
  recordParseFailure(db, { reason: 'unmapped type', rawLine: '{}', offset: 14, upstreamType: 'assistant', sourceId: 'src-b', agentId: 'claude-code', path: SESSION_B })
  writeSnapshot(dbPath, {
    fetchedAt: 0,
    source: 'test-snapshot',
    entries: [
      {
        model: 'testprovider/test-priced',
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_read_input_token_cost: 3e-7,
        cache_creation_input_token_cost: 3.75e-6,
      },
      // litellm publishes no output price for it: PRICE_MISSING must read as n/a, never $0 (§8).
      { model: 'testprovider/test-nooutput', input_cost_per_token: 1e-6, output_cost_per_token: null },
    ],
  })
})

describe('read-only filesystem probes', () => {
  it('keeps readable, unreadable and absent as three different facts', () => {
    expect(accessOf(SESSION_A)).toBe('readable')
    expect(describeAccess('readable')).toBe('readable')
    expect(describeAccess('missing')).toBe('does not exist')
    expect(describeAccess('unreadable')).toBe('EXISTS but not readable')
    expect(accessOf(join(HOME, 'nope'))).toBe('missing')
    if (modeBitsApply) expect(accessOf(LOCKED_PROJECT)).toBe('unreadable')
  })

  it('surveys a session store: counts, sizes and the dirs that hold nothing', async () => {
    const survey = await surveySessionStore(PROJECTS, '.jsonl')
    expect(survey.access).toBe('readable')
    expect(survey.dirs).toBe(4)
    expect(survey.files).toBe(2)
    expect(survey.bytes).toBe(SESSION_BYTES(SESSION_A) + SESSION_BYTES(SESSION_B))
    expect(survey.emptyDirs).toContain(EMPTY_PROJECT)
    if (modeBitsApply) {
      expect(survey.unreadableDirs).toEqual([LOCKED_PROJECT])
      expect(survey.emptyDirs).toContain(LOCKED_PROJECT)
    }
  })

  it('handles a store whose sessions are not grouped in dirs at all', async () => {
    const flat = join(ROOT, 'flat-store')
    mkdirSync(flat, { recursive: true })
    writeFileSync(join(flat, 'rollout-1.jsonl'), '{}\n{}\n')
    const survey = await surveySessionStore(flat, '.jsonl')
    expect(survey).toMatchObject({ dirs: 0, files: 1, emptyDirs: [] })
    expect(commonStoreDir([join(flat, 'rollout-1.jsonl')])).toBe(flat)
    expect(commonStoreDir([])).toBeNull()
  })

  it('lifts one project dir to the store root the glob and the coverage survey need', () => {
    // One live file is enough to place the store: the common dir is the PROJECT dir, while
    // the §11 glob and §4.4 row 4's "dirs that hold nothing" are about `.../projects`.
    expect(sessionStoreRoot([SESSION_A], CLAUDE)).toBe(PROJECTS)
    expect(sessionStoreRoot([SESSION_A, SESSION_B], CLAUDE)).toBe(PROJECTS)
    expect(sessionStoreRoot([SESSION_A], `${CLAUDE}/`)).toBe(PROJECTS)
    // No data root, or a store outside it (an external worktree, §4.4 row 7): keep the common dir.
    expect(sessionStoreRoot([SESSION_A], null)).toBe(join(PROJECTS, 'proj-alpha'))
    expect(sessionStoreRoot([SESSION_A, SESSION_B], null)).toBe(PROJECTS)
    expect(sessionStoreRoot([join(ROOT, 'elsewhere', 's.jsonl')], CLAUDE)).toBe(join(ROOT, 'elsewhere'))
    expect(sessionStoreRoot([join(CLAUDE, 's.jsonl')], CLAUDE)).toBe(CLAUDE)
    expect(sessionStoreRoot([], CLAUDE)).toBeNull()
  })

  it('reads a history index for ids only and counts drifting lines', async () => {
    const index = await readHistoryIndex(HISTORY)
    expect(index.access).toBe('readable')
    expect(index.entries.map((e) => e.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-d'])
    expect(index.malformed).toBe(1)
    // `display` is the user's prompt text and `project` a user path: neither may be kept.
    const kept = JSON.stringify(index.entries)
    expect(kept).not.toContain('private prompt text')
    expect(kept).not.toContain('/secret/work')
    expect((await readHistoryIndex(join(HOME, 'missing.jsonl'))).access).toBe('missing')
  })

  it('takes WAL from the header and leaves no sidecar behind (§18 row 7)', () => {
    const before = treeListing(CLAUDE)
    const wal = probeSqlite(WAL_DB)
    expect(wal).toMatchObject({ access: 'readable', isSqlite: true, wal: true, sidecars: [] })
    expect(sqliteRefusal(wal)).toContain('§18 row 7')
    const plain = join(ROOT, 'plain.db')
    sqliteHeader(plain, 1)
    expect(probeSqlite(plain).wal).toBe(false)
    expect(sqliteRefusal(probeSqlite(plain))).toBeNull()
    writeFileSync(join(ROOT, 'not-a-db.db'), 'text text text')
    expect(sqliteRefusal(probeSqlite(join(ROOT, 'not-a-db.db')))).toContain('not a SQLite database')
    expect(sqliteRefusal(probeSqlite(join(CLAUDE, 'vanished.db')))).toContain('no longer exists')
    expect(treeListing(CLAUDE)).toEqual(before)
    expect(readdirSync(CLAUDE)).not.toContain('state.db-wal')
    expect(readdirSync(CLAUDE)).not.toContain('state.db-shm')
  })

  it('formats sizes the way §11 prints them', () => {
    expect([formatBytes(0), formatBytes(999), formatBytes(1500), formatBytes(173_000_000), formatBytes(2_500_000_000)]).toEqual([
      '0B',
      '999B',
      '2kB',
      '173MB',
      '2.5GB',
    ])
  })
})

describe('Agents', () => {
  const ctx = recordingCtx(HOME)
  let probes: AdapterProbe[] = []

  beforeAll(async () => {
    probes = await probeAdapters(adapters, ctx, db)
  })

  it('probes every adapter against the temp root, read-only', () => {
    const claude = probes.find((p) => p.adapter.id === 'claude-code')!
    expect(claude.detection?.agentVersion).toBe('2.1.275')
    expect(claude.files).toHaveLength(2)
    expect(claude.bytes).toBe(SESSION_BYTES(SESSION_A) + SESSION_BYTES(SESSION_B))
    expect(claude.vanished).toEqual([])
    expect(claude.storeDir).toBe(PROJECTS)
    expect(claude.ext).toBe('.jsonl')
    expect(claude.historyFile).toBe(HISTORY)
    expect(claude.survey?.files).toBe(2)
    expect(claude.events).toBe(19)
    expect(claude.sqlite).toHaveLength(1)
    expect(claude.sqlite[0]!.refusal).toContain('WAL')
    expect(probes.find((p) => p.adapter.id === 'codex')!.detection?.present).toBe(false)
  })

  it('honours the AGENTLENS_AGENT_ROOT override and ignores a relative value', () => {
    expect(doctorCtx(recordingCtx(HOME, { AGENTLENS_AGENT_ROOT: '/tmp/other' })).homedir).toBe('/tmp/other')
    expect(doctorCtx(recordingCtx(HOME, { AGENTLENS_AGENT_ROOT: 'relative' })).homedir).toBe(HOME)
    expect(doctorCtx(recordingCtx(HOME, {})).homedir).toBe(HOME)
  })

  it('prints version, source glob and file counts, and splits hosts sharing one store', async () => {
    const out = recordingCtx(HOME)
    renderAgents(db, out, probes)
    const text = out.text()
    // A refused SQLite source and an errored source row must cost this agent its ✓ (§11).
    expect(text).toMatch(/! claude-code +v2\.1\.275/)
    expect(text).toContain('~/.claude/projects/**/*.jsonl')
    expect(text).toContain('2 files /')
    expect(text).toContain('same store, entrypoint=claude-desktop')
    expect(text).toContain('1 sessions / 1 sources / 1 events')
    expect(text).toContain('− codex')
    expect(text).toContain('not detected — no sessions dir')
    // A WAL store is reported as refused, never opened (§18 row 7).
    expect(text).toContain('SQLite source(s) sniffed by header, none opened')
    expect(text).toContain('refused: WAL mode')
    expect(text).toContain('source(s) recorded status=error: unable to open database file')

    const clean = recordingCtx(HOME)
    const cleanProbes = await probeAdapters(
      [
        fakeAdapter({
          id: 'workbuddy',
          detection: { present: true, agentVersion: '2.1.275', dataRoot: CLAUDE },
          sources: [CLAUDE_SOURCES[0]!, CLAUDE_SOURCES[1]!],
        }),
      ],
      clean,
      db,
    )
    renderAgents(db, clean, cleanProbes)
    expect(clean.text()).toMatch(/✓ workbuddy +v2\.1\.275/)
    expect(clean.text()).not.toContain('WAL')
  })

  it('names an ingested agent whose adapter package is not installed', () => {
    const all = recordingCtx(HOME)
    renderAgents(db, all, probes)
    expect(all.text()).not.toContain('adapter package is not installed')
    const partial = recordingCtx(HOME)
    renderAgents(db, partial, [probes[0]!])
    expect(partial.text()).toContain('codex')
    expect(partial.text()).toContain('adapter package is not installed')
    const none = recordingCtx(HOME)
    renderAgents(db, none, [])
    expect(none.text()).toContain('no adapters installed')
  })
})

describe('Parsing', () => {
  it('reports event/parse_error counts, the top unknown types and parser_version drift', async () => {
    const out = recordingCtx(HOME)
    const probes = await probeAdapters(adapters, out, db)
    renderParsing(db, out, probes)
    const text = out.text()
    expect(text).toContain('events 21 · parse_errors 3 (12.5%)')
    expect(text).toContain('unknown types 3 rows')
    expect(text).toContain('top unknown record types: attachment:cursed_new_kind 2 · attachment:deferred_tools_delta 1')
    expect(text).toContain('top parse_errors: line is not JSON 2 · unmapped type 1')
    expect(text).toContain('1 of 5 sources carry a stale parser_version')
    expect(text).toContain('§5.3')
  })

  it('says so when the build cannot map a source to an adapter', () => {
    const out = recordingCtx(HOME)
    renderParsing(db, out, [])
    const text = out.text()
    expect(text).toContain('parser_version drift cannot be evaluated')
    expect(text).toContain('5 source(s) belong to agents with no adapter here, 1 carry no version yet')
  })
})

describe('Coverage', () => {
  it('names dirs that exist but hold no session files, then the history gap', async () => {
    const out = recordingCtx(HOME)
    const probes = await probeAdapters(adapters, out, db)
    await renderCoverage(db, out, probes)
    const text = out.text()
    expect(text).toContain('Coverage')
    expect(text).toContain('of 4 session dirs under ~/.claude/projects exist but contain no session files (upstream retention, §4.4 row 4)')
    expect(text).toContain('→ history is incomplete')
    if (modeBitsApply) expect(text).toContain('of those dirs exist but are not readable (locked?)')
    expect(text).toContain('4 sessions named in ~/.claude/history.jsonl')
    expect(text).toContain('2 known only from history.jsonl')
    expect(text).toContain('1 of them never ingested at all')
    expect(text).toContain('1 unreadable index lines (§5.3 drift)')
    expect(text).not.toContain('private prompt text')
    expect(text).not.toContain('/secret/work')
    renderRetention(db, out)
    expect(out.text()).toContain('1 known source(s) no longer readable (gone/rotated)')
    expect(out.text()).toContain('4 source(s) read to their end')
    expect(out.text()).toContain('coverage stops where upstream retention stops (§4.4 row 4)')
  })

  it('refuses to claim completeness for an unreadable or absent store', async () => {
    const out = recordingCtx(HOME)
    const [ghost] = await probeAdapters(
      [fakeAdapter({ id: 'ghost', detection: { present: true, agentVersion: null, dataRoot: join(HOME, 'gone') } })],
      out,
      db,
    )
    const [locked] = await probeAdapters(
      [fakeAdapter({ id: 'qoder', detection: { present: true, agentVersion: '1.0', dataRoot: LOCKED_PROJECT } })],
      out,
      db,
    )
    // The probe for a store nobody can list: same survey the command would run if it could
    // resolve the root, forced onto the locked directory.
    const lockedProbe: AdapterProbe = {
      ...locked,
      storeDir: LOCKED_PROJECT,
      survey: await surveySessionStore(LOCKED_PROJECT, '.jsonl'),
    }
    await renderCoverage(db, out, [ghost!, lockedProbe])
    const text = out.text()
    expect(text).toContain('no session store located')
    if (modeBitsApply) {
      expect(text).toContain('✗ qoder: ~/.claude/projects/proj-locked EXISTS but not readable — coverage of it is unknown')
    }
  })

  it('reports the subagent parent-link orphan rate', () => {
    const out = recordingCtx(HOME)
    renderSubagentLinkage(db, out)
    expect(out.text()).toContain('1 of 2 subagent events (50.0%) have parent_event_id NULL')
    expect(out.text()).toContain('their tokens and cost ARE counted')
  })
})

describe('Usage quality', () => {
  const out = recordingCtx(HOME)
  let qualities: AgentQuality[] = []

  beforeAll(() => {
    qualities = measureUsageQuality(db, adapters)
    renderUsageQuality(out, qualities, adapters)
  })

  it('reads the fold back from the stored rows, the way queryDeps does', () => {
    const { persisted, declared } = usagePolicies(db, adapters)
    expect(persisted['claude-code']).toEqual({ mode: 'request_max', subagentsIncluded: true })
    expect(persisted.codex).toEqual({ mode: 'last_call_sum', subagentsIncluded: false })
    expect(persisted['locked-agent']).toBeUndefined()
    expect(declared['claude-code']).toEqual({ mode: 'request_max', subagentsIncluded: true })
    expect(declared.codex).toEqual({ mode: 'last_call_sum', subagentsIncluded: false })
  })

  it('splits reported / estimated / missing per agent and counts request_id-less rows', () => {
    const claude = qualities.find((q) => q.agentId === 'claude-code')!
    expect(claude.events).toBe(19)
    expect(claude.reported).toBe(5)
    expect(claude.estimated).toBe(1)
    expect(claude.missing).toBe(13)
    expect(claude.noRequestId).toBe(13)
    expect(claude.noRequestIdWithUsage).toBe(1)
    const text = out.text()
    expect(text).toContain('reported 26.3% · estimated 5.3% · missing 68.4%')
    expect(text).toContain('(13 records without request_id, counted individually, 1 of them carrying usage)')
  })

  it('shows inflation actually avoided and labels the fold that produced it', () => {
    const claude = qualities.find((q) => q.agentId === 'claude-code')!
    // naive 1100+1100+550+15+20+20; folded: r1 -> 1100, cc4 -> 550, r2/r3/r4 -> 15/20/20.
    expect(claude.naive).toBe(2805)
    expect(claude.folded).toBe(1705)
    expect(claude.modelFolded).toBe(claude.folded)
    expect(claude.groups).toBe(5)
    const text = out.text()
    expect(text).toContain('request_id dedup active')
    expect(text).toContain('raw sum 2.8k → 1.7k (-39.2% inflation avoided)')
    expect(text).toContain('5 folded groups from 6 usage rows')
    expect(text).toContain('fold request_max · subagents counted (persisted with the stored rows, read back at query time (§18 row 2))')
  })

  it('applies each agent\'s own fold instead of a global rule', () => {
    const codex = qualities.find((q) => q.agentId === 'codex')!
    expect(codex.policy.mode).toBe('last_call_sum')
    expect(codex.naive).toBe(550)
    expect(codex.folded).toBe(550)
    expect(codex.globalFolded).toBe(330)
    const text = out.text()
    expect(text).toContain('no request_id dedup: raw sum 550 = 550 · 2 usage rows summed once each')
    expect(text).toContain('fold last_call_sum · subagents excluded')
    expect(text).toContain('one GLOBAL request_max would have reported 330 instead of 550')
    expect(text).toContain('mixed folds in one database (last_call_sum, request_max)')
    expect(text).toContain('✓ cube (SQL) and event-model folds agree on every agent')
  })

  it('flags a fold that disagrees with event-model rather than shipping either number', () => {
    const out2 = recordingCtx(HOME)
    const claude = qualities.find((q) => q.agentId === 'claude-code')!
    renderUsageQuality(out2, [{ ...claude, modelFolded: 10, declared: null }], [])
    const text = out2.text()
    expect(text).toContain('✗ claude-code cube and event-model disagree (1.7k vs 10)')
    expect(text).toContain('every token and cost number for this agent is untrustworthy')
    expect(text).toContain('its installed adapter declares no aggregation policy')
    expect(text).not.toContain('agree on every agent')
  })

  it('separates the persisted policy from the one the adapter now declares', () => {
    const out2 = recordingCtx(HOME)
    const claude = qualities.find((q) => q.agentId === 'claude-code')!
    renderUsageQuality(out2, [{ ...claude, policy: { mode: 'per_record_sum', subagentsIncluded: true }, folded: claude.naive, modelFolded: claude.naive }], adapters)
    expect(out2.text()).toContain('its adapter now declares request_max but the stored rows are folded per_record_sum')
  })

  it('says nothing can be quality-checked on an empty database', () => {
    const empty = openDatabase(join(ROOT, 'empty.db'))
    migrate(empty)
    const out2 = recordingCtx(HOME)
    renderUsageQuality(out2, measureUsageQuality(empty, []), [])
    expect(out2.text()).toContain('− no events ingested — nothing to quality-check')
    empty.close()
  })
})

describe('Capabilities', () => {
  it('contrasts the installed catalog with what was invoked', async () => {
    const hosts = new Map<string, HostContext>([
      ['claude-code', {} as HostContext],
      ['broken-caps', {} as HostContext],
    ])
    const report = await measureCapabilities(
      [adapters[0]!, fakeAdapter({ id: 'broken-caps', detection: { present: true, dataRoot: CLAUDE }, capabilities: [] })],
      hosts,
      db,
    )
    const out = recordingCtx(HOME)
    renderCapabilities(out, report)
    const text = out.text()
    expect(text).toMatch(/skills\s+installed 2 · invoked 1/)
    expect(text).toMatch(/tools\s+installed 0 · invoked 1/)
    expect(text).toMatch(/hooks\s+fired 3 · failures 2 \(PostToolUse:fail\)/)
    expect(text).toMatch(/mcp\s+1 attached, 1 needs-auth, 1 failed · 1 pending/)
    expect(text).toContain('← deferred_tools_delta')
  })

  it('admits when no adapter exposes a catalog at all', async () => {
    const report = await measureCapabilities([adapters[1]!], new Map(), db)
    const out = recordingCtx(HOME)
    renderCapabilities(out, report)
    const text = out.text()
    expect(text).toContain('no adapter exposes capabilities()')
    expect(text).toMatch(/mcp\s+installed \? · invoked 1/)
    expect(text).toMatch(/hooks\s+fired 3 · failures 2/)
    expect(text).toContain('1 attached, 1 needs-auth, 1 failed')
  })

  it('says a state is unobservable instead of printing zeros (§18 row 5)', () => {
    const out = recordingCtx(HOME)
    renderCapabilities(out, {
      installed: new Map(),
      invoked: new Map([['mcp', 1] as const]),
      catalogs: 0,
      catalogErrors: [],
      hookFires: 0,
      hookFailures: 0,
      topFailingHook: null,
      mcp: { attached: ['srv-a'], needsAuth: [], failed: [], pending: [], observed: false },
    })
    const text = out.text()
    expect(text).toContain('attached 1')
    expect(text).toContain('needs-auth / failed not exposed by any adapter catalog')
    expect(text).toContain('no installed agent logs hook events (§18 row 5)')
    expect(text).not.toContain('0 needs-auth, 0 failed')
    const nothing = recordingCtx(HOME)
    renderCapabilities(nothing, {
      installed: new Map(),
      invoked: new Map(),
      catalogs: 0,
      catalogErrors: [],
      hookFires: 0,
      hookFailures: 0,
      topFailingHook: null,
      mcp: { attached: [], needsAuth: [], failed: [], pending: [], observed: false },
    })
    expect(nothing.text()).toContain('no adapter exposes a capability catalog and no capability events are ingested')
  })

  it('surfaces a catalog that threw instead of reporting zero installed', async () => {
    const thrower = fakeAdapter({ id: 'claude-code', detection: { present: true, dataRoot: CLAUDE } })
    thrower.capabilities = async () => {
      throw new Error('EACCES skills dir')
    }
    const report = await measureCapabilities([thrower], new Map([['claude-code', {} as HostContext]]), db)
    const out = recordingCtx(HOME)
    renderCapabilities(out, report)
    expect(out.text()).toContain('! catalog claude-code: EACCES skills dir')
    expect(out.text()).toContain('installed ?')
    expect(report.catalogs).toBe(0)
    expect(report.catalogErrors).toHaveLength(1)
  })
})

describe('Pricing', () => {
  it('reports a missing price as n/a and never as $0 (§8)', () => {
    const out = recordingCtx(HOME)
    renderPricing(db, out, dbPath)
    const text = out.text()
    expect(text).toContain('✓ 2 models priced (source: updated snapshot)')
    expect(text).toContain('! 2 of 3 ingested models unpriced → cost = "n/a", never $0')
    expect(text).toContain('test-unpriced')
    expect(text).toContain('price entry')
    expect(text).toContain('test-nooutput')
    expect(text).toContain('output')
    expect(text).toContain('n/a')
    expect(text).not.toContain('$0.')
    expect(text).toContain('no agent reported a cost for any event')
  })

  it('says so when nothing has been ingested to price', () => {
    const emptyPath = join(ROOT, 'empty2.db')
    const empty = openDatabase(emptyPath)
    migrate(empty)
    const out = recordingCtx(HOME)
    renderPricing(empty, out, emptyPath)
    expect(out.text()).toContain('no models ingested yet')
    empty.close()
  })
})

describe('Permissions', () => {
  it('keeps readable / unreadable / does-not-exist apart and proves nothing was opened', async () => {
    const before = treeListing(CLAUDE)
    const out = recordingCtx(HOME)
    const probes = await probeAdapters(adapters, out, db)
    renderPermissions(out, probes)
    const text = out.text()
    expect(text).toContain('✓ ~/.claude ')
    expect(text).toContain('~/.claude/projects ')
    expect(text).toContain('~/.claude/history.jsonl ')
    expect(text).toContain('~/.codex')
    expect(text).toContain('does not exist')
    if (modeBitsApply) {
      expect(text).toContain('✗')
      expect(text).toContain('EXISTS but not readable')
    }
    expect(text).toContain('not read: WAL mode')
    expect(text).toContain('inspected as a 100-byte header only — nothing opened, no sidecar written (§18 row 7)')
    expect(treeListing(CLAUDE)).toEqual(before)
  })
})

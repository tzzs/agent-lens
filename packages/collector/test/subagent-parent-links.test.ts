/**
 * §4.4 row 8 end-to-end: a Claude Code side chain gets its spawn's event id even though the
 * two transcripts are different files, and the answer does not depend on which file the scan
 * reached first.
 *
 * The transcripts below are SYNTHETIC, authored for this test (record shapes from
 * `adapters/claude-code/fixtures/agent-subagent-*.jsonl`, the same shapes
 * `docs/research/probe-subagent-parents.mjs` measures): the parent file holds the `Agent`
 * `tool_use` records and the closing `tool_result` that carries `toolUseResult.agentId`; the
 * side chain lives at `<session>/subagents/agent-<agentId>.jsonl` and carries `isSidechain` +
 * `agentId` with the same `sessionId`.
 *
 * The linking itself is `packages/storage/src/subagent-parent-links.ts`: it runs AFTER
 * ingestion, over rows already in the store, because the adapter's candidate ledger is per
 * source (`stateFor(ctx.source.id)`) and so never sees the parent file's spawns.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  deriveProjectId,
  projectRootForCwd,
  type AgentEvent,
  type HostContext,
  type SourceSpec,
} from '@agentlens/event-model'
import claudeCodeAdapter, { forgetState } from '@agentlens/adapter-claude-code'
import {
  dumpTable,
  insertEvents,
  migrate,
  openDatabase,
  updateSourceProgress,
  type SourceProgress,
} from '@agentlens/storage'
import { scanSource, type EventSink, type SavedSourceState, type SourceCommit } from '../src/orchestrator.ts'
import {
  pickNearestPrecedingSpawn,
  planSubagentParentLinks,
  resolveSubagentParent,
  resolveSubagentParents,
  type SubagentSpawnCandidate,
} from '../../storage/src/subagent-parent-links.ts'

// ---------------------------------------------------------------- the transcripts

const SESSION = 'sess-sidechain-e2e'
const CHAIN = 'agent-sidechain-e2e-1'
const CWD = '/fixture/sidechain-project'
const T0 = 1_760_000_000_000
/** Seconds after `T0`, so the parent/child ordering is readable in the fixture itself. */
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

const jsonl = (...records: object[]): string => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

const envelope = (type: string, seconds: number, uuid: string) => ({
  type,
  sessionId: SESSION,
  uuid,
  timestamp: at(seconds),
  cwd: CWD,
  entrypoint: 'cli',
  version: '2.1.99-synthetic',
  gitBranch: 'synthetic',
})

const userTurn = (seconds: number, uuid: string, text: string) => ({
  ...envelope('user', seconds, uuid),
  message: { role: 'user', content: text },
})

/**
 * The spawn: an `Agent` `tool_use`. `fromAssistantBlock` maps it to a `tool.start` with
 * `capability.type = 'subagent'` and `metadata.tool_use_id` — the row the linker treats as a
 * candidate parent.
 */
const agentSpawn = (seconds: number, uuid: string, toolUseId: string, subagentType: string) => ({
  ...envelope('assistant', seconds, uuid),
  requestId: `req-${toolUseId}`,
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: 'synthetic', prompt: 'read the repository', subagent_type: subagentType },
      },
    ],
  },
})

/**
 * The spawn's closing `tool_result`: `tool_use_id` names the call and `toolUseResult.agentId`
 * names the chain it started — the one real foreign key in this format. `sidechainClose`
 * writes it as a `subagent.end` row whose `metadata.linked_parent` is the spawn's event id.
 */
const spawnResult = (seconds: number, uuid: string, toolUseId: string, proves: boolean) => ({
  ...envelope('user', seconds, uuid),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'synthetic result text' }],
  },
  ...(proves ? { toolUseResult: { agentId: CHAIN, totalDurationMs: 4000, totalTokens: 120 } } : {}),
})

/** One record of the side chain: the same `sessionId`, plus the two chain markers. */
const chainRecord = (type: 'user' | 'assistant', seconds: number, uuid: string, body: object) => ({
  ...envelope(type, seconds, uuid),
  isSidechain: true,
  agentId: CHAIN,
  ...body,
})

/**
 * Two spawns, and the side chain starts AFTER the second one — so the nearest preceding spawn
 * (`toolu_late`) and the proven parent (`toolu_early`) disagree, and the fixture can tell which
 * rule decided.
 *
 * `proves: false` drops the `toolUseResult` (a spawn still running, or interrupted): no proof
 * exists at all, and only the heuristic can decide.
 */
const parentTranscript = (proves: boolean): string =>
  proves
    ? jsonl(
        userTurn(0, 'p1', 'synthetic: delegate two investigations'),
        agentSpawn(10, 'p2', 'toolu_early', 'Explore'),
        agentSpawn(30, 'p3', 'toolu_late', 'general-purpose'),
        spawnResult(40, 'p4', 'toolu_early', true),
      )
    : jsonl(
        userTurn(0, 'p1', 'synthetic: delegate two investigations'),
        agentSpawn(10, 'p2', 'toolu_early', 'Explore'),
        agentSpawn(30, 'p3', 'toolu_late', 'general-purpose'),
        spawnResult(40, 'p4', 'toolu_late', false),
      )

/** The side chain's own file: its first record is at t=35s, i.e. after both spawns. */
const sidechainTranscript = (): string =>
  jsonl(
    chainRecord('user', 35, 'c1', { message: { role: 'user', content: 'synthetic subtask' } }),
    chainRecord('assistant', 36, 'c2', {
      requestId: 'req-chain-1',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'synthetic subagent answer' }],
      },
    }),
  )

// ---------------------------------------------------------------- the scan harness
// Mirrors `apps/cli/src/commands/scan.ts::runScan` — discover → scanSource per source, with
// `insertEvents` as the sink and `updateSourceProgress` on commit — and adds the one call the
// CLI does not make yet: the post-ingestion link pass.

const dirs: string[] = []
const scannedSourceIds = new Set<string>()
afterEach(async () => {
  // The adapter's ledger is keyed by source id, which is a digest of the ABSOLUTE path, so a
  // fresh temp tree cannot collide with a previous case; this only keeps process state clean
  // for the cases that scan one tree twice. The linker never reads adapter state — that is
  // the point — so no assertion here depends on it.
  for (const id of scannedSourceIds) forgetState(id)
  scannedSourceIds.clear()
  for (const d of dirs) await rm(d, { recursive: true, force: true })
  dirs.length = 0
})

/** `<root>/projects/<project>/<session>.jsonl` + `<session>/subagents/agent-<id>.jsonl`. */
async function makeTree(parent: string, sidechain: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'collector-sidechain-'))
  dirs.push(root)
  const projectDir = join(root, 'projects', '-fixture-sidechain-project')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, `${SESSION}.jsonl`), parent)
  const subagents = join(projectDir, SESSION, 'subagents')
  await mkdir(subagents, { recursive: true })
  await writeFile(join(subagents, `${CHAIN}.jsonl`), sidechain)
  return root
}

function hostCtx(root: string): HostContext {
  return {
    dataRoot: root,
    homedir: root,
    env: {},
    async readFile(path) {
      return readFile(path, 'utf8')
    },
    async readDir(path) {
      return readdir(path)
    },
    async stat(path) {
      try {
        const s = await stat(path)
        return { size: s.size, mtimeMs: s.mtimeMs, inode: s.ino }
      } catch {
        return null
      }
    },
  }
}

function savedState(db: ReturnType<typeof openDatabase>, sourceId: string, replay: boolean): SavedSourceState {
  if (replay) {
    // No stored position: the whole file is re-read from byte 0 with `firstSeq` 1, which is
    // §4.2's "same bytes again" case.
    return {
      lastOffset: 0,
      inode: 0,
      size: 0,
      mtimeMs: 0,
      parserVersion: claudeCodeAdapter.parserVersion,
      linesConsumed: 0,
      seen: true,
    }
  }
  const row = db
    .prepare('SELECT last_offset, inode, size, mtime_ms, parser_version, rows_ingested FROM sources WHERE id = ?')
    .get(sourceId) as Record<string, unknown> | undefined
  return {
    lastOffset: Number(row?.last_offset ?? 0),
    inode: Number(row?.inode ?? 0),
    size: Number(row?.size ?? 0),
    mtimeMs: Number(row?.mtime_ms ?? 0),
    parserVersion: Number(row?.parser_version ?? 0),
    linesConsumed: Number(row?.rows_ingested ?? 0),
    seen: row !== undefined,
  }
}

function makeSink(db: ReturnType<typeof openDatabase>, source: SourceSpec): EventSink {
  return {
    writeEvents: (events) => {
      // Content on: the write-back must survive a row that carries `content_ref` (§3.2).
      insertEvents(db, events, { contentEnabled: true })
    },
    writeParseFailure: () => {},
    commitSource: (p: SourceCommit) => {
      const prev = db.prepare('SELECT rows_ingested FROM sources WHERE id = ?').get(p.id) as
        | { rows_ingested: number | null }
        | undefined
      const progress: SourceProgress = {
        id: p.id,
        agentId: claudeCodeAdapter.id,
        path: p.path,
        kind: source.kind,
        inode: p.inode,
        size: p.size,
        mtimeMs: p.mtimeMs,
        lastOffset: p.lastOffset,
        parserVersion: p.parserVersion,
        sessionIdHint: source.sessionHint ?? null,
        sqliteTable: null,
        status: p.status,
        rowsIngested: (prev?.rows_ingested ?? 0) + p.rowsIngested,
        scanStartedAt: p.scanStartedAt,
        scanFinishedAt: p.scanFinishedAt,
        lastError: p.lastError,
      }
      updateSourceProgress(db, progress)
    },
  }
}

interface ScanOpts {
  /** Reverse the discover order, so the side chain file is ingested before its parent file. */
  reverse?: boolean
  /** Forget every stored position, so each source replays its whole file (§4.2). */
  replay?: boolean
  /** Skip the side chain source: the spawn is not in the store at all yet. */
  sidechainOnly?: boolean
  /** Skip the side chain source: only the spawn rows land. */
  parentOnly?: boolean
}

async function scanTree(db: ReturnType<typeof openDatabase>, root: string, opts: ScanOpts = {}): Promise<void> {
  const sources: SourceSpec[] = []
  for await (const s of claudeCodeAdapter.discover(hostCtx(root))) sources.push(s)
  expect(sources).toHaveLength(2) // the session file and its side chain, as upstream writes them
  sources.sort((a, b) => a.path.localeCompare(b.path))
  if (opts.reverse) sources.reverse()
  const { resolveProject } = makeResolver()
  for (const source of sources) {
    const inSubagents = source.path.includes('/subagents/')
    if (opts.parentOnly && inSubagents) continue
    if (opts.sidechainOnly && !inSubagents) continue
    scannedSourceIds.add(source.id)
    await scanSource(claudeCodeAdapter, source, {
      sink: makeSink(db, source),
      saved: savedState(db, source.id, opts.replay === true),
      agentId: claudeCodeAdapter.id,
      hostId: claudeCodeAdapter.id,
      resolveProject,
      now: () => T0,
    })
  }
}

function makeResolver(): { resolveProject(cwd: string | null | undefined): string | null } {
  return {
    resolveProject(cwd) {
      if (!cwd) return null
      return deriveProjectId(projectRootForCwd(cwd, { homedir: '/fixture' }))
    },
  }
}

// ---------------------------------------------------------------- row readers

type Row = Record<string, unknown>
const rows = (db: ReturnType<typeof openDatabase>, sql: string, ...params: unknown[]): Row[] =>
  (db.prepare(sql).all(...(params as never[])) as Row[]).map((r) => ({ ...r }))

/** The single `subagent.start` row of the chain, with its metadata parsed. */
function chainRow(db: ReturnType<typeof openDatabase>): Row & { meta: Record<string, unknown> } {
  const found = rows(db, "SELECT * FROM events WHERE type = 'subagent.start' ORDER BY timestamp")
  expect(found, 'the side chain writes exactly one subagent.start row').toHaveLength(1)
  const row = found[0]!
  return { ...row, meta: JSON.parse(String(row.metadata)) as Record<string, unknown> }
}

/** Spawn candidates in transcript order: `[early, late]`. */
function spawnRows(db: ReturnType<typeof openDatabase>): Row[] {
  return rows(db, "SELECT * FROM events WHERE type = 'tool.start' AND capability_type = 'subagent' ORDER BY raw_seq")
}

/**
 * A path-free view of the `events` table. `source_id` and `event.id` are digests over the
 * ABSOLUTE path (§4.1), so two stores built from the same transcript in two temp directories
 * cannot be compared by id; every identity here is `(which file, which line, which type)`
 * instead, which is what the two stores must agree on.
 */
function eventShape(db: ReturnType<typeof openDatabase>): string[] {
  const roleOfSource = new Map<string, string>()
  for (const s of rows(db, 'SELECT id, path FROM sources')) {
    roleOfSource.set(String(s.id), String(s.path).includes('/subagents/') ? 'chain' : 'parent')
  }
  const all = rows(db, 'SELECT * FROM events')
  const stripId = (r: Row): string => JSON.stringify(r, (k, v) => (k === 'id' || k === 'source_id' ? '' : v))
  // Intern ids in a content-derived total order, so the labels cannot depend on read order.
  const labelById = new Map<string, string>()
  const used = new Set<string>()
  for (const r of [...all].sort((a, b) => (stripId(a) < stripId(b) ? -1 : 1))) {
    const base = `${roleOfSource.get(String(r.source_id)) ?? 'other'}#${r.raw_seq}:${r.type}`
    labelById.set(String(r.id), used.has(base) ? `${base}?${String(r.id).slice(0, 6)}` : base)
    used.add(base)
  }
  const label = (value: unknown): string => {
    if (value === null || value === undefined) return 'null'
    return labelById.get(String(value)) ?? 'foreign'
  }
  const models = new Map<number, string>()
  for (const m of rows(db, 'SELECT rowid AS rid, provider, name, tier FROM models')) {
    models.set(Number(m.rid), `${m.provider}/${m.name}:${String(m.tier ?? '-')}`)
  }
  return all.map((r) =>
    [
      label(r.id),
      `parent=${label(r.parent_event_id)}`,
      `session=${String(r.session_id).slice(0, 8)}`,
      `ts=${r.timestamp}`,
      `subtype=${String(r.subtype ?? '')}`,
      `cap=${String(r.capability_type ?? '')}/${String(r.capability_name ?? '')}/${String(r.capability_provider ?? '')}`,
      `model=${r.model_rowid === null ? 'null' : models.get(Number(r.model_rowid))}`,
      `usage=${String(r.usage_source)}:${[r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.reasoning_tokens].join(',')}`,
      `content=${String(r.content_ref)}`,
      `status=${String(r.status)}`,
      `seq=${r.raw_seq}/${r.raw_offset}`,
      // `linked_parent` inside metadata is an event id, so it is canonicalized too.
      `meta=${JSON.stringify(JSON.parse(String(r.metadata ?? '{}')), (k, v) =>
        typeof v === 'string' && labelById.has(v) ? labelById.get(v) : v,
      )}`,
    ].join(' '),
  ).sort() // rowid order follows insertion order, i.e. the scan order itself; contents must not
}

async function freshDb(): Promise<ReturnType<typeof openDatabase>> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-sidechain-db-'))
  dirs.push(dir)
  const db = openDatabase(join(dir, 'agentlens.db'))
  migrate(db)
  return db
}

// ---------------------------------------------------------------- the pure rule
// No database involved: these pin the two properties the deployed pass depends on.

describe('subagent parent rule (pure)', () => {
  const spawn = (eventId: string, sourceId: string, timestamp: number, rawSeq: number): SubagentSpawnCandidate => ({
    eventId,
    sourceId,
    timestamp,
    rawSeq,
  })

  it('reaches across files, where raw_seq is meaningless', () => {
    // The adapter's own rule drops both of these, because their `rawSeq` exceeds the chain's
    // 1 — but the two counters belong to different files, so the comparison means nothing.
    const chain = { eventId: 'chain', sourceId: 'chain-file', timestamp: 2_000, rawSeq: 1 }
    const pool = [spawn('early', 'parent-file', 1_000, 5), spawn('late', 'parent-file', 1_500, 9)]
    expect(resolveSubagentParent(chain, pool, null)).toEqual({ parentEventId: 'late', evidence: 'heuristic' })
  })

  it('still respects raw_seq inside one file, where it is meaningful', () => {
    const chain = { eventId: 'chain', sourceId: 'parent-file', timestamp: 2_000, rawSeq: 5 }
    const pool = [spawn('before', 'parent-file', 1_000, 3), spawn('after', 'parent-file', 1_200, 9)]
    expect(pickNearestPrecedingSpawn(chain, pool)?.eventId).toBe('before')
  })

  it('prefers a proof over a plausible guess', () => {
    const chain = { eventId: 'chain', sourceId: 'chain-file', timestamp: 2_000, rawSeq: 1 }
    const pool = [spawn('early', 'parent-file', 1_000, 1), spawn('late', 'parent-file', 1_500, 2)]
    expect(resolveSubagentParent(chain, pool, 'early')).toEqual({ parentEventId: 'early', evidence: 'foreign-key' })
  })

  it('falls back to the heuristic when the proven row is gone', () => {
    const chain = { eventId: 'chain', sourceId: 'chain-file', timestamp: 2_000, rawSeq: 1 }
    const pool = [spawn('late', 'parent-file', 1_500, 2)]
    expect(resolveSubagentParent(chain, pool, 'pruned-elsewhere')).toEqual({
      parentEventId: 'late',
      evidence: 'heuristic',
    })
  })

  it('leaves the parent unknown rather than guessing', () => {
    const chain = { eventId: 'chain', sourceId: 'chain-file', timestamp: 500, rawSeq: 1 }
    expect(resolveSubagentParent(chain, [spawn('late', 'parent-file', 1_500, 2)], null)).toEqual({
      parentEventId: null,
      evidence: null,
    })
  })

  it('breaks ties by id, so pool order cannot change the answer', () => {
    const chain = { eventId: 'chain', sourceId: 'chain-file', timestamp: 2_000, rawSeq: 1 }
    const a = spawn('spawn-a', 'parent-file', 1_000, 1)
    const b = spawn('spawn-b', 'parent-file', 1_000, 1)
    expect(pickNearestPrecedingSpawn(chain, [a, b])?.eventId).toBe('spawn-b')
    expect(pickNearestPrecedingSpawn(chain, [b, a])?.eventId).toBe('spawn-b')
  })
})

// ---------------------------------------------------------------- the deployed store

describe('claude-code side chain across two files (§4.4 row 8)', () => {
  it('links the proven spawn, whichever of the two files the scan read first', async () => {
    const run = async (reverse: boolean) => {
      const db = await freshDb()
      await scanTree(db, await makeTree(parentTranscript(true), sidechainTranscript()), { reverse })
      // What the store looks like before the pass — the deployed behaviour, NULL parent:
      expect(chainRow(db).parent_event_id).toBeNull()
      const result = resolveSubagentParents(db)
      const [early, late] = spawnRows(db)
      const row = chainRow(db)
      const view = {
        linkedByProof: result.linkedByProof,
        linkedByHeuristic: result.linkedByHeuristic,
        unresolved: result.unresolved,
        chains: result.chains,
        rewritten: result.rewritten,
        refused: result.refused,
        parentIsTheProvenSpawn: row.parent_event_id === early!.id,
        parentIsTheNearerWrongSpawn: row.parent_event_id === late!.id,
        evidence: row.meta.parent_source,
        shape: eventShape(db),
      }
      db.close()
      return view
    }
    const [forward, backward] = await Promise.all([run(false), run(true)])

    expect(forward.shape).toEqual(backward.shape) // scan-order independence, over the whole table
    expect(forward.linkedByProof).toBe(1)
    expect(forward.linkedByHeuristic).toBe(0)
    expect(forward.unresolved).toBe(0)
    expect(forward.rewritten).toBe(1)
    expect(forward.refused).toEqual([])
    expect(forward.parentIsTheProvenSpawn).toBe(true)
    expect(forward.parentIsTheNearerWrongSpawn).toBe(false) // the nearer spawn is the WRONG one
    expect(forward.evidence).toBe('foreign-key')
    expect(forward.shape.join('\n')).toContain('parent=parent#2:tool.start')
  })

  it('uses the nearest preceding spawn when nothing proves the link', async () => {
    const db = await freshDb()
    await scanTree(db, await makeTree(parentTranscript(false), sidechainTranscript()))
    const [early, late] = spawnRows(db)
    expect(early).toBeTruthy()
    const result = resolveSubagentParents(db)
    const row = chainRow(db)
    expect(result.linkedByProof).toBe(0)
    expect(result.linkedByHeuristic).toBe(1)
    // t=30s is the greatest spawn timestamp at or before the chain's 35s.
    expect(row.parent_event_id).toBe(late!.id)
    expect(row.parent_event_id).not.toBe(early!.id)
    expect(row.meta).toMatchObject({
      parent_source: 'heuristic',
      parent_matched: true,
      parent_heuristic: true,
    })
    expect(result.refused).toEqual([])
    db.close()
  })

  it('converges: a second pass writes nothing, and a byte replay restores the same store', async () => {
    const db = await freshDb()
    const root = await makeTree(parentTranscript(true), sidechainTranscript())
    await scanTree(db, root)
    expect(resolveSubagentParents(db).rewritten).toBe(1)

    const linkedEvents = dumpTable(db, 'events')
    const linkedPayloads = dumpTable(db, 'payloads')

    const second = resolveSubagentParents(db)
    expect(second.chains).toBe(1)
    expect(second.rewritten).toBe(0)
    expect(second.rows.filter((r) => r.changes)).toEqual([])
    expect(dumpTable(db, 'events')).toEqual(linkedEvents)
    expect(dumpTable(db, 'payloads')).toEqual(linkedPayloads)

    // §4.2 in its strict form: replay the same bytes from offset 0, then link again. The replay
    // re-derives the chain row with a NULL parent (the adapter's ledger is still per source), so
    // this asserts that scan → link is a fixed point, not that the pass merely looks idempotent.
    await scanTree(db, root, { replay: true })
    expect(chainRow(db).parent_event_id).toBeNull()
    expect(resolveSubagentParents(db).rewritten).toBe(1)
    expect(dumpTable(db, 'events')).toEqual(linkedEvents)
    expect(dumpTable(db, 'payloads')).toEqual(linkedPayloads)
    db.close()
  })

  it('moves exactly parent_event_id and metadata, on exactly one row', async () => {
    const db = await freshDb()
    await scanTree(db, await makeTree(parentTranscript(true), sidechainTranscript()))
    const before = new Map(dumpTable(db, 'events').map((r) => [String(r.id), r]))
    const beforePayloads = dumpTable(db, 'payloads')
    const beforeSessions = dumpTable(db, 'sessions')
    resolveSubagentParents(db)

    const moved: string[] = []
    for (const row of dumpTable(db, 'events')) {
      const old = before.get(String(row.id))!
      const changed = Object.keys(old).filter((k) => old[k] !== row[k]).sort()
      if (changed.length > 0) moved.push(`${String(row.type)}:${changed.join('+')}`)
    }
    expect(moved.sort()).toEqual(['subagent.start:metadata+parent_event_id'])
    expect(dumpTable(db, 'payloads')).toEqual(beforePayloads)
    expect(dumpTable(db, 'sessions')).toEqual(beforeSessions)
    db.close()
  })

  it('leaves a chain with no spawn in the store at NULL, and restates nothing', async () => {
    const db = await freshDb()
    // Only the side chain file is ingested: no spawn row exists, so §4.4 row 8's NULL is right.
    await scanTree(db, await makeTree(parentTranscript(true), sidechainTranscript()), { sidechainOnly: true })
    const row = chainRow(db)
    expect(row.parent_event_id).toBeNull()
    expect(row.meta).toMatchObject({ parent_source: 'none', parent_matched: false, parent_heuristic: false })
    const plan = planSubagentParentLinks(db)
    expect(plan.chains).toBe(1)
    expect(plan.unresolved).toBe(1)
    expect(plan.rows.filter((r) => r.changes)).toEqual([])
    expect(resolveSubagentParents(db).rewritten).toBe(0)
    expect(chainRow(db).parent_event_id).toBeNull()
    db.close()
  })

  it('never reaches into another agent or another session', async () => {
    const db = await freshDb()
    await scanTree(db, await makeTree(parentTranscript(true), sidechainTranscript()))
    const [early] = spawnRows(db)
    const chain = chainRow(db)
    // §18 rows 2/3: Codex's `subagent.start` is parentless BY DESIGN — its spawning
    // `spawn_agent` call lives in another thread file and `subagentsIncluded: false` keeps those
    // threads out of its cost fold, so a time-heuristic edge there is a wrong link with a price
    // tag attached. Same session as the claude-code rows, so only the vocabulary gate protects it.
    insertEvents(
      db,
      [
        syntheticEvent({
          id: 'codex-chain',
          agentId: 'codex',
          sourceId: String(chain.source_id),
          sessionId: String(chain.session_id),
          timestamp: Number(chain.timestamp) + 1000,
          type: 'subagent.start',
          metadata: { agent_id: 'codex-thread-9' },
          projectId: String(chain.project_id),
        }),
        // A claude-code chain of another session: the same spawn pool must not cross over.
        syntheticEvent({
          id: 'other-session-chain',
          agentId: 'claude-code',
          sourceId: String(chain.source_id),
          sessionId: 'sess-somebody-else',
          projectId: String(chain.project_id),
          timestamp: Number(chain.timestamp) + 1000,
          type: 'subagent.start',
          metadata: { agent_id: 'agent-other-session', parent_source: 'none', parent_matched: false },
        }),
      ],
      { contentEnabled: false },
    )
    const result = resolveSubagentParents(db)
    expect(result.chains).toBe(2) // this session's chain, plus the other session's
    expect(result.rows.map((r) => r.eventId)).not.toContain('codex-chain')
    expect(rows(db, "SELECT parent_event_id, metadata FROM events WHERE id = 'codex-chain'")[0]).toEqual({
      parent_event_id: null,
      metadata: JSON.stringify({ agent_id: 'codex-thread-9' }),
    })
    expect(rows(db, "SELECT parent_event_id FROM events WHERE id = 'other-session-chain'")[0]).toEqual({
      parent_event_id: null,
    })
    expect(early).toBeTruthy()
    expect(result.refused).toEqual([])
    db.close()
  })

  it('voids a proof two closing rows disagree on, whichever order they were written', async () => {
    const run = async (order: number[]) => {
      const db = await freshDb()
      await scanTree(db, await makeTree(parentTranscript(true), sidechainTranscript()))
      const [early, late] = spawnRows(db)
      const chain = chainRow(db)
      // The fixture's own proof names `early`; a second one naming `late` contradicts it. Two rows
      // that disagree are not evidence, and "keep the last one read" would be order-dependent.
      const parents = [String(early!.id), String(late!.id)]
      for (const i of order) {
        insertEvents(
          db,
          [
            syntheticEvent({
              id: `contradiction-${i}`,
              agentId: 'claude-code',
              sourceId: String(chain.source_id),
              sessionId: String(chain.session_id),
              timestamp: Number(chain.timestamp) + 1 + i,
              type: 'subagent.end',
              parentEventId: parents[i]!,
              projectId: String(chain.project_id),
              metadata: { agent_id: CHAIN, linked_parent: parents[i]!, parent_source: 'foreign-key' },
            }),
          ],
          { contentEnabled: false },
        )
      }
      const result = resolveSubagentParents(db)
      const view = {
        unusableProofs: result.unusableProofs,
        parentIsEarly: chainRow(db).parent_event_id === early!.id,
        parentIsLate: chainRow(db).parent_event_id === late!.id,
        evidence: chainRow(db).meta.parent_source,
      }
      db.close()
      return view
    }
    const forward = await run([0, 1])
    const backward = await run([1, 0])
    expect(forward).toEqual(backward)
    expect(forward.unusableProofs).toBe(1)
    expect(forward.evidence).toBe('heuristic') // the proof is void, so the heuristic decides
    expect(forward.parentIsLate).toBe(true)
    expect(forward.parentIsEarly).toBe(false)
  })
})

/** A stored row built directly, for the cases no transcript can produce (other agents, extra proofs). */
function syntheticEvent(init: {
  id: string
  agentId: string
  sourceId: string
  sessionId: string
  projectId: string
  timestamp: number
  type: AgentEvent['type']
  parentEventId?: string | null
  metadata: Record<string, unknown>
}): AgentEvent {
  const chainType = init.type === 'subagent.start' || init.type === 'subagent.end'
  return {
    id: init.id,
    schemaVersion: SCHEMA_VERSION,
    agentId: init.agentId,
    hostId: init.agentId === 'codex' ? 'codex-cli' : 'claude-code',
    sourceId: init.sourceId,
    sessionId: init.sessionId,
    projectId: init.projectId,
    parentEventId: init.parentEventId ?? null,
    requestId: null,
    timestamp: init.timestamp,
    ingestedAt: T0,
    type: init.type,
    subtype: null,
    model: null,
    usage: null,
    usageSource: 'missing',
    capability: chainType
      ? { type: 'subagent', name: String(init.metadata.agent_id ?? 'chain'), provider: 'agent' }
      : null,
    durationMs: null,
    status: 'ok',
    errorFingerprint: null,
    rawSeq: 900,
    rawOffset: 0,
    metadata: init.metadata,
  }
}

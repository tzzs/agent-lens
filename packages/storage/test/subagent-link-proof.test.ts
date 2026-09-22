/**
 * `proofNames: 'tool-use-id'`, end to end over stored rows.
 *
 * ZCode's proof of a subagent parent is a foreign key written in a document outside the SQLite
 * store, and that document names the spawning `Agent` call by its raw id — never by a rowid. So
 * the linker must resolve `linked_parent` against the pool's `spawnToolUseKey` rather than
 * treating it as an event id (`packages/storage/src/subagent-parent-links.ts`).
 *
 * These rows are SYNTHETIC, shaped like what `adapters/zcode` writes (docs/research/zcode.md
 * §八·5): the spawn and the chain fold to one product session exactly as the adapter's root walk
 * does, and the close arrives from a third source. The point of building them through
 * `insertEvents` instead of a scan is that the rule must hold for whatever is already in the
 * store — that is what makes it independent of scan order.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  deriveEventId,
  deriveSessionId,
  type AgentEvent,
} from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '../src/index.ts'
import { planSubagentParentLinks, resolveSubagentParents } from '../src/subagent-parent-links.ts'

const AGENT = 'zcode'
const STORE_SOURCE = 'a'.repeat(64) // the `…#part` source: where the spawn lives
const SESSION_SOURCE = 'b'.repeat(64) // the `…#session` source: where the chain marker lives
const CLOSE_SOURCE = 'c'.repeat(64) // the agents-document source: where the proof arrives from
const ROOT = 'sess_root_0001'
const CHILD = 'sess_subagent_agent_child0001'
const PROJECT = 'd'.repeat(64)
const T0 = 1_760_000_000_000

const sessionId = deriveSessionId(AGENT, ROOT)

function event(init: {
  sourceId: string
  rawSeq: number
  type: AgentEvent['type']
  discriminator: string
  timestamp: number
  capability?: AgentEvent['capability']
  metadata: Record<string, unknown>
}): AgentEvent {
  return {
    id: deriveEventId({
      sourceId: init.sourceId,
      rawSeq: init.rawSeq,
      type: init.type,
      timestamp: init.timestamp,
      discriminator: init.discriminator,
    }),
    schemaVersion: SCHEMA_VERSION,
    agentId: AGENT,
    hostId: AGENT,
    sourceId: init.sourceId,
    sessionId,
    projectId: PROJECT,
    parentEventId: null,
    requestId: null,
    threadId: CHILD,
    timestamp: init.timestamp,
    ingestedAt: init.timestamp,
    type: init.type,
    subtype: null,
    model: null,
    usage: null,
    usageSource: 'missing',
    costReported: null,
    costSource: 'none',
    credits: null,
    capability: init.capability ?? null,
    durationMs: null,
    status: 'ok',
    errorFingerprint: null,
    rawSeq: init.rawSeq,
    rawOffset: init.rawSeq,
    payload: null,
    metadata: init.metadata,
  }
}

const spawnEvent = (callId: string, rawSeq: number, seconds: number, name: string): AgentEvent =>
  event({
    sourceId: STORE_SOURCE,
    rawSeq,
    type: 'tool.start',
    discriminator: `part:${rawSeq}:tool-start:call`,
    timestamp: T0 + seconds * 1000,
    capability: { type: 'subagent', name, provider: 'Agent' },
    metadata: { call_id: callId, tool: 'Agent' },
  })

/** A spawn in the `part` source, its chain in the `session` source, a close from a third. */
function zcodeRows(callId: string): AgentEvent[] {
  return [
    spawnEvent(callId, 11, 1, 'general-purpose'),
    event({
      sourceId: SESSION_SOURCE,
      rawSeq: 2,
      type: 'subagent.start',
      discriminator: 'session:2:subagent-start',
      timestamp: T0 + 2_000,
      capability: { type: 'subagent', name: 'subagent', provider: 'session.parent_id' },
      metadata: { native_session_id: CHILD, parent_session_id: ROOT },
    }),
    event({
      sourceId: CLOSE_SOURCE,
      rawSeq: 1,
      type: 'subagent.end',
      discriminator: 'metadata:child',
      timestamp: T0 + 9_000,
      metadata: {
        native_session_id: CHILD,
        parent_source: 'foreign-key',
        linked_parent: callId,
        agent_id: 'agent_child0001',
        status: 'completed',
      },
    }),
  ]
}

async function stored(rows: AgentEvent[]): Promise<ReturnType<typeof openDatabase>> {
  const dir = await mkdtemp(join(tmpdir(), 'agl-zcode-link-'))
  const db = openDatabase(join(dir, 'agentlens.db'))
  migrate(db)
  insertEvents(db, rows, { contentEnabled: false })
  cleanups.push(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return db
}

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const done of cleanups) await done()
  cleanups = []
})

const chainView = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare(
      `SELECT id, parent_event_id, json_extract(metadata,'$.parent_source') AS source
         FROM events WHERE type = 'subagent.start' AND agent_id = 'zcode'`,
    )
    .get() as { id: string; parent_event_id: string | null; source: string | null }

describe('a subagent proof that names the raw call id (zcode shape)', () => {
  it('links the chain to the spawn the foreign key names, across three sources', async () => {
    const rows = zcodeRows('call_alpha')
    const db = await stored(rows)
    const spawn = rows.find((r) => r.type === 'tool.start')!
    expect(chainView(db).parent_event_id).toBeNull()

    const result = resolveSubagentParents(db)
    expect(result.chains).toBe(1)
    expect(result.linkedByProof).toBe(1)
    expect(result.linkedByHeuristic).toBe(0)
    expect(result.unresolved).toBe(0)
    const after = chainView(db)
    expect(after.parent_event_id).toBe(spawn.id)
    expect(after.source).toBe('foreign-key')
  })

  it('converges: a second pass derives the same parent and rewrites nothing', async () => {
    const db = await stored(zcodeRows('call_alpha'))
    resolveSubagentParents(db)
    const second = resolveSubagentParents(db)
    expect(second.rewritten).toBe(0)
    expect(second.unusableProofs).toBe(0)
    expect(second.linkedByProof).toBe(1)
  })

  it('voids an ambiguous raw id, and says so by falling back to the heuristic', async () => {
    // Two spawns of one session carrying the same `call_id`: the proof could mean either, so it
    // proves neither — but the chain still has a nearest preceding spawn, which is reported as
    // the weaker evidence rather than passed off as the foreign key.
    const later = spawnEvent('call_dup', 12, 1.5, 'Explore')
    const db = await stored([...zcodeRows('call_dup'), later])
    const plan = planSubagentParentLinks(db)
    expect(plan.unusableProofs).toBe(1)
    expect(plan.linkedByProof).toBe(0)
    expect(plan.linkedByHeuristic).toBe(1)
    expect(plan.unresolved).toBe(0)
    expect(chainView(db).source).not.toBe('foreign-key')
    resolveSubagentParents(db)
    // The heuristic picks the later spawn: nearest preceding the chain's own instant.
    expect(chainView(db).parent_event_id).toBe(later.id)
  })

  it('voids a raw id that names nothing, without discarding the proof that does', async () => {
    const rows = zcodeRows('call_real')
    const spawn = rows.find((r) => r.type === 'tool.start')!
    const dangling = event({
      sourceId: CLOSE_SOURCE,
      rawSeq: 2,
      type: 'subagent.end',
      discriminator: 'metadata:orphan',
      timestamp: T0 + 9_500,
      metadata: {
        native_session_id: CHILD,
        parent_source: 'foreign-key',
        linked_parent: 'call_missing',
        agent_id: 'agent_other',
        status: 'completed',
      },
    })
    const db = await stored([...rows, dangling])
    const result = resolveSubagentParents(db)
    expect(result.unusableProofs).toBe(1)
    expect(result.linkedByProof).toBe(1)
    expect(chainView(db).parent_event_id).toBe(spawn.id)
  })

  it('never reaches across agents: claude-code proof rows are left to their own vocabulary', async () => {
    const db = await stored(zcodeRows('call_alpha'))
    const foreign = db.prepare(`SELECT COUNT(*) n FROM events WHERE agent_id != 'zcode'`).get() as { n: number }
    expect(foreign.n).toBe(0)
    const plan = planSubagentParentLinks(db)
    expect(plan.rows.every((r) => r.agentId === 'zcode')).toBe(true)
    expect(plan.chains).toBe(1)
  })
})

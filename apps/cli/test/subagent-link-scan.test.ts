/**
 * §4.4 row 8, deployed form: the spawn and the side chain are in different source files, which is
 * the only shape real Claude Code writes (`<session>/subagents/agent-<id>.jsonl` beside the
 * parent's transcript), and the adapter's per-source ledger cannot cross it. This pins the part
 * the storage-level tests cannot: that `agl scan` actually runs the linker over the whole store
 * after ingesting, reports which evidence it used, and that the next scan has nothing to say.
 *
 * Rows are seeded directly rather than scanned from a fake `~/.claude`, because the fixture here
 * is the STORE shape (two sources, one session) — the adapter's own file-level behaviour is
 * covered in packages/collector/test/subagent-parent-links.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { SCHEMA_VERSION, type AgentEvent } from '@agentlens/event-model'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli } from '../src/index.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-subagent-scan-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 8, 20, 12, 0, 0)
const SESSION = 'claude-code:sess-parent'
const PROJECT = '0'.repeat(64)
const SPAWN_SOURCE = `${tmp}/sess-parent.jsonl`
const CHAIN_SOURCE = `${tmp}/subagents/agent-alpha.jsonl`

function row(init: Partial<AgentEvent> & { id: string; sourceId: string; type: AgentEvent['type'] }): AgentEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sessionId: SESSION,
    projectId: PROJECT,
    timestamp: T0,
    ingestedAt: T0,
    parentEventId: null,
    requestId: null,
    subtype: null,
    model: null,
    usage: null,
    capability: null,
    durationMs: null,
    status: null,
    errorFingerprint: null,
    threadId: null,
    costReported: null,
    costSource: 'none',
    contentRef: null,
    payload: null,
    metadata: {},
    rawSeq: 1,
    rawOffset: 0,
    ...init,
  } as AgentEvent
}

/** The spawn lives in the parent's file; the side chain's `subagent.start` in its own. */
function seedStore(dbPath: string): void {
  const db = openDatabase(dbPath)
  migrate(db)
  insertEvents(
    db,
    [
      row({
        id: 'spawn-row',
        sourceId: SPAWN_SOURCE,
        type: 'tool.start',
        capability: { type: 'subagent', name: 'Agent', provider: null },
        timestamp: T0,
        metadata: { tool_use_id: 'toolu_spawn_1', agent_type: 'general-purpose' },
      }),
      row({
        id: 'chain-row',
        sourceId: CHAIN_SOURCE,
        type: 'subagent.start',
        capability: { type: 'subagent', name: 'general-purpose', provider: null },
        timestamp: T0 + 5_000,
        metadata: { agent_id: 'agent-alpha' },
      }),
    ],
    { contentEnabled: false },
  )
  expect(db.prepare('SELECT parent_event_id AS p FROM events WHERE id = ?').get('chain-row')).toEqual({ p: null })
  db.close()
}

async function runScan(dbPath: string): Promise<string[]> {
  const lines: string[] = []
  const ctx = {
    argv: ['scan', '--db', dbPath],
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => T0,
  }
  await runCli(ctx as never)
  return lines
}

describe('agl scan resolves cross-source subagent parents (§4.4 row 8)', () => {
  it('links the side chain whose spawn sits in another source, and says how', async () => {
    const dbPath = join(tmp, 'link.db')
    seedStore(dbPath)
    const lines = await runScan(dbPath)

    const db = openDatabase(dbPath)
    const stored = db.prepare('SELECT parent_event_id, metadata FROM events WHERE id = ?').get('chain-row') as {
      parent_event_id: string | null
      metadata: string
    }
    db.close()
    expect(stored.parent_event_id).toBe('spawn-row')
    expect(JSON.parse(stored.metadata).parent_source).toBe('heuristic')
    expect(lines.join('\n')).toContain(
      "+ 1 side-chain row linked to its spawn (§4.4 row 8: 0 by the spawn's own id, 1 by the nearest preceding call)",
    )
  })

  it('is a no-op on the next scan, so §4.2 holds for the linker too', async () => {
    const dbPath = join(tmp, 'noop.db')
    seedStore(dbPath)
    await runScan(dbPath)
    const second = await runScan(dbPath)
    expect(second.join('\n')).not.toContain('side-chain row')
  })
})

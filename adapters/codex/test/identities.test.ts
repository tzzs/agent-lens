/**
 * §18 rows 3, 6 and 7: the identity axes Codex does NOT share with Claude Code —
 * `originator` as host, file=thread vs session_id spanning files, and the fact that
 * request-id dedupe does not apply here.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dedupeByRequestId,
  deriveProjectId,
  deriveSessionId,
  deriveSessionIdFromSource,
  type AgentEvent,
} from '@agentlens/event-model'
import { codexAdapter, detect, HOST_DESKTOP, HOST_UNKNOWN } from '../src/index.ts'
import { resolveHost, slugOriginator } from '../src/record.ts'
import { ctxFor, FIXTURES_DIR, hostCtx, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

function storeCtx(dir: string) {
  const root = join(FIXTURES_DIR, dir)
  return hostCtx({ dataRoot: root, homedir: root })
}

async function normalizeAll(name: string, sessionHint: string | null = null, path = `/fixture/${name}`): Promise<AgentEvent[]> {
  const ctx = ctxFor(name, sessionHint, path)
  resetStateFor(ctx)
  const out: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result = await codexAdapter.normalize(record, ctx)
    if ('failure' in result) continue
    out.push(...result.events)
  }
  return out
}

describe('host axis (§18 row 6)', () => {
  it('every measured originator value maps to a stable lower-case slug', () => {
    // codex.md §2.3 observed exactly: Desktop 343 / tui 15 / exec 13 / cli_rs 8.
    expect(resolveHost('Codex Desktop')).toEqual({ hostId: HOST_DESKTOP, diagnostic: null })
    expect(resolveHost('codex-tui')).toEqual({ hostId: 'codex-tui', diagnostic: null })
    expect(resolveHost('codex_exec')).toEqual({ hostId: 'codex-exec', diagnostic: null })
    expect(resolveHost('codex_cli_rs')).toEqual({ hostId: 'codex-cli-rs', diagnostic: null })
    expect(slugOriginator('  CODEX--TUI ')).toBe('codex-tui')
  })

  it('unknown and absent originators land on codex-unknown, counted not dropped', async () => {
    expect(resolveHost('codex-vscode-extension')).toEqual({
      hostId: 'codex-unknown',
      diagnostic: 'originator-unknown:codex-vscode-extension',
    })
    expect(resolveHost(undefined).hostId).toBe(HOST_UNKNOWN)

    const events = await normalizeAll('hosts.jsonl')
    const starts = events.filter((e) => e.type === 'session.start' || e.type === 'subagent.start')
    expect(starts.map((e) => e.hostId)).toEqual([
      'codex-desktop',
      'codex-tui',
      'codex-exec',
      'codex-cli-rs',
      HOST_UNKNOWN,
      HOST_UNKNOWN,
      'codex-desktop',
    ])
    const weird = starts.find((e) => e.hostId === HOST_UNKNOWN && (e.metadata?.host_diagnostics as string[] | undefined)?.[0]?.startsWith('originator-unknown'))
    expect(weird?.metadata?.host_diagnostics).toEqual(['originator-unknown:codex-vscode-extension'])
    expect(weird?.metadata?.originator).toBe('codex-vscode-extension')
    // absent is a DIFFERENT diagnostic from unknown, and the raw value is still on the event
    const absent = starts.filter((e) => (e.metadata?.host_diagnostics as string[] | undefined)?.[0] === 'originator-absent')
    expect(absent).toHaveLength(1)
    expect(absent[0]?.metadata?.originator).toBeNull()
    // the four real hosts are never reported as codex-unknown
    expect(new Set(starts.map((e) => e.hostId)).size).toBe(5)
  })

  it('records after session_meta inherit the thread host', async () => {
    const events = await normalizeAll('hosts.jsonl')
    const usage = events.find((e) => e.rawSeq === 7)
    expect(usage?.type).toBe('generation.end')
    expect(usage?.hostId).toBe(HOST_UNKNOWN)
    expect(usage?.metadata?.host_diagnostics).toEqual(['originator-absent'])
  })
})

describe('thread vs session (§18 row 3)', () => {
  it('two files of one session share sessionId but keep distinct threadIds', async () => {
    const parent = await normalizeAll('parent-thread.jsonl', '01JPARENTSSSSSSSSSSSSSSSSS', '/root/sessions/2026/09/16/rollout-2026-09-16T09-00-00-01JPARENTSSSSSSSSSSSSSSSSS.jsonl')
    const child = await normalizeAll('child-thread.jsonl', '01JSPANNNNNNNNNNNNNNNNNNNN', '/root/sessions/2026/09/16/rollout-2026-09-16T09-00-04-01JSPANNNNNNNNNNNNNNNNNNNN.jsonl')
    expect(parent[0]?.sessionId).toBe(child[0]?.sessionId)
    expect(parent[0]?.sessionId).toBe(deriveSessionId('codex', 'sess-spanned'))
    expect(new Set([...parent, ...child].map((e) => e.threadId))).toEqual(
      new Set(['01JPARENTSSSSSSSSSSSSSSSSS', '01JSPANNNNNNNNNNNNNNNNNNNN']),
    )
    // subagent grain is explicit: the child thread is flagged, the parent is not.
    expect(parent.every((e) => e.metadata?.subagentThread === undefined)).toBe(true)
    expect(child.every((e) => e.metadata?.subagentThread === true)).toBe(true)
    expect(child[0]?.type).toBe('subagent.start')
    expect(child[0]?.metadata?.thread_id).toBe('01JSPANNNNNNNNNNNNNNNNNNNN')
  })

  it('a resumed scan without session_meta falls back to the filename hint, visibly', async () => {
    const ctx = ctxFor(
      'child-thread.jsonl',
      '01JSPANNNNNNNNNNNNNNNNNNNN',
      '/root/sessions/2026/09/16/rollout-2026-09-16T09-00-04-01JSPANNNNNNNNNNNNNNNNNNNN.jsonl',
    )
    resetStateFor(ctx)
    const records = recordsFromJsonl(await readFixture('child-thread.jsonl')).slice(1)
    const events: AgentEvent[] = []
    for (const record of records) {
      const r = await codexAdapter.normalize({ ...record, seq: record.seq + 2, offset: record.offset + 500 }, ctx)
      if (!('failure' in r)) events.push(...r.events)
    }
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.threadId).toBe('01JSPANNNNNNNNNNNNNNNNNNNN')
    expect(events[0]?.metadata?.thread_id_source).toBe('filename-hint')
    expect(events[0]?.metadata?.session_id_synthetic).toBe(true)
  })
})

describe('request-id semantics (§18 rows 1 and 7)', () => {
  it('no requestId is fabricated for the old format, so each usage row is its own group', async () => {
    const events = (await normalizeAll('per-call-and-cumulative.jsonl')).filter((e) => e.usage)
    expect(events.every((e) => e.requestId === null || e.requestId === 'resp_00kq3x9abcd')).toBe(true)
    const groups = dedupeByRequestId(events)
    expect(groups).toHaveLength(events.length)
  })

  it('replaying a source from seq 1 yields byte-identical event ids (§4.2 idempotency)', async () => {
    const first = await normalizeAll('subagent-thread.jsonl')
    const second = await normalizeAll('subagent-thread.jsonl')
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id))
    expect(new Set(first.map((e) => e.id)).size).toBe(first.length)
  })
})

describe('project resolution (§18 / rule 6)', () => {
  it('cwd arrives on session_meta, so every later record projects from the thread context', async () => {
    const events = await normalizeAll('subagent-thread.jsonl')
    expect(events.length).toBeGreaterThan(1)
    expect([...new Set(events.map((e) => e.projectId))]).toEqual(['project:beta'])
    expect(events[0]?.metadata?.native_session_id).toBe('sess-cached-heavy')
  })

  it('records with no cwd anywhere are flagged unattributed, not silently filed away', async () => {
    const ctx = ctxFor('hosts.jsonl')
    resetStateFor(ctx)
    const record = {
      seq: 20,
      offset: 2000,
      occurredAt: 1_760_000_000_000,
      value: {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [] },
        timestamp: '2026-09-15T13:00:20.000Z',
      },
    }
    const result = await codexAdapter.normalize(record, ctx)
    expect('failure' in result).toBe(false)
    if ('failure' in result) return
    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.projectId).toBe(deriveProjectId('unattributed'))
    expect(event.metadata?.project_unattributed).toBe(true)
    // no session_meta and no usable filename hint: the thread id is honestly absent and
    // the session id is derived from the source, visibly synthetic.
    expect(event.threadId).toBeNull()
    expect(event.sessionId).toBe(deriveSessionIdFromSource(ctx.source.id, 'seq-20'))
    expect(event.metadata?.session_id_synthetic).toBe(true)
  })

  it('turn_context can retarget the cwd for the records that follow it', async () => {
    const events = await normalizeAll('message-turns.jsonl')
    const before = events.find((e) => e.rawSeq === 2)
    const after = events.find((e) => e.rawSeq === 7)
    expect(before?.projectId).toBe('project:turns')
    expect(after?.projectId).toBe('project:nested')
    expect(after?.type).toBe('generation.end')
  })
})

describe('detect', () => {
  it('reports presence and the cli_version of the newest rollout file', async () => {
    const detection = await detect(storeCtx('host'))
    expect(detection.present).toBe(true)
    expect(detection.agentVersion).toBe('0.155.0')
  })

  it('an empty sessions store is present-with-no-files, not absent', async () => {
    const detection = await detect(storeCtx('host-empty'))
    expect(detection.present).toBe(true)
    expect(detection.agentVersion).toBeNull()
    expect(detection.reason).toContain('no rollout files')
  })

  it('a missing root reports present:false and never throws', async () => {
    const detection = await detect(storeCtx('no-such-store'))
    expect(detection).toMatchObject({ present: false })
    expect(detection.reason).toContain('no codex data root')
  })

  it('CODEX_HOME relocates the whole store', async () => {
    const base = storeCtx('host-noversion')
    expect(base.dataRoot).toContain('host-noversion')
    const moved = await detect({
      dataRoot: null,
      homedir: '/nonexistent',
      env: { CODEX_HOME: base.dataRoot ?? undefined },
      readFile: base.readFile,
      readDir: base.readDir,
      stat: base.stat,
    })
    expect(moved.present).toBe(true)
    expect(moved.agentVersion).toBeNull()
    expect(moved.reason).toContain('cli_version absent')
  })
})

/**
 * GET /api/doctor's Agents block (§11, §14).
 *
 * The point of these tests is the wiring, not the layout: adapters reach the
 * server ONLY through the injected `ServerDeps.adapters` (§5.4), because a
 * dynamic import from this package resolves to nothing and used to leave the web
 * Doctor claiming no adapter was installed while `agl doctor` listed five.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { harness } from './helpers.ts'

/** Any home under this path renders as `~`, which is what the rows report. */
const HOME = '/home/tester'

const policy: AggregationPolicy = { mode: 'request_max', subagentsIncluded: false }

function adapter(id: string, detect: AgentAdapter['detect']): AgentAdapter {
  return {
    id,
    displayName: id,
    parserVersion: 1,
    aggregation: policy,
    detect,
    // Doctor only ever calls `detect`; the rest is a cast, so this stays a wiring test.
  } as unknown as AgentAdapter
}

function present(id: string, detection: Awaited<ReturnType<AgentAdapter['detect']>>) {
  return adapter(id, async () => detection)
}

let h: ReturnType<typeof harness> | null = null
afterEach(() => {
  h?.close()
  h = null
})

const rowFor = (body: any, id: string) => body.agents.find((r: { id: string }) => r.id === id)

describe('GET /api/doctor agents', () => {
  it('lists ingested agents honestly when the host injects no adapters', async () => {
    h = harness()
    const { body } = await h.get('/api/doctor')
    expect(body.adaptersInstalled).toBe(false)
    const row = rowFor(body, 'claude-code')
    expect(row.status).toBe('ingested-only')
    expect(row.note).toContain('not installed in this build')
    expect(row.events).toBe(11)
  })

  it('runs detection over the injected adapter set instead of guessing from imports', async () => {
    h = harness({
      homedir: HOME,
      adapters: async () => [present('claude-code', { present: true, agentVersion: '1.2.3', dataRoot: `${HOME}/.claude` })],
    })
    const { body } = await h.get('/api/doctor')
    expect(body.adaptersInstalled).toBe(true)
    // One row per agent: the detected adapter replaces the ingested-only fallback.
    expect(body.agents.filter((r: { id: string }) => r.id === 'claude-code')).toHaveLength(1)
    expect(rowFor(body, 'claude-code')).toMatchObject({ status: 'ok', detectedVersion: '1.2.3', events: 11, sources: 2 })
    // The root travels redacted, and this machine's fake home is genuinely unreadable.
    expect(body.permissions).toEqual([{ path: '~/.claude', readable: false }])
    expect(rowFor(body, 'claude-code').dataRoot).toBe('~/.claude')
    expect(rowFor(body, 'claude-code').note).toContain('not readable')
  })

  it('keeps an absent adapter visible, and an adapter that throws as an error row', async () => {
    h = harness({
      homedir: HOME,
      adapters: async () => [
        present('codex', { present: false, reason: 'no ~/.codex here' }),
        adapter('opencode', async () => {
          throw new Error(`stat failed for ${HOME}/.local/share/opencode`)
        }),
      ],
    })
    const { body } = await h.get('/api/doctor')
    expect(rowFor(body, 'codex').status).toBe('not-detected')
    // An agent with history but no adapter in this run still shows up as ingested-only.
    expect(rowFor(body, 'claude-code').status).toBe('ingested-only')
    expect(rowFor(body, 'opencode').status).toBe('error')
    expect(rowFor(body, 'opencode').note).toBe('stat failed for ~/.local/share/opencode')
  })

  it('reports a present adapter without a data root as ok and no permission probe', async () => {
    h = harness({ homedir: HOME, adapters: async () => [present('claude-code', { present: true, dataRoot: null })] })
    const { body } = await h.get('/api/doctor')
    expect(body.adaptersInstalled).toBe(true)
    expect(rowFor(body, 'claude-code').status).toBe('ok')
    expect(rowFor(body, 'claude-code').dataRoot).toBe(null)
    expect(body.permissions).toEqual([])
  })
})

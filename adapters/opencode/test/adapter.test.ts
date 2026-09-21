/**
 * End-to-end over a throwaway host: detect → discover → parse → normalize, plus
 * the §18 row 1/3/4 assertions that make OpenCode the reference SQLite adapter.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { aggregateUsage, validateEvent } from '@agentlens/event-model'
import { openCodeAdapter } from '../src/index.ts'
import { buildHost, type BuiltHost } from '../fixtures/build-host.ts'
import { hostCtx, matchSnapshot, project, scanSource } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost()
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

describe('opencode adapter · detect + discover (§5.1)', () => {
  it('detects the store, reports the version from session.version, lists one source per table', async () => {
    await withHost(async (host) => {
      const detection = await openCodeAdapter.detect(hostCtx(host.dir))
      expect(detection.present).toBe(true)
      expect(detection.agentVersion).toBe('1.18.31')
      expect(detection.reason).toBeNull()
      expect(detection.dataRoot).toBe(host.dir)

      const sources: string[] = []
      for await (const spec of openCodeAdapter.discover(hostCtx(host.dir))) {
        sources.push(`${spec.kind}:${spec.sqliteTable}`)
        expect(spec.path).toBe(host.dbPath)
        expect(spec.sessionHint).toBeNull()
      }
      expect(sources).toEqual(['sqlite:session', 'sqlite:message', 'sqlite:part'])
    })
  })

  it('reports absence when the store is not there', async () => {
    const host = await buildHost()
    const dir = host.dir
    await host.close()
    const detection = await openCodeAdapter.detect(hostCtx(`${dir}/missing`))
    expect(detection.present).toBe(false)
    expect(detection.reason).toContain('no database')
  })

  it('honours XDG_DATA_HOME', async () => {
    const host = await buildHost({ subdir: join('xdg', 'opencode') })
    try {
      const ctx = hostCtx('/nonexistent', { XDG_DATA_HOME: join(host.dir, 'xdg') })
      const detection = await openCodeAdapter.detect(ctx)
      expect(detection.dataRoot).toBe(host.root)
      expect(detection.present).toBe(true)
      let sources = 0
      for await (const spec of openCodeAdapter.discover(ctx)) {
        sources++
        expect(spec.path).toBe(host.dbPath)
      }
      expect(sources).toBe(3)
    } finally {
      await host.close()
    }
  })
})

describe('opencode adapter · normalize (§18 rows 1/3/4)', () => {
  it('maps every session/message/part row into events that pass schema validation', async () => {
    await withHost(async (host) => {
      const all: AgentEvent[] = []
      let failures = 0
      for (const table of ['session', 'message', 'part']) {
        const scanned = await scanSource(host.dbPath, table)
        all.push(...scanned.events)
        failures += scanned.failures
        expect(scanned.tail.nextOffset).toBeGreaterThan(0)
      }
      expect(failures).toBe(0)
      for (const e of all) expect(validateEvent(e)).toEqual([])

      const byType = new Map<string, number>()
      for (const e of all) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
      expect([...byType.keys()].sort()).toEqual(
        [
          'context.compact',
          'error',
          'generation.end',
          'generation.start',
          'mcp.invoke',
          'message.assistant',
          'message.user',
          'session.end',
          'session.start',
          'subagent.start',
          'tool.result',
          'tool.start',
          'unknown',
        ].sort(),
      )
      // One row per turn anchor, so user turns stay countable (§3.3).
      expect(byType.get('message.user')).toBe(2)
    })
  })

  it('adopts reported cost as first-class and never mixes in a computed number', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const steps = events.filter((e) => e.type === 'generation.end')
      const priced = steps.find((e) => e.costReported !== null && e.costReported !== undefined)
      expect(priced?.costReported).toBe(0.031)
      expect(priced?.costSource).toBe('reported')
      for (const step of steps) {
        expect(step.costSource ?? 'none').not.toBe('computed')
      }
      // §8: a step without a cost stays NULL, never 0.
      const free = steps.find((e) => e.metadata?.finish_reason === undefined && e.costReported == null)
      expect(free?.costReported ?? null).toBeNull()
    })
  })

  it('maps the tokens_cache_* dialect without double counting cached input', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const step = events.find((e) => e.type === 'generation.end' && e.usage !== null && e.usage !== undefined)
      expect(step?.usage).toEqual({
        inputTokens: 1_100,
        outputTokens: 183,
        cacheReadTokens: 1_667,
        cacheWriteTokens: 0,
        reasoningTokens: 73,
      })
      // Measured invariant: tokens.total === input + output + reasoning + cache.read,
      // i.e. OpenCode's `input` already EXCLUDES cached tokens (Anthropic-style).
      const total = step?.metadata?.tokens_total_reported as number
      const u = step?.usage
      expect(u ? u.inputTokens + u.outputTokens + u.reasoningTokens + u.cacheReadTokens : 0).toBe(total)
      expect(u?.inputTokens).not.toBe((u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0))
    })
  })

  it('splits sessions and threads and links subagent sessions to their parent', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'session')
      const starts = events.filter((e) => e.type === 'session.start')
      const root = starts.find((e) => e.metadata?.parent_session_id == null)
      const child = starts.find((e) => e.metadata?.parent_session_id != null)
      expect(root).toBeDefined()
      expect(child).toBeDefined()
      // §18 row 3: thread_id is the native ULID, session_id the (root) product grain.
      expect(child?.threadId).toBe('ses_child000000000000000000B')
      expect(child?.metadata?.subagentThread).toBe(true)
      expect(root?.metadata?.subagentThread).toBeUndefined()
      const childGenerations = await scanSource(host.dbPath, 'part')
      const childEvents = childGenerations.events.filter((e) => e.threadId === 'ses_child000000000000000000B')
      expect(childEvents.length).toBeGreaterThan(0)
      expect(childEvents.every((e) => e.sessionId === child?.sessionId)).toBe(true)
    })
  })

  it('emits tool, MCP and subagent capabilities and never a hook event', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const start = (callId: string) => events.find((e) => e.metadata?.call_id === callId && e.type !== 'tool.result')
      expect(start('call_read_1')?.type).toBe('tool.start')
      expect(start('call_read_1')?.capability).toEqual({ type: 'tool', name: 'read', provider: null })
      expect(start('call_mcp_1')?.type).toBe('mcp.invoke')
      expect(start('call_mcp_1')?.capability).toEqual({ type: 'mcp', name: 'search_docs', provider: 'docs-mcp' })
      expect(start('call_task_1')?.type).toBe('subagent.start')
      expect(start('call_task_1')?.capability).toEqual({ type: 'subagent', name: 'explore', provider: 'task' })
      expect(events.some((e) => e.type === 'hook.fire')).toBe(false)
      const result = events.find((e) => e.type === 'tool.result' && e.metadata?.call_id === 'call_bash_1')
      expect(result?.durationMs).toBe(140)
      expect(result?.parentEventId).toBe(start('call_bash_1')?.id)
    })
  })

  it('keeps whole file snapshots out of the content layer (§3.2 / §6)', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const read = events.find((e) => e.type === 'tool.result' && e.metadata?.call_id === 'call_read_1')
      expect(read?.payload).toBeNull()
      expect(read?.metadata?.output_excluded).toBe(true)
      expect((read?.metadata?.output_chars as number) ?? 0).toBeGreaterThan(1_000)
      const edit = events.find((e) => e.metadata?.call_id === 'call_edit_1')
      expect(edit?.payload).toBeNull()
      expect(edit?.metadata?.input_excluded).toBe(true)
    })
  })

  it('declares the §18 row 2 fold and emits rows that satisfy it exactly', async () => {
    await withHost(async (host) => {
      expect(openCodeAdapter.aggregation).toEqual({ mode: 'per_record_sum', subagentsIncluded: false })
      const all: AgentEvent[] = []
      for (const table of ['session', 'message', 'part']) {
        all.push(...(await scanSource(host.dbPath, table)).events)
      }
      const steps = all.filter((e) => e.usage !== null && e.usage !== undefined)
      // Only `step-finish` rows carry usage; the session and message rollups stay in
      // metadata, so the fold has exactly one source of numbers.
      expect(steps.every((e) => e.type === 'generation.end')).toBe(true)
      const folded = aggregateUsage(all, openCodeAdapter.aggregation)
      expect(folded.groups).toBe(steps.length)
      expect(folded.usage.inputTokens).toBe(steps.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0))
      expect(folded.usage.cacheReadTokens).toBe(steps.reduce((n, e) => n + (e.usage?.cacheReadTokens ?? 0), 0))
      // A child session's step is additive work, not a number the parent already contains.
      expect(steps.some((e) => e.metadata?.subagentThread === true)).toBe(true)
      // Both folds agree, so the conservative default cannot inflate OpenCode rows.
      expect(aggregateUsage(all, { mode: 'request_max', subagentsIncluded: true }).usage).toEqual(folded.usage)
    })
  })

  it('matches the committed normalize snapshots', async () => {
    await withHost(async (host) => {
      for (const table of ['session', 'message', 'part'] as const) {
        const { events } = await scanSource(host.dbPath, table, 0, { stableIds: true })
        await matchSnapshot(`${table}.json`, project(events))
      }
    })
  })
})

describe('opencode adapter · capabilities (§5.1)', () => {
  it('reports an empty catalog because the store has no registry tables', async () => {
    await withHost(async (host) => {
      const catalogs = await openCodeAdapter.capabilities?.(hostCtx(host.dir))
      expect(catalogs).toEqual([])
    })
  })
})

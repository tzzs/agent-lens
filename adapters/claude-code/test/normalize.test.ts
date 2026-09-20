import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateEvent, type AgentEvent, type NormalizeResult } from '@agentlens/event-model'
import { isParseFailure } from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { UNATTRIBUTED_PROJECT_ID } from '../src/normalize.ts'
import { ctxFor, FIXTURES_DIR, matchSnapshot, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

const SCENARIOS = [
  'multi-block-usage.jsonl',
  'cli-host.jsonl',
  'desktop-host.jsonl',
  'entrypoint-drift.jsonl',
  'user-turn-mix.jsonl',
  'hook-fire.jsonl',
  'agent-subagent-chain.jsonl',
  'legacy-task-entry.jsonl',
  'synthetic-model.jsonl',
  'compact-boundary.jsonl',
  'api-error.jsonl',
  'stop-hook-summary.jsonl',
  'unknown-record-type.jsonl',
  'mcp-tool.jsonl',
  'skill-tool-path.jsonl',
  'skill-invoked-skills.jsonl',
  'skill-meta-injection.jsonl',
  'skill-command-name.jsonl',
  'skill-dedupe-two-paths.jsonl',
  'host-metadata.jsonl',
  'history-entry.jsonl',
  'prompt-snapshot.jsonl',
]

interface Projection {
  seq: number
  id: string
  type: string
  subtype: string | null
  hostId: string
  requestId: string | null
  capability: string | null
  usage: Record<string, number> | null
  usageSource: string
  durationMs: number | null
  status: string
  parentEventId: string | null
  model: string | null
  project: string
  payload: string | null
  rawInMetadata: boolean
}

function project(e: AgentEvent, ctxPath: string): Projection {
  return {
    seq: e.rawSeq,
    id: e.id.slice(0, 16),
    type: e.type,
    subtype: e.subtype ?? null,
    hostId: e.hostId,
    requestId: e.requestId ?? null,
    capability: e.capability ? `${e.capability.type}:${e.capability.name}:${e.capability.provider ?? ''}` : null,
    usage: e.usage ? { ...e.usage } : null,
    usageSource: e.usageSource,
    durationMs: e.durationMs ?? null,
    status: e.status,
    parentEventId: e.parentEventId ? `set:${e.parentEventId.slice(0, 8)}` : null,
    model: e.model?.name ?? null,
    project: e.projectId === UNATTRIBUTED_PROJECT_ID ? 'unattributed' : e.projectId,
    payload: e.payload ? `${e.payload.kind}:${e.payload.text.length}` : null,
    rawInMetadata: Boolean(e.metadata && 'raw' in e.metadata),
  }
}

async function runScenario(name: string): Promise<AgentEvent[]> {
  const ctx = ctxFor(name)
  resetStateFor(ctx)
  const records = recordsFromJsonl(await readFixture(name))
  const events: AgentEvent[] = []
  for (const record of records) {
    const result: NormalizeResult = await claudeCodeAdapter.normalize(record, ctx)
    if (isParseFailure(result)) {
      if (name !== 'parse-failure.jsonl') {
        throw new Error(`${name}: unexpected failure ${result.failure.reason}`)
      }
      continue
    }
    events.push(...result.events)
  }
  return events
}

describe('claude-code normalize snapshots', () => {
  it('fixtures directory contains every declared scenario', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.jsonl')).sort()
    for (const scenario of SCENARIOS) expect(files).toContain(scenario)
  })

  for (const name of SCENARIOS) {
    it(`${name} → stable event stream`, async () => {
      const events = await runScenario(name)
      const projected = events.map((e) => project(e, name))
      await matchSnapshot(`${name.replace(/\.jsonl$/, '')}.json`, projected)
      expect(projected.length).toBeGreaterThan(0)
    })
  }
})

describe('normalize contract', () => {
  it('every emitted event satisfies the event-model schema and has a unique id', async () => {
    const seen = new Set<string>()
    for (const name of SCENARIOS) {
      const events = await runScenario(name)
      for (const e of events) {
        expect(validateEvent(e), `${name}: ${validateEvent(e).join('; ')}`).toEqual([])
        expect(seen.has(e.id), `duplicate event id across ${name}`).toBe(false)
        seen.add(e.id)
      }
    }
  })

  it('unknown record types land in type "unknown" with the raw JSON in metadata (§5.3)', async () => {
    const events = await runScenario('unknown-record-type.jsonl')
    const unknown = events.find((e) => e.type === 'unknown' && e.subtype === 'telemetry-blob')
    expect(unknown).toBeDefined()
    expect(JSON.stringify(unknown?.metadata?.raw)).toContain('span')
    // The attachment we do recognise is still counted, never dropped (§5.2 rule 1).
    const planMode = events.find((e) => e.subtype === 'attachment:plan_mode')
    expect(planMode?.type).toBe('unknown')
    expect(planMode?.metadata?.mapped).toBe(true)
  })

  it('never payload a prompt_snapshot or file attachment body (§3.2)', async () => {
    const events = await runScenario('prompt-snapshot.jsonl')
    for (const e of events) {
      expect(e.payload).toBeNull()
      const raw = JSON.stringify(e.metadata ?? {})
      expect(raw.length).toBeLessThan(4096)
      expect(raw).not.toContain('deliberately long because')
    }
    const reminder = events.find((e) => e.subtype === 'attachment:total_tokens_reminder')
    expect(reminder?.metadata?.context_tokens).toBe(152340)
    const deferred = events.find((e) => e.subtype === 'attachment:deferred_tools_delta')
    expect(deferred?.metadata?.needs_auth_mcp_servers).toEqual(['linear'])
    const listing = events.find((e) => e.subtype === 'attachment:skill_listing')
    expect(listing?.metadata?.names).toEqual(['grill-with-docs', 'review-checklist', 'writing-great-skills'])
  })

  it('metadata records without cwd stay unattributed instead of borrowing the first record (§4.1)', async () => {
    const events = await runScenario('host-metadata.jsonl')
    expect(events.length).toBe(7)
    for (const e of events) {
      expect(e.projectId).toBe(UNATTRIBUTED_PROJECT_ID)
      expect(e.metadata?.project_unattributed).toBe(true)
    }
    const kept = events.filter((e) => ['pr-link', 'custom-title', 'ai-title', 'mode'].includes(String(e.subtype)))
    expect(kept.map((e) => e.subtype).sort()).toEqual(['ai-title', 'custom-title', 'mode', 'pr-link'])
    expect(kept.find((e) => e.subtype === 'pr-link')?.metadata?.value).toEqual({
      pr_number: 412,
      pr_url: 'https://forge.test/acme/alpha/pull/412',
    })
    expect(kept.find((e) => e.subtype === 'mode')?.metadata?.value).toEqual({ mode: 'plan' })
  })

  it('resolves the project from the record cwd when present (§4.1)', async () => {
    const events = await runScenario('cli-host.jsonl')
    for (const e of events) expect(e.projectId).toBe('project:alpha')
  })

  it('host-side records reuse the session hint when the record carries no sessionId', async () => {
    const ctx = ctxFor('cli-host.jsonl', 'native-hint-session')
    resetStateFor(ctx)
    const records = recordsFromJsonl((await readFixture('cli-host.jsonl')).replaceAll('"sess-cli-host"', 'null'))
    const result = await claudeCodeAdapter.normalize(records[0]!, ctx)
    expect(isParseFailure(result)).toBe(false)
    if (!isParseFailure(result)) expect(result.events[0]?.sessionId.length).toBe(64)
  })

  it('joins a multi-record scan state per source and rebuilds it on a rescan (§4.2)', async () => {
    const ctx = ctxFor('skill-dedupe-two-paths.jsonl')
    resetStateFor(ctx)
    const records = recordsFromJsonl(await readFixture('skill-dedupe-two-paths.jsonl'))
    const first = await claudeCodeAdapter.normalize(records[0]!, ctx)
    const second = await claudeCodeAdapter.normalize(records[1]!, ctx)
    if (isParseFailure(first) || isParseFailure(second)) throw new Error('unexpected failure')
    expect(first.events.filter((e) => e.type === 'skill.invoke')).toHaveLength(1)
    expect(second.events.filter((e) => e.type === 'skill.invoke')).toHaveLength(0)
    expect(second.events.find((e) => e.type === 'unknown')?.metadata?.suppressed).toBe('duplicate-skill-activation')

    // Replay from seq 1 (§4.2 idempotent rescan): the activation is emitted again.
    const replayed = await claudeCodeAdapter.normalize(records[0]!, ctx)
    if (isParseFailure(replayed)) throw new Error('unexpected failure')
    expect(replayed.events.filter((e) => e.type === 'skill.invoke')).toHaveLength(1)
  })
})

export function scenarioPath(name: string): string {
  return join(FIXTURES_DIR, name)
}

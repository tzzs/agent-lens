/**
 * §5.1 `discover` — every trace file becomes exactly one source, in a stable order,
 * with the filename uuid carried as the session hint.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SourceSpec } from '@agentlens/event-model'
import { discover, sessionHintOf, specFor } from '../src/index.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

async function specsOf(root: string): Promise<SourceSpec[]> {
  const out: SourceSpec[] = []
  for await (const spec of discover(hostCtx({ dataRoot: root }))) out.push(spec)
  return out
}

describe('discover', () => {
  it('finds both nested session files, deterministically ordered', async () => {
    const specs = await specsOf(HOST_DIR)
    expect(specs.map((s) => s.path)).toEqual([
      join(HOST_DIR, 'sessions/team/work-beta/2026-09-20T18-00-00-000Z_9e1c0000-0000-4000-8000-0000000000bb.jsonl'),
      join(HOST_DIR, 'sessions/work-alpha/2026-09-20T09-00-00-000Z_9e1c0000-0000-4000-8000-0000000000aa.jsonl'),
    ])
  })

  it('each spec is the frozen four-key shape with the filename uuid as hint', async () => {
    const specs = await specsOf(HOST_DIR)
    for (const spec of specs) {
      expect(Object.keys(spec).sort()).toEqual(['id', 'kind', 'path', 'sessionHint'])
      expect(spec.kind).toBe('jsonl')
      expect(spec.sessionHint).toMatch(/^9e1c0000-/)
      expect(spec.id).toBe(specFor(spec.path).id)
    }
    const ids = new Set(specs.map((s) => s.id))
    expect(ids.size).toBe(specs.length)
  })

  it('an empty or missing root discovers nothing without throwing', async () => {
    expect(await specsOf(join(FIXTURES_DIR, 'host-empty'))).toEqual([])
    expect(await specsOf(join(FIXTURES_DIR, 'no-such-root'))).toEqual([])
  })
})

describe('sessionHintOf', () => {
  it('reads the uuid tail of the measured file-name shape', () => {
    expect(sessionHintOf('/x/2026-05-29T12-44-14-706Z_019e73c3-1a2b-4c5d-8e9f-001122334455.jsonl')).toBe(
      '019e73c3-1a2b-4c5d-8e9f-001122334455',
    )
  })

  it('returns null for names that carry no uuid tail', () => {
    expect(sessionHintOf('/x/notes.jsonl')).toBeNull()
    expect(sessionHintOf('/x/2026-05-29T12-44-14-706Z_draft.jsonl')).toBeNull()
  })
})

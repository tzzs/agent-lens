/**
 * §八·5a — the sixth source on its own terms: `cli/agents/<parent>/agent_<id>/metadata.json`.
 *
 * What this file is trusted to protect are the two properties everything downstream rests on:
 * the document is read whole (it is pretty-printed JSON, so there is no line to resume from),
 * and the one key it carries that no other source has — `parentToolUseId` naming the spawning
 * `Agent` call — reaches the store verbatim so the shared linker can bind the chain to it. The
 * privacy rule is tested in the same breath because the same document holds the entire subagent
 * prompt: a field allowlist that fails here would leak a user's task text into `metadata`.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { deriveSourceId } from '@agentlens/event-model'
import { AGENT_ID, TABLE_AGENT_METADATA } from '../src/record.ts'
import { discoverAgentsSources, parseAgentsSource, spawnDirOf } from '../src/agents.ts'
import { zcodeAdapter } from '../src/index.ts'
import type { RawRecord } from '@agentlens/event-model'
import { PARSE_ERROR_KEY } from '@agentlens/event-model'
import {
  AGENT_SPAWN_CALL_ID,
  buildHost,
  CHILD_SESSION,
  FIXTURE_AGENT_RUNS,
  PROMPT_CANARY,
  SYSTEM_PROMPT_CANARY,
  type BuiltHost,
} from '../fixtures/build-host.ts'
import { ctxFor, hostCtx, matchSnapshot, project, scanAgentsSources, SNAPSHOT_AGENTS_PREFIX } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

describe('agents document discovery (§八·5a)', () => {
  it('yields one sorted source per document, with no sqliteTable on any of them', async () => {
    await withHost(async (host) => {
      const specs = []
      for await (const spec of discoverAgentsSources(hostCtx(host.dir))) specs.push(spec)
      expect(specs.map((s) => s.path)).toEqual([...host.agentRunPaths].sort())
      for (const spec of specs) {
        // §4.3: a `sqliteTable` on a file source sends the collector down the rowid path.
        expect(spec.kind).toBe('jsonl')
        expect(spec.sqliteTable ?? null).toBeNull()
        expect(spec.id).toBe(deriveSourceId(AGENT_ID, spec.path))
      }
      await host.close()
    })
  })

  it('finds nothing when ZCode never spawned, and does not treat that as an error', async () => {
    const host = await buildHost({ subdir: 'cli/db', noAgents: true })
    try {
      const specs = []
      for await (const spec of discoverAgentsSources(hostCtx(host.dir))) specs.push(spec)
      expect(specs).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('reads the spawn’s session off the directory name, not off a query', () => {
    expect(spawnDirOf('/h/cli/agents/sess_root_1/agent_a/metadata.json')).toBe('sess_root_1')
    // Anything that is not an `<agentDir>/metadata.json` under a session dir names no parent.
    expect(spawnDirOf('/h/cli/agents/sess_root_1/metadata.json')).toBeNull()
    expect(spawnDirOf('/h/cli/db/db.sqlite')).toBeNull()
  })
})

describe('framing one document (§4.3, §5.2 rule 1)', () => {
  it('ignores the resume offset and reports the bytes actually consumed', async () => {
    await withHost(async (host) => {
      const path = host.agentRunPaths[0]!
      const spec = { id: deriveSourceId(AGENT_ID, path), path, kind: 'jsonl' as const, sessionHint: null }
      const bytes = (await readFile(path)).byteLength
      // A rewritten document has no line boundary at the old size, so an append resume would
      // parse from mid-file. Re-reading is what keeps the replay deterministic (§4.2).
      const stream = parseAgentsSource(spec, ctxFor(spec, null))
      const first = await stream.next()
      expect(first.done).toBe(false)
      const record = first.value as RawRecord
      expect(record.seq).toBe(1)
      expect(record.offset).toBe(bytes)
      const tail = await stream.next()
      expect(tail.done).toBe(true)
      expect(tail.value).toEqual({ nextOffset: bytes, nextSeq: 2 })
      await host.close()
    })
  })

  it('counts an undecodable document instead of dropping it, without echoing its body', async () => {
    const host = await buildHost({ subdir: 'cli/db', agentRuns: [{ ...FIXTURE_AGENT_RUNS[0]! }] })
    try {
      const path = host.agentRunPaths[0]!
      // A body that WOULD be leaked if the marker echoed it: agents documents carry the whole
      // subagent prompt, so an undecodable one is described, not reproduced (§八·5a, §六).
      const body = `{ "prompt": "${PROMPT_CANARY}", not json`
      await writeFile(path, body, 'utf8')
      const spec = { id: deriveSourceId(AGENT_ID, path), path, kind: 'jsonl' as const, sessionHint: null }
      const stream = parseAgentsSource(spec, ctxFor(spec, null))
      const first = await stream.next()
      const framed = (first.value as RawRecord).value as { [PARSE_ERROR_KEY]?: string; rawLine?: string }
      expect(String(framed[PARSE_ERROR_KEY])).toContain('undecodable')
      // The marker states how much was there without reproducing any of it.
      expect(String(framed[PARSE_ERROR_KEY])).toContain(`(${Buffer.byteLength(body)}B)`)
      expect(framed.rawLine).not.toContain(PROMPT_CANARY)
      const { events, failures } = await scanAgentsSources(host.dir)
      expect(events).toEqual([])
      expect(failures).toBe(1)
    } finally {
      await host.close()
    }
  })
})

describe('the closing row the linker binds to (§八·5b)', () => {
  it('names the spawn by its raw call id, and carries no usage of its own', async () => {
    await withHost(async (host) => {
      const { events } = await scanAgentsSources(host.dir)
      const close = events.find((e) => e.type === 'subagent.end')
      expect(close).toBeDefined()
      expect(close?.metadata).toMatchObject({
        native_session_id: CHILD_SESSION,
        parent_source: 'foreign-key',
        linked_parent: AGENT_SPAWN_CALL_ID,
        status: 'completed',
        spawn_dir: 'sess_fixture_root_0000000001',
      })
      // §三 copy #5: the document's own token totals stay evidence, never a second billing.
      expect(close?.usage).toBeNull()
      expect(close?.costReported).toBeNull()
      expect(close?.costSource).toBe('none')
      expect(close?.metadata?.rollup).toMatchObject({ totalTokens: 5_200, totalToolUseCount: 3 })
      // The row is flagged as a subagent fact, which is what keeps it inside its chain's thread
      // tree for the cube's subagent switch (§18 row 3).
      expect(close?.metadata?.subagentThread).toBe(true)
      await host.close()
    })
  })

  it('links nothing from a document missing the spawn key, and says which key is absent', async () => {
    await withHost(async (host) => {
      const { events } = await scanAgentsSources(host.dir)
      const drift = events.filter((e) => e.type === 'unknown')
      expect(drift).toHaveLength(1)
      const [row] = drift
      expect(row?.subtype).toBe('metadata-missing-parent-tool-use-id')
      expect(row?.metadata).toMatchObject({ link_keys_absent: ['parent-tool-use-id'] })
      // No `parent_source` at all: a row the linker might read as a proof must be a proof.
      expect(row?.metadata?.parent_source).toBeUndefined()
      await host.close()
    })
  })

  it('keeps the prompt and the profile snapshot out of every emitted row (§八·5a)', async () => {
    await withHost(async (host) => {
      const { events } = await scanAgentsSources(host.dir)
      const serialized = JSON.stringify(project(events))
      expect(serialized).not.toContain(PROMPT_CANARY)
      expect(serialized).not.toContain(SYSTEM_PROMPT_CANARY)
      // The absolute paths in the document are no leak either, but the canary check is the one
      // that would catch a regression in the field allowlist.
      expect(serialized).not.toContain('synthetic delegation prompt')
      await host.close()
    })
  })

  it('matches the committed snapshot of the agents projection (§5.3)', async () => {
    await withHost(async (host) => {
      const { events } = await scanAgentsSources(host.dir, { stableIds: true })
      // Machine-independent ids, for the same reason the store snapshots pin a fixed path:
      // `mkdtemp` is not data, so a snapshot may not depend on it.
      for (const e of events) expect(e.sourceId).not.toContain(host.dir)
      await matchSnapshot('agents.json', project(events))
      await host.close()
    })
  })
})

describe('the spawn the pool looks for (§八·5b)', () => {
  it('is a tool.start under a subagent capability, keyed by the same raw call id', async () => {
    await withHost(async (host) => {
      const { byTable } = await (await import('./helpers.ts')).scanAll(host.dbPath, { dataRoot: host.dir })
      const parts = byTable.get('part') ?? []
      const spawn = parts.find((e) => e.metadata?.call_id === AGENT_SPAWN_CALL_ID)
      expect(spawn?.type).toBe('tool.start')
      expect(spawn?.capability).toMatchObject({ type: 'subagent', name: 'general-purpose', provider: 'Agent' })
      // The chain marker is still the child session's own row, from another source.
      const chains = byTable.get('session')?.filter((e) => e.type === 'subagent.start') ?? []
      expect(chains.map((e) => e.metadata?.native_session_id)).toContain(CHILD_SESSION)
      // And the two speak the same key, which is the whole join: the pool the linker reads is
      // keyed by session, so the close must also land in the chain's own session bucket.
      const close = byTable.get(TABLE_AGENT_METADATA)?.find((e) => e.type === 'subagent.end')
      const chain = chains.find((e) => e.metadata?.native_session_id === CHILD_SESSION)
      expect(close?.metadata?.linked_parent).toBe(spawn?.metadata?.call_id)
      expect(close?.sessionId).toBe(chain?.sessionId)
      await host.close()
    })
  })
})

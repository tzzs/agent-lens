/**
 * §5.1 `discover`: a deterministic source list. `source_id` is derived from the path, so a
 * walk that returned files in a different order would re-ingest the whole store; the
 * ordering test below is what keeps incremental scanning cheap.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveSourceId, type SourceSpec } from '@agentlens/event-model'
import { discover, ROLLOUT_PATTERN } from '../src/index.ts'
import { SESSION_DIRS, threadHintFromPath } from '../src/paths.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

async function collect(ctx: Parameters<typeof discover>[0]): Promise<SourceSpec[]> {
  const out: SourceSpec[] = []
  for await (const spec of discover(ctx)) out.push(spec)
  return out
}

describe('discover (§5.1)', () => {
  it('finds every rollout file under both session roots, sorted and deduplicated', async () => {
    const specs = await collect(hostCtx())
    const paths = specs.map((s) => s.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths.map((p) => basename(p)).sort()).toEqual([
      'rollout-2026-09-10T08-00-00-01JARCHBBBBBBBBBBBBBBBBBBBB.jsonl',
      'rollout-2026-09-15T09-00-00-01JHOSTTREEAAAAAAAAAAAAAA.jsonl',
      'rollout-2026-09-16T09-00-00-01JHOSTCHAINBBBBBBBBBBBB.jsonl',
    ])
    // archived threads carry real usage: dropping them would under-report (§18 row 3)
    expect(paths.some((p) => p.includes('archived_sessions'))).toBe(true)
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length)
  })

  it('source specs are pure functions of the path, so two runs agree exactly', async () => {
    const first = await collect(hostCtx())
    const second = await collect(hostCtx())
    expect(second).toEqual(first)
    for (const spec of first) {
      expect(spec.id).toBe(deriveSourceId('codex', spec.path))
      expect(spec.kind).toBe('jsonl')
      // §18 row 3: the hint is the THREAD token from the filename, never a session id
      expect(spec.sessionHint).toBe(threadHintFromPath(spec.path))
      expect(spec.sessionHint).toMatch(/^01J/)
      expect(spec.path.startsWith(HOST_DIR)).toBe(true)
    }
    expect(SESSION_DIRS).toEqual(['sessions', 'archived_sessions'])
    expect(ROLLOUT_PATTERN).toBe('rollout-*.jsonl')
  })

  it('non-rollout files, other extensions and symlinks are never discovered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-codex-discover-'))
    try {
      const sessions = join(dir, 'sessions', '2026', '09', '20')
      await mkdir(sessions, { recursive: true })
      await writeFile(join(sessions, 'rollout-2026-09-20T09-00-00-01JDISCOVERAAAAAAAAAAAAAA.jsonl'), '{}\n', 'utf8')
      await writeFile(join(sessions, 'rollout-2026-09-20T09-10-00-01JDISCOVERBBBBBBBBBBBBB.JSONL'), '{}\n', 'utf8')
      await writeFile(join(sessions, 'notes.txt'), 'not a rollout\n', 'utf8')
      await writeFile(join(dir, 'rollout-2026-09-20T09-20-00-01JOUTSIDECCCCCCCCCCCCCC.jsonl'), '{}\n', 'utf8')
      const archived = join(dir, 'archived_sessions', '2026', '09', '19')
      await mkdir(archived, { recursive: true })
      await writeFile(join(archived, 'rollout-2026-09-19T09-00-00-01JARCHIVEDDDEEEEEEEEEEE.jsonl'), '{}\n', 'utf8')
      await writeFile(join(archived, 'rollout-2026-09-19T09-30-00-part.jsonl.bak'), '', 'utf8')
      // a link loop must not trap the walk (collector never follows symlinks)
      await symlink(join(dir, 'sessions'), join(dir, 'loop')).catch(() => undefined)

      const specs = await collect(hostCtx({ dataRoot: dir, homedir: dir }))
      expect(specs.map((s) => basename(s.path)).sort()).toEqual([
        'rollout-2026-09-19T09-00-00-01JARCHIVEDDDEEEEEEEEEEE.jsonl',
        'rollout-2026-09-20T09-00-00-01JDISCOVERAAAAAAAAAAAAAA.jsonl',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absent store and a root with no rollout files both discover nothing, quietly', async () => {
    const missing = hostCtx({ dataRoot: join(HOST_DIR, 'no-such-dir'), homedir: join(HOST_DIR, 'no-such-dir') })
    expect(await collect(missing)).toEqual([])
    const emptyRoot = join(FIXTURES_DIR, 'host-empty')
    expect(await collect(hostCtx({ dataRoot: emptyRoot, homedir: emptyRoot }))).toEqual([])
  })

  it('CODEX_HOME relocates discovery', async () => {
    const noversion = join(FIXTURES_DIR, 'host-noversion')
    const specs = await collect(hostCtx({ dataRoot: noversion, homedir: noversion }))
    expect(specs.map((s) => basename(s.path))).toEqual(['rollout-2026-09-17T09-00-00-01JNOVERSIONUUUUUUUUUUUUUU.jsonl'])
    const relocated = await collect(hostCtx({ dataRoot: '', homedir: '/nonexistent', env: { CODEX_HOME: HOST_DIR } }))
    expect(relocated).toEqual(await collect(hostCtx()))
  })
})

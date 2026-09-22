/**
 * §16: the metric layer ships with the content layer off, and `cwd` is metric-layer provenance
 * (a project attribution needs it, §4.1). If it crosses the wire verbatim, every path the store
 * knows about reaches the browser with the user's home directory spelled out — the same fact
 * `coverage` and `dbPath` already paint as `~`. Pinned here because the redaction is easy to
 * bypass by answering a timeline from raw rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { redactMetadata } from '../src/resolve.ts'
import { harness, type Harness } from './helpers.ts'

describe('redactMetadata (§16)', () => {
  it('paints home in scalars, nested objects and arrays', () => {
    const out = redactMetadata(
      { cwd: '/home/dev/work/repo', nested: { path: '/home/dev/secrets' }, list: ['/home/dev/a', 'plain'], n: 3 },
      '/home/dev',
    )
    expect(out).toEqual({ cwd: '~/work/repo', nested: { path: '~/secrets' }, list: ['~/a', 'plain'], n: 3 })
  })

  it('leaves metadata alone when there is no home to paint, and drops what it cannot walk', () => {
    expect(redactMetadata({ cwd: '/home/dev/x' }, '')).toEqual({ cwd: '/home/dev/x' })
    // Deeper than the documented shapes: fail closed, because serving the unvisited subtree
    // unredacted is the leak this function exists to prevent.
    const deep = { a: { b: { c: { d: '/home/dev/secret' } } } }
    expect(JSON.stringify(redactMetadata(deep, '/home/dev', 1))).not.toContain('/home/dev')
  })
})

describe('GET /api/sessions/:id serves painted paths', () => {
  let h: Harness
  beforeAll(async () => {
    h = harness()
    const home = h.seeded.dir
    h.seeded.db
      .prepare("UPDATE events SET metadata = ? WHERE id = 'e1'")
      .run(JSON.stringify({ cwd: `${home}/work/repo`, hint: { project: home } }))
  })
  afterAll(() => h.close())

  it('never lets the store directory reach the response body', async () => {
    const body = JSON.stringify(await h.get('/api/sessions/sess-aaaa1111').then((r) => r.body))
    expect(body).not.toContain(h.seeded.dir)
    expect(body).toContain('~/work/repo')
    // The other fields on the row are untouched by the walk.
    const node = (await h.get('/api/sessions/sess-aaaa1111')).body.nodes.find((n: { id: string }) => n.id === 'e1')
    expect(node.metadata.hint.project).toBe('~')
  })
})

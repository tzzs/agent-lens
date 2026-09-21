/**
 * §5.2 rule 3, proven mechanically: running the full read path
 * (detect → discover → parse → normalize) over the fixture tree must not
 * create, modify or delete a single file.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilities } from '../src/capabilities.ts'
import { detect } from '../src/detect.ts'
import { discover } from '../src/discover.ts'
import { normalize } from '../src/normalize.ts'
import { parse } from '../src/parse.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

interface TreeSnapshot {
  [path: string]: { size: number; mtimeMs: number; ino: number }
}

async function snapshotTree(dir: string, prefix = ''): Promise<TreeSnapshot> {
  const out: TreeSnapshot = {}
  for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${prefix}/${ent.name}`
    const full = join(dir, ent.name)
    if (ent.isDirectory()) Object.assign(out, await snapshotTree(full, rel))
    else {
      const s = await stat(full)
      out[rel] = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }
    }
  }
  return out
}

describe('read-only proof (§5.2 rule 3)', () => {
  it('scanning the fixture tree creates or modifies nothing', async () => {
    const before = await snapshotTree(HOST_DIR)
    const ctx = hostCtx({ dataRoot: HOST_DIR })

    await detect(ctx)
    await capabilities(ctx)
    for await (const source of discover(ctx)) {
      const parseCtx = { source, agentId: 'qoder', hostId: 'qoder' }
      const normCtx = {
        ...parseCtx,
        resolveProject: () => null,
        now: () => 1,
      }
      const it = parse(source, { offset: 0 }, parseCtx)
      while (true) {
        const r = await it.next()
        if (r.done) break
        await normalize(r.value, normCtx)
      }
    }

    const after = await snapshotTree(HOST_DIR)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    for (const [path, meta] of Object.entries(before)) {
      expect(after[path]).toEqual(meta)
    }
  })
})

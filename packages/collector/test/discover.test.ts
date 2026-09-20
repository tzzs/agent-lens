import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { walkForFiles } from '../src/discover.ts'

let currentTmp: string | null = null

async function setupTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'collector-disc-'))
  currentTmp = root
  await writeFile(join(root, 'b.jsonl'), '')
  await writeFile(join(root, 'a.jsonl'), '')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'c.jsonl'), '')
  await writeFile(join(root, 'sub', 'z.txt'), '')
  await mkdir(join(root, 'sub', 'deep'))
  await writeFile(join(root, 'sub', 'deep', 'd.jsonl'), '')
  await writeFile(join(root, 'old.jsonl'), '')
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000)
  await utimes(join(root, 'old.jsonl'), old, old)
  // A symlinked directory cycle: must be ignored, never followed.
  await symlink(root, join(root, 'loop'))
  await symlink(join(root, 'a.jsonl'), join(root, 'link.jsonl'))
  return root
}

afterEach(async () => {
  if (currentTmp) await rm(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

async function drain(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const p of it) out.push(p)
  return out
}

describe('walkForFiles', () => {
  it('recursive, deterministic (sorted), string-glob and RegExp patterns', async () => {
    const root = await setupTree()
    const found = await drain(walkForFiles(root, { pattern: '*.jsonl' }))
    expect(found).toEqual([
      join(root, 'a.jsonl'),
      join(root, 'b.jsonl'),
      join(root, 'old.jsonl'),
      join(root, 'sub', 'c.jsonl'),
      join(root, 'sub', 'deep', 'd.jsonl'),
    ])
    const sameAgain = await drain(walkForFiles(root, { pattern: /\.jsonl$/ }))
    expect(sameAgain).toEqual(found)
  })

  it('never follows symlinks (no cycle, no link files)', async () => {
    const root = await setupTree()
    const found = await drain(walkForFiles(root, { pattern: '*' }))
    expect(found).not.toContain(join(root, 'link.jsonl'))
    expect(found.filter((p) => p.includes('loop'))).toEqual([])
  })

  it('since filters by mtime', async () => {
    const root = await setupTree()
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000
    const found = await drain(walkForFiles(root, { pattern: '*.jsonl', since: cutoff }))
    expect(found).not.toContain(join(root, 'old.jsonl'))
    expect(found).toContain(join(root, 'a.jsonl'))
  })

  it('missing root yields nothing rather than throwing', async () => {
    const found = await drain(walkForFiles('/nope/missing-root-xyz', { pattern: '*' }))
    expect(found).toEqual([])
  })
})

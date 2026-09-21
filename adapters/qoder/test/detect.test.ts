/**
 * `detect` presence/version reporting — absent or unreadable stores return
 * `{present:false, reason}` and never throw (§5.1).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detect } from '../src/detect.ts'
import { HOST_DIR, hostCtx } from './helpers.ts'

const tmp = await mkdtemp(join(tmpdir(), 'qoder-detect-'))
afterAll(() => rm(tmp, { recursive: true, force: true }))

describe('detect', () => {
  it('reports presence and the record-carried version on the fixture host', async () => {
    const d = await detect(hostCtx({ dataRoot: HOST_DIR }))
    expect(d.present).toBe(true)
    expect(d.agentVersion).toMatch(/^1\.9\.\d+$/)
    expect(d.dataRoot).toBe(HOST_DIR)
  })

  it('absent root ⇒ present:false with a reason, no throw', async () => {
    const d = await detect(hostCtx({ dataRoot: join(tmp, 'nope') }))
    expect(d.present).toBe(false)
    expect(d.reason).toContain('no projects directory')
  })

  it('present but empty projects dir ⇒ present:true + retention reason (§4.4 row 4)', async () => {
    const root = join(tmp, 'empty-host')
    await mkdir(join(root, 'projects'), { recursive: true })
    const d = await detect(hostCtx({ dataRoot: root }))
    expect(d.present).toBe(true)
    expect(d.agentVersion).toBeNull()
    expect(d.reason).toContain('no session files')
  })

  it('files without a version field ⇒ version null + explanatory reason', async () => {
    const root = join(tmp, 'noversion')
    await mkdir(join(root, 'projects', 'slug'), { recursive: true })
    await writeFile(
      join(root, 'projects', 'slug', 's1.jsonl'),
      '{"type":"user","sessionId":"s1","message":{"role":"user","content":"x"}}\n',
    )
    const d = await detect(hostCtx({ dataRoot: root }))
    expect(d.present).toBe(true)
    expect(d.agentVersion).toBeNull()
    expect(d.reason).toContain('version field absent')
  })

  it('QODER_CONFIG_DIR override is honoured only when absolute', async () => {
    const d = await detect(hostCtx({ env: { QODER_CONFIG_DIR: HOST_DIR }, dataRoot: join(tmp, 'ignored') }))
    expect(d.present).toBe(true)
    expect(d.dataRoot).toBe(HOST_DIR)
    const rel = await detect(hostCtx({ env: { QODER_CONFIG_DIR: 'relative/path' }, dataRoot: join(tmp, 'nope') }))
    expect(rel.present).toBe(false)
  })
})

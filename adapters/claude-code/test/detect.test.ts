/**
 * §5.1 `detect`: presence, best-effort upstream version, and an honest reason.
 * Everything runs off the fixture tree, so a developer without `~/.claude` still
 * gets the same result.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostContext } from '@agentlens/event-model'
import { claudeCodeAdapter } from '../src/index.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

const NOVERSION_ROOT = join(FIXTURES_DIR, 'host-noversion')
const EMPTY_ROOT = join(FIXTURES_DIR, 'host-empty')

describe('detect', () => {
  it('reports presence and the newest record version', async () => {
    const detection = await claudeCodeAdapter.detect(hostCtx())
    expect(detection.present).toBe(true)
    expect(detection.agentVersion).toBe('2.1.275')
    expect(detection.dataRoot).toBe(HOST_DIR)
    expect(detection.reason).toBeNull()
  })

  it('honours CLAUDE_CONFIG_DIR over the host-supplied data root', async () => {
    const ctx: HostContext = { ...hostCtx(), dataRoot: join(HOST_DIR, 'nope'), env: { CLAUDE_CONFIG_DIR: HOST_DIR } }
    const detection = await claudeCodeAdapter.detect(ctx)
    expect(detection.present).toBe(true)
    expect(detection.dataRoot).toBe(HOST_DIR)
    expect(detection.agentVersion).toBe('2.1.275')
  })

  it('ignores a relative CLAUDE_CONFIG_DIR', async () => {
    const ctx: HostContext = { ...hostCtx(), env: { CLAUDE_CONFIG_DIR: 'relative/path' } }
    expect((await claudeCodeAdapter.detect(ctx)).dataRoot).toBe(HOST_DIR)
  })

  it('a missing store reports present:false with a reason, no throw', async () => {
    const detection = await claudeCodeAdapter.detect(hostCtx({ dataRoot: join(HOST_DIR, 'nope') }))
    expect(detection.present).toBe(false)
    expect(detection.agentVersion).toBeNull()
    expect(detection.reason).toContain('no projects directory')
  })

  it('an existing but empty store is present and explains why (§4.4 row 4)', async () => {
    const detection = await claudeCodeAdapter.detect(hostCtx({ dataRoot: EMPTY_ROOT }))
    expect(detection.present).toBe(true)
    expect(detection.agentVersion).toBeNull()
    expect(detection.reason).toContain('no session files')
  })

  it('falls back to the install hint when records carry no version', async () => {
    const detection = await claudeCodeAdapter.detect(hostCtx({ dataRoot: NOVERSION_ROOT }))
    expect(detection.present).toBe(true)
    expect(detection.agentVersion).toBe('native')
  })

  it('a throwing stat never crashes detection (§5.2 rule 1)', async () => {
    const ctx: HostContext = {
      ...hostCtx(),
      async stat() {
        throw new Error('EACCES: operation not permitted')
      },
    }
    const detection = await claudeCodeAdapter.detect(ctx)
    expect(detection.present).toBe(false)
    expect(detection.reason).toContain('no projects directory')
  })
})

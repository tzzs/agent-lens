/**
 * §5.1 `detect` — presence from the sessions directory alone, version from the only
 * version marker the census found, and honest reasons when either is missing.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/index.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

describe('detect', () => {
  it('a populated fixture root is present, versioned through settings.json', async () => {
    const d = await detect(hostCtx())
    expect(d.present).toBe(true)
    expect(d.agentVersion).toBe('0.85.1-fixture')
    expect(d.dataRoot).toBe(HOST_DIR)
    expect(d.reason).toContain('2 session file(s)')
  })

  it('an empty sessions directory is still an install (upstream retention)', async () => {
    const root = join(FIXTURES_DIR, 'host-empty')
    const d = await detect(hostCtx({ dataRoot: root }))
    expect(d.present).toBe(true)
    expect(d.reason).toContain('no session traces')
    expect(d.agentVersion).toBeNull()
  })

  it('no sessions directory at all means not installed, and says where it looked', async () => {
    const d = await detect(hostCtx({ dataRoot: join(FIXTURES_DIR, 'no-such-root') }))
    expect(d.present).toBe(false)
    expect(d.reason).toContain(join(FIXTURES_DIR, 'no-such-root', 'sessions'))
  })

  it('unreadable or malformed settings degrade to an unknown version, not a failure', async () => {
    const d = await detect(hostCtx({ readFile: async () => 'this is not json' }))
    expect(d.present).toBe(true)
    expect(d.agentVersion).toBeNull()
    expect(d.reason).toContain('agentVersion unknown')
  })
})

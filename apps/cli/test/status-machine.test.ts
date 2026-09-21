/**
 * `agl status` end to end for the §2 Machine tier: the real command through the real
 * `runCli`, a throwaway temp database, a sandbox homedir so no adapter sees this
 * machine's real agent stores. All ids are runtime UUIDs; no host-identifying value is
 * written into this file — the two privacy assertions READ them at runtime to prove
 * they are absent from the output.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const tmp = mkdtempSync(join(tmpdir(), 'agentlens-status-machine-'))
const dbPath = join(tmp, 'agentlens.db')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

async function status(): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const ctx: Ctx = {
    argv: ['status', '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
  }
  return { code: await runCli(ctx), lines }
}

function machineIdFrom(lines: string[]): string {
  const i = lines.indexOf('Machine')
  expect(i, `no Machine section in:\n${lines.join('\n')}`).toBeGreaterThanOrEqual(0)
  return lines[i + 1]!.trim()
}

describe('agl status · machine identity (§2)', () => {
  it('first run mints a random uuid and prints it with its privacy label', async () => {
    const { code, lines } = await status()
    expect(code).toBe(0)
    const id = machineIdFrom(lines)
    expect(id).toMatch(UUID_RE)
    const out = lines.join('\n')
    expect(out).toContain('Not a hostname, not a user') // §16: what it is NOT, said up front
    expect(out).toContain('never transmitted')
    // The label must be true, not just printed: the machine line carries no host identity.
    expect(out).not.toContain(hostname())
    const stored = openDatabase(dbPath, { readonly: true })
    try {
      const rows = stored.prepare('SELECT id FROM machine').all()
      expect(rows).toHaveLength(1)
      expect(String(rows[0]!.id)).toBe(id)
    } finally {
      stored.close()
    }
  })

  it('second run prints the identical id — stable across processes', async () => {
    const first = machineIdFrom((await status()).lines)
    const second = machineIdFrom((await status()).lines)
    expect(second).toBe(first)
  })
})

/**
 * §9's `--port`. The dashboard port was a constant, so a second instance could only be started
 * by guessing which process to kill, and the refusal said "stop it first" with no control
 * attached. Three things are pinned here:
 *
 *  - the flag binds the number it names, and the server on that port answers for THIS store —
 *    `/api/health` echoes `dbPath`, which is the assertion that caught a browser check reading
 *    a stranger's AgentLens and calling it a pass (§19);
 *  - a value outside the bindable range is a usage error, not a socket exception from inside
 *    the HTTP layer;
 *  - the collision message names `--port`, because a warning nobody can settle is noise.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@agentlens/storage'
import { CLI_FLAG_SCHEMA, FlagView, UsageError, parseArgs } from '../src/args.ts'
import { queryDeps } from '../src/context.ts'
import type { Ctx } from '../src/context.ts'
import { serveDashboard } from '../src/serve.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agl-port-'))
const dbPath = join(tmp, 'agentlens.db')
let db: ReturnType<typeof openDatabase>

beforeAll(() => {
  db = openDatabase(dbPath)
  migrate(db)
})
afterAll(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ctx: Ctx = {
  argv: [],
  out: () => {},
  err: () => {},
  // Not `tmp`: `/api/health` redacts the store path against the home dir it
  // serves, and the assertion below wants the real one to compare with.
  homedir: '/home/agl-port-tester',
  env: {},
  now: () => Date.UTC(2026, 8, 21),
  interactive: false, // no browser from a test run
}

const flagsFor = (...pairs: [string, string][]): ReturnType<typeof parseArgs>['flags'] =>
  new FlagView(Object.fromEntries(pairs), CLI_FLAG_SCHEMA)

/** Ask the OS for a free port, then release it. Racy by nature, so the test retries once. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('agl --port (§9)', () => {
  it('binds the number it is given, and that port serves THIS store', async () => {
    const port = await freePort()
    const handle = await serveDashboard(db, dbPath, flagsFor(['port', String(port)]), ctx, queryDeps(db, dbPath, ctx))
    try {
      expect(handle.url).toBe(`http://127.0.0.1:${port}`)
      const health = (await (await fetch(`${handle.url}/api/health`)).json()) as { dbPath: string; status: string }
      // The ownership assertion: a port somebody else holds would answer with their dbPath.
      expect(health.status).toBe('ok')
      expect(health.dbPath).toBe(dbPath)
    } finally {
      await handle.close()
    }
  })

  it('refuses a port it cannot bind, and names --port as the way out', async () => {
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const port = (taken.address() as AddressInfo).port
    try {
      await expect(
        serveDashboard(db, dbPath, flagsFor(['port', String(port)]), ctx, queryDeps(db, dbPath, ctx)),
      ).rejects.toThrow(/--port/)
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()))
    }
  })

  for (const bad of ['0', '70000', '80.5', 'nope']) {
    it(`rejects --port ${bad} before touching a socket`, async () => {
      // Through the real entry point, so the assertion is about the code that ships and not
      // about a copy of its bounds written here.
      await expect(
        serveDashboard(db, dbPath, flagsFor(['port', bad]), ctx, queryDeps(db, dbPath, ctx)),
      ).rejects.toThrow(UsageError)
    })
  }
})

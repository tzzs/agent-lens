/**
 * The one server test that has to touch a socket, because the defect is about binding one:
 * `startServer` used to resolve its bind failure into silence, so a caller that printed the URL
 * sent the user to whatever ELSE owned the port. Every other route test drives the app in
 * process (`helpers.ts`) and cannot see this.
 */
import { createServer } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/serve.ts'

/** Hand back a port nobody holds; the race window is the test's own bind, immediately after. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      probe.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })
}

describe('startServer reports a bind it did not win (§13)', () => {
  let holder: Awaited<ReturnType<typeof startServer>> | null = null

  afterAll(async () => {
    await holder?.close()
    holder = null
  })

  it('rejects ready() with EADDRINUSE and closes cleanly, while the owner keeps serving', async () => {
    const port = await freePort()
    holder = startServer({ port, host: '127.0.0.1' })
    await holder.ready()

    const loser = startServer({ port, host: '127.0.0.1' })
    const err = await loser.ready().then(() => null, (e: unknown) => e as NodeJS.ErrnoException)
    expect(err?.code, `binding port ${port} twice should not look like success`).toBe('EADDRINUSE')
    // The failure must not strand the caller in `Server is not running.` on the way out.
    await expect(loser.close()).resolves.toBeUndefined()

    const res = await fetch(`${holder.url}/api/health`)
    expect(res.status).toBe(200)
  })
})

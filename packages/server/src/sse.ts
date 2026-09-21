/**
 * GET /api/events — SSE frame writer (§13). One `hello` frame on connect, then a
 * `change` frame whenever the tick moves, plus a `:` comment every 15s so proxy
 * and browser idle timers keep the connection. `?since=<ms>` drops ticks that
 * the client already has.
 */
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { ChangeTick, ServerCtx } from './types.ts'
import { SSE_KEEPALIVE_MS } from './changes.ts'

const POLL_STEP_MS = 250

export function eventsStream(ctx: ServerCtx, c: Context): Response {
  const sp = new URL(c.req.url).searchParams
  const sinceRaw = sp.get('since')
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw)
  if (since !== null && !Number.isFinite(since)) {
    return c.json({ error: { kind: 'bad_request', message: `since must be a ms epoch number, got ${JSON.stringify(sinceRaw)}` } }, 400)
  }

  return streamSSE(
    c,
    async (stream) => {
      const source = ctx.changeSource()
      // A queue rather than a single slot: TS narrowing aside, the poller can
      // fire twice between two writes and the client should see both ticks.
      const queue: ChangeTick[] = []
      const stop = source.watch((tick) => {
        queue.push(tick)
      })
      try {
        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({ ...source.snapshot(), serverTime: ctx.now(), since, keepAliveMs: SSE_KEEPALIVE_MS }),
        })
        let lastPing = ctx.now()
        while (!stream.aborted) {
          await stream.sleep(POLL_STEP_MS)
          if (stream.aborted) break
          while (queue.length > 0) {
            const tick = queue.shift()
            if (!tick) break
            if (since === null || (tick.maxTimestamp ?? 0) >= since) {
              await stream.writeSSE({ event: 'change', data: JSON.stringify(tick) })
            }
          }
          if (ctx.now() - lastPing >= SSE_KEEPALIVE_MS) {
            lastPing = ctx.now()
            await stream.write(': keep-alive\n\n')
          }
        }
      } finally {
        stop()
      }
    },
    // A client that navigates away aborts the stream; that is normal, not an error.
    async () => {},
  )
}

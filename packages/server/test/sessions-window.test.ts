/**
 * The session timeline's two cost knobs: page the nodes, and leave the content text out
 * until a row is actually opened. Both are opt-in, so the guard here is as much about the
 * default staying exactly as it was as about the new params working.
 */
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness, type Harness } from './helpers.ts'

describe('GET /api/sessions/:id node window and payload laziness', () => {
  let h: Harness
  beforeAll(async () => {
    h = harness()
    // The content layer is opt-in (§3.2), so write two payloads by hand: compressed text,
    // exactly as the writer stores it.
    const put = (eventId: string, kind: string, text: string) =>
      h.seeded.db
        .prepare(
          `INSERT INTO payloads (event_id, kind, role, text, bytes, truncated, created_at)
           VALUES (?, ?, 'assistant', ?, ?, 0, ?)`,
        )
        .run(eventId, kind, deflateSync(Buffer.from(text, 'utf8')), Buffer.byteLength(text), 1_700_000_000_000)
    // `payloads.event_id` is a PRIMARY KEY: a node carries at most one payload row (§3.2),
    // so the two-node case is what `payloads: PayloadView[]` actually has to hold.
    put('e2', 'assistant_message', 'hello from the content layer')
    put('e4', 'tool_result', 'a second node with its own text')
    put('f1', 'assistant_message', 'other session, other text')
  })
  afterAll(() => h.close())

  const full = async () => (await h.get('/api/sessions/sess-aaaa1111')).body

  it('by default still returns every node with its payload text inline', async () => {
    const d = await full()
    expect(d.nodes).toHaveLength(9)
    expect(d.nodesOffset).toBeUndefined()
    expect(d.nodesLimit).toBeUndefined()
    expect(d.nodesTotal).toBeUndefined()
    const withText = d.nodes.find((n: { id: string }) => n.id === 'e2')
    expect(withText.payloads).toHaveLength(1)
    expect(withText.payloads[0].text).toBe('hello from the content layer')
    expect(withText.payloadCount).toBe(1)
    expect(d.contentAvailable).toBe(true)
  })

  it('payloads=0 withholds the text but keeps the count, so a row is still visibly openable', async () => {
    const d = (await h.get('/api/sessions/sess-aaaa1111?payloads=0')).body
    const withText = d.nodes.find((n: { id: string }) => n.id === 'e2')
    expect(withText.payloads).toEqual([])
    expect(withText.payloadCount).toBe(1)
    // Degraded-mode reporting must not flip just because text was withheld.
    expect(d.contentAvailable).toBe(true)
    expect(d.contentNote).toContain('payloads=0')
    // Every node still arrives: the waterfall needs all of them to build the forest.
    expect(d.nodes).toHaveLength(9)
    // Metric facts are untouched by the flag.
    expect(d.nodes.map((n: { id: string }) => n.id)).toEqual((await full()).nodes.map((n: { id: string }) => n.id))
    expect(d.totals).toEqual((await full()).totals)
  })

  it('a node with no content reports payloadCount 0 either way', async () => {
    const d = (await h.get('/api/sessions/sess-aaaa1111?payloads=0')).body
    expect(d.nodes.find((n: { id: string }) => n.id === 'e1').payloadCount).toBe(0)
  })

  it('offset/limit slice the SAME ordered nodes and say so', async () => {
    const all = (await full()).nodes.map((n: { id: string }) => n.id)
    const page = (await h.get('/api/sessions/sess-aaaa1111?offset=2&limit=3')).body
    expect(page.nodes.map((n: { id: string }) => n.id)).toEqual(all.slice(2, 5))
    expect(page.nodesOffset).toBe(2)
    expect(page.nodesLimit).toBe(3)
    expect(page.nodesTotal).toBe(all.length)
  })

  it('limit alone pages from the start, and an over-large offset is an empty page not an error', async () => {
    const head = (await h.get('/api/sessions/sess-aaaa1111?limit=1')).body
    expect(head.nodes).toHaveLength(1)
    expect(head.nodesTotal).toBe(9)
    const past = (await h.get('/api/sessions/sess-aaaa1111?offset=999')).body
    expect(past.nodes).toEqual([])
    expect(past.session.eventCount).toBe(9)
  })

  it('totals and the header describe the whole session even when nodes are paged', async () => {
    // The window is a transport detail; the numbers are session-wide, or a page would
    // silently print a partial total.
    const page = (await h.get('/api/sessions/sess-aaaa1111?limit=2')).body
    expect(page.totals).toEqual((await full()).totals)
  })

  it('serves payload text for one node on demand', async () => {
    const r = await h.get('/api/sessions/sess-aaaa1111/nodes/e2/payloads')
    expect(r.status).toBe(200)
    expect(r.body.payloads.e2).toHaveLength(1)
    expect(r.body.payloads.e2[0].text).toBe('hello from the content layer')
  })

  it('accepts a ?node= batch and answers every owned id, empty or not', async () => {
    const r = await h.get('/api/sessions/sess-aaaa1111/nodes/e2/payloads?node=e2&node=e4&node=e1')
    expect(Object.keys(r.body.payloads).sort()).toEqual(['e1', 'e2', 'e4'])
    expect(r.body.payloads.e2).toHaveLength(1)
    expect(r.body.payloads.e4[0].text).toBe('a second node with its own text')
    expect(r.body.payloads.e1).toEqual([]) // owned but logged nothing: present-and-empty, not absent
  })

  it('refuses to read another session’s payload through the path session', async () => {
    // f1 has content and belongs to sess-bbbb2222. Asking the aaaa session for it must not
    // leak the text — this endpoint is loopback-only but still crosses project boundaries.
    const r = await h.get('/api/sessions/sess-aaaa1111/nodes/f1/payloads')
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('other session')
  })

  it('404s an unknown node id and a 400 a negative window', async () => {
    expect((await h.get('/api/sessions/sess-aaaa1111/nodes/nope/payloads')).status).toBe(404)
    expect((await h.get('/api/sessions/sess-aaaa1111?offset=-1')).status).toBe(400)
    expect((await h.get('/api/sessions/sess-aaaa1111?limit=abc')).status).toBe(400)
    expect((await h.get('/api/sessions/sess-aaaa1111?limit=99999')).status).toBe(400)
  })

  it('combines paging with withheld text without changing either', async () => {
    const r = (await h.get('/api/sessions/sess-aaaa1111?offset=1&limit=4&payloads=0')).body
    const all = (await full()).nodes
    expect(r.nodes.map((n: { id: string }) => n.id)).toEqual(all.slice(1, 5).map((n: { id: string }) => n.id))
    expect(r.nodes.every((n: { payloads: unknown[] }) => n.payloads.length === 0)).toBe(true)
    // e2 and e4 are the two content-bearing nodes inside this page.
    expect(r.nodes.map((n: { id: string }) => n.id)).toEqual(['e2', 'e3', 'e4', 'e5'])
    expect(r.nodes.reduce((a: number, n: { payloadCount: number }) => a + n.payloadCount, 0)).toBe(2)
  })
})

/**
 * §12 export: the stdout contract (jsonl/csv/otel) plus the opt-in OTLP/HTTP ingest leg.
 * The endpoint is an in-process server bound to 127.0.0.1 only, and every fixture is
 * synthetic — no real agent log reaches this file.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-export-'))
const TS = Date.UTC(2026, 8, 20, 9)

function ev(id: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1, agentId: 'claude-code', hostId: 'claude-code', sourceId: 'src-synthetic',
    sessionId: 'sess-synthetic', projectId: 'proj-synthetic', timestamp: TS,
    type: 'generation.end', usageSource: 'reported', status: 'ok', rawSeq: 1, rawOffset: 0,
    ...overrides,
  }
}

function seedDb(path: string, events: AgentEvent[]): void {
  const db = openDatabase(path)
  migrate(db)
  insertEvents(db, events)
  db.close()
}

const usage = { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const dbPath = join(tmp, 'agentlens.db')
seedDb(dbPath, [
  ev('x1', {
    requestId: 'req-1', threadId: 'thread-a', costReported: 0.25, costSource: 'reported', rawSeq: 1,
    model: { provider: 'anthropic', name: 'test-model' }, usage,
  }),
  ev('x2', {
    type: 'tool.end', capability: { type: 'tool', name: 'Bash' }, durationMs: 400, status: 'error',
    usage: null, usageSource: 'missing', threadId: 'thread-b', costSource: 'none', requestId: 'req-2', rawSeq: 2,
  }),
  ev('x3', { type: 'session.start', usage: null, usageSource: 'missing', rawSeq: 3 }),
])

// One span fewer than the batch limit, then the overflow, so the split itself is measured.
const BULK = 501
const bulkPath = join(tmp, 'bulk.db')
seedDb(bulkPath, Array.from({ length: BULK }, (_, i) =>
  ev(`bulk-${i}`, {
    hostId: i % 2 === 0 ? 'claude-code' : 'claude-desktop',
    timestamp: TS + i, rawSeq: i + 1, usage,
  }),
))

/* ------------------------------------------------------------------ loopback endpoint */

interface OtlpValue { key: string; value: Record<string, unknown> }
interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpValue[]
  status: { code: number }
}
interface OtlpRequest {
  resourceSpans: { resource: { attributes: OtlpValue[] }; scopeSpans: { scope: { name: string }; spans: OtlpSpan[] } }[]
}

function valueOf(entries: OtlpValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of entries) out[e.key] = Object.values(e.value)[0]
  return out
}

interface Captured {
  method: string | undefined
  url: string
  headers: IncomingHttpHeaders
  body: string
}

const seen: Captured[] = []
let reply = { status: 200, body: '{}' }
let endpoint = ''

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.statusCode = reply.status
    res.end(reply.body)
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`
})

beforeEach(() => {
  seen.length = 0
  reply = { status: 200, body: '{}' }
})

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true })
  // undici holds keep-alive sockets open, which would keep close() pending.
  server.closeAllConnections()
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
})

async function run(db: string, ...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const ctx: Ctx = {
    argv: [...argv, '--db', db],
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    homedir: tmp,
    env: {},
    now: () => Date.UTC(2026, 8, 21),
  }
  return { code: await runCli(ctx), out, err }
}

/* ------------------------------------------------------------------------------- tests */

describe('export formats', () => {
  it('csv keeps the frozen column list and appends the §18 fields', async () => {
    const frozen =
      'id,schema_version,agent_id,host_id,source_id,session_id,project_id,request_id,timestamp,' +
      'type,subtype,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,' +
      'reasoning_tokens,usage_source,capability_type,capability_name,duration_ms,status,metadata'
    const { code, out } = await run(dbPath, 'export', '--format', 'csv')
    expect(code).toBe(0)
    expect(out[0]!.startsWith(frozen)).toBe(true)
    expect(out[0]!.slice(frozen.length)).toBe(',thread_id,cost_reported,cost_source')
    expect(out[1]).toMatch(/,thread-a,0\.25,reported$/)
    expect(out[2]).toMatch(/,thread-b,,none$/)
    expect(out[3]).toMatch(/,,,$/)
    // model/provider are declared columns; without the models join they export empty.
    expect(out[1]!.split(',')[11]).toBe('test-model')
    expect(out[1]!.split(',')[12]).toBe('anthropic')
  })

  it('sends nothing at all without --push', async () => {
    const { code, out } = await run(dbPath, 'export', '--format', 'otel')
    expect(code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(out.filter((l) => l.startsWith('{'))).toHaveLength(3)
  })
})

describe('export --push (OTLP/HTTP ingest)', () => {
  it('posts the same spans an otel export prints, wrapped in one OTLP/JSON request', async () => {
    const { code, out, err } = await run(
      dbPath, 'export', '--format', 'otel', '--push', endpoint,
      '--push-header', 'Authorization: Basic ZmFrZS1wdWJsaWM6ZmFrZS1zZWNyZXQ',
    )
    expect(code).toBe(0)
    expect(out).toHaveLength(0) // the data went to the endpoint, not stdout
    expect(err.join('\n')).toContain('3 events pushed')

    expect(seen).toHaveLength(1)
    const req = seen[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/traces')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['authorization']).toBe('Basic ZmFrZS1wdWJsaWM6ZmFrZS1zZWNyZXQ')

    const payload = JSON.parse(req.body) as OtlpRequest
    expect(payload.resourceSpans).toHaveLength(1)
    const resource = payload.resourceSpans[0]!
    expect(valueOf(resource.resource.attributes)).toEqual({
      'service.name': 'claude-code',
      'agentlens.host_id': 'claude-code',
    })
    const spans = resource.scopeSpans[0]!.spans
    expect(spans).toHaveLength(3)

    const first = spans[0]!
    expect(first.name).toBe('chat test-model')
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(first.startTimeUnixNano).toBe(String(BigInt(TS) * 1_000_000n))
    expect(first.endTimeUnixNano).toBe(first.startTimeUnixNano)
    expect(first.status.code).toBe(1)
    expect(valueOf(first.attributes)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'test-model',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.usage.input_tokens': 1200,
      'agentlens.thread_id': 'thread-a',
      'agentlens.cost_reported': 0.25,
      'agentlens.cost_source': 'reported',
    })

    const tool = spans[1]!
    expect(tool.name).toBe('execute_tool Bash')
    expect(tool.status.code).toBe(2)
    expect(BigInt(tool.endTimeUnixNano) - BigInt(tool.startTimeUnixNano)).toBe(400_000_000n)
    expect('gen_ai.operation.name' in valueOf(spans[2]!.attributes)).toBe(false)
  })

  it('spans the request into batches, grouping each by host', async () => {
    const { code } = await run(bulkPath, 'export', '--format', 'otel', '--push', endpoint)
    expect(code).toBe(0)
    expect(seen).toHaveLength(2)
    const bodies = seen.map((r) => JSON.parse(r.body) as OtlpRequest)
    const counts = bodies.map((b) => b.resourceSpans.reduce((n, rs) => n + rs.scopeSpans[0]!.spans.length, 0))
    expect(counts).toEqual([500, 1])
    expect(bodies[0]!.resourceSpans).toHaveLength(2) // one resource per (agent, host)
    expect(bodies[0]!.resourceSpans.map((rs) => valueOf(rs.resource.attributes)['agentlens.host_id'])).toEqual([
      'claude-code', 'claude-desktop',
    ])
    const ids = bodies.flatMap((b) => b.resourceSpans.flatMap((rs) => rs.scopeSpans[0]!.spans.map((s) => s.spanId)))
    expect(new Set(ids).size).toBe(BULK)
  })

  it('reports a non-2xx response instead of dropping the spans', async () => {
    reply = { status: 500, body: 'ingest rejected: unknown project' }
    const { code, err } = await run(dbPath, 'export', '--format', 'otel', '--push', endpoint)
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('responded 500')
    expect(err.join('\n')).toContain('ingest rejected: unknown project')
    expect(err.join('\n')).toContain('0 of 3 spans sent')
    expect(seen).toHaveLength(1) // one attempt, then it stops: no silent partial ingest
  })

  it('reports an unreachable endpoint', async () => {
    const spare: Server = createServer()
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve))
    const port = (spare.address() as AddressInfo).port
    await new Promise<void>((resolve) => spare.close(() => resolve()))
    const { code, err } = await run(dbPath, 'export', '--format', 'otel', '--push', `http://127.0.0.1:${port}/v1/traces`)
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('cannot reach')
    expect(err.join('\n')).toContain('0 of 3 spans sent')
  })

  it('refuses to push a format other than otel, and a non-http endpoint', async () => {
    const wrong = await run(dbPath, 'export', '--format', 'jsonl', '--push', endpoint)
    expect(wrong.code).toBe(2)
    expect(wrong.err.join('\n')).toContain('requires --format otel')
    const bad = await run(dbPath, 'export', '--format', 'otel', '--push', 'not a url')
    expect(bad.code).toBe(2)
    expect(bad.err.join('\n')).toContain('http(s) OTLP endpoint')
    const scheme = await run(dbPath, 'export', '--format', 'otel', '--push', 'file:///tmp/otel.json')
    expect(scheme.code).toBe(2)
    expect(seen).toHaveLength(0)
  })
})

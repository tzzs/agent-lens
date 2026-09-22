/**
 * `agl doctor` end to end (§11): the real claude-code adapter, a SYNTHETIC de-identified
 * store under a temp directory, and a temp database. `AGENTLENS_AGENT_ROOT` is what makes
 * this deterministic — it relocates every filesystem probe away from this machine's home,
 * the same job `--db` does for the database. All fixtures are invented session data.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveSessionId, type AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase, setAgentAggregations } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'agentlens-doctor-e2e-'))
const HOME = join(ROOT, 'home')
const CLAUDE = join(HOME, '.claude')
const PROJECTS = join(CLAUDE, 'projects')
const dbPath = join(ROOT, 'agentlens.db')
const modeBitsApply = process.getuid?.() !== 0
const LOCKED = join(PROJECTS, 'proj-locked')

afterAll(() => {
  if (modeBitsApply) chmodSync(LOCKED, 0o755)
  rmSync(ROOT, { recursive: true, force: true })
})

function buildStore(): void {
  mkdirSync(join(PROJECTS, 'proj-alpha'), { recursive: true })
  mkdirSync(join(PROJECTS, 'proj-gamma'), { recursive: true })
  mkdirSync(LOCKED, { recursive: true })
  const record = (type: string, extra: string): string =>
    `{"type":"${type}","sessionId":"sess-a","cwd":"/work/alpha","version":"2.1.275","timestamp":"2026-09-20T09:00:00.000Z"${extra}}\n`
  writeFileSync(
    join(PROJECTS, 'proj-alpha', 'sess-a.jsonl'),
    record('user', ',"uuid":"u1"') + record('assistant', ',"uuid":"u2"'),
  )
  // A project dir upstream emptied but never removed: §4.4 row 4's silent hole.
  writeFileSync(join(PROJECTS, 'proj-gamma', 'keep.txt'), 'not a session file')
  writeFileSync(join(LOCKED, 'sess-locked.jsonl'), record('user', ''))
  // sess-a really has a file; sess-gone is a session whose file retention already took.
  writeFileSync(
    join(CLAUDE, 'history.jsonl'),
    [
      { display: 'do the private thing', timestamp: 1, project: '/secret/work', sessionId: 'sess-a' },
      { display: 'x', timestamp: 2, project: '/secret/work', sessionId: 'sess-gone' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  if (modeBitsApply) chmodSync(LOCKED, 0)
}

function usage(input: number, output: number) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function seedDatabase(): void {
  const db = openDatabase(dbPath)
  migrate(db)
  const ev = (o: Partial<AgentEvent> & { id: string }): AgentEvent => ({
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-a',
    sessionId: deriveSessionId('claude-code', 'sess-a'),
    projectId: 'proj-alpha',
    timestamp: Date.UTC(2026, 8, 20, 9),
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...o,
  })
  const events: AgentEvent[] = [
    ev({ id: 'e1', requestId: 'r1', usage: usage(1_200_000, 40_000), model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } }),
    ev({ id: 'e2', requestId: 'r1', usage: usage(1_200_000, 40_000), model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } }),
    ev({ id: 'e3', requestId: 'r1', usageSource: 'missing', type: 'tool.end', capability: { type: 'tool', name: 'Bash' }, rawSeq: 2 }),
    ev({ id: 'e4', requestId: null, usageSource: 'missing', type: 'session.start', rawSeq: 3 }),
    ev({ id: 'e5', type: 'hook.fire', capability: { type: 'hook', name: 'PostToolUseFailure' }, status: 'error', usageSource: 'missing', rawSeq: 4 }),
    // §3.3 + §4.4 row 9: a user turn and a tool result carry no request_id and no usage at
    // all, so the fold can only count them individually — which is what §11's parenthetical
    // reports. A store without them would not exercise that clause at all.
    ev({ id: 'e6', requestId: null, usageSource: 'missing', type: 'message.user', rawSeq: 5 }),
    ev({ id: 'e7', requestId: null, usageSource: 'missing', type: 'tool.result', capability: { type: 'tool', name: 'Read' }, rawSeq: 6 }),
  ]
  insertEvents(db, events)
  setAgentAggregations(db, { 'claude-code': { mode: 'request_max', subagentsIncluded: true } })
  db.close()
}

buildStore()
seedDatabase()

async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const ctx: Ctx = {
    argv: [...argv, '--db', dbPath],
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    homedir: HOME,
    env: { AGENTLENS_AGENT_ROOT: HOME },
    now: () => Date.UTC(2026, 8, 21),
  }
  return { code: await runCli(ctx), lines }
}

describe('agl doctor against a synthetic store', () => {
  let out = ''
  let code = -1

  beforeAll(async () => {
    const res = await run('doctor')
    code = res.code
    out = res.lines.join('\n')
  })

  it('exits 0 and prints every §11 section', () => {
    expect(code, out).toBe(0)
    for (const section of ['Agents', 'Parsing', 'Usage quality', 'Coverage', 'Capabilities', 'Pricing', 'Permissions']) {
      expect(out).toContain(section)
    }
  })

  it('describes the detected agent from the temp root, not this machine', () => {
    expect(out).toMatch(/(✓|!) claude-code +v2\.1\.275/)
    expect(out).toContain('~/.claude/projects/**/*.jsonl')
    expect(out).toContain('1 files /')
  })

  it('reports the retention hole and the history-only session', () => {
    expect(out).toContain(
      'session dirs under ~/.claude/projects still exist but hold no session files (upstream retention, every dir in the live store whether ingested or not, §4.4 row 4)',
    )
    expect(out).toContain('→ history is incomplete')
    expect(out).toContain('2 sessions named in ~/.claude/history.jsonl')
    expect(out).toContain('1 known only from history.jsonl')
    expect(out).toContain('1 of them never ingested at all')
  })

  it('measures usage quality with the agent\'s own persisted fold', () => {
    expect(out).toContain('request_id dedup active')
    expect(out).toContain('inflation avoided')
    expect(out).toContain('(4 records without request_id, counted individually)')
    expect(out).toContain('fold request_max · subagents counted (persisted with the stored rows')
    expect(out).toContain('cube (SQL) and event-model folds agree on every agent')
  })

  it('keeps permissions as three distinct states', () => {
    expect(out).toContain('readable')
    expect(out).toContain('does not exist')
    if (modeBitsApply) expect(out).toContain('EXISTS but not readable')
  })

  it('never touches anything: no sidecar, no new entry under the store', () => {
    expect(readdirSync(CLAUDE).sort()).toEqual(['history.jsonl', 'projects'])
    expect(existsSync(join(CLAUDE, 'state.db-wal'))).toBe(false)
    expect(existsSync(join(CLAUDE, 'state.db-shm'))).toBe(false)
  })

  it('keeps user content out of the report (§3.2 privacy posture)', () => {
    expect(out).not.toContain('do the private thing')
    expect(out).not.toContain('/secret/work')
    expect(out).not.toContain(ROOT)
  })

  it('--agent narrows the report to that adapter only', async () => {
    const res = await run('doctor', '--agent', 'claude-code')
    const text = res.lines.join('\n')
    expect(res.code, text).toBe(0)
    expect(text).toContain('claude-code')
    expect(text).not.toContain('opencode')
  })
})

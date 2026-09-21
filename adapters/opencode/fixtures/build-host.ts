/**
 * Fixture builder — SQLite cannot be checked in as a text fixture, so the throwaway
 * host database is CREATED here (a build script tests run, never shipped data) inside
 * `node:os.tmpdir()`. Schema and row shapes are copied from the measured DDL in
 * docs/research/qoder-opencode.md §2.2/§2.3 and the read-only re-probe of this
 * machine's store; every string is synthetic.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

/** Fixed base timestamp so derived ids and snapshots are machine independent (ms epoch). */
export const T0 = 1_760_000_000_000

const DDL = [
  `CREATE TABLE session (
     id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
     directory text NOT NULL, title text NOT NULL, version text NOT NULL, share_url text,
     summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
     revert text, permission text, time_created integer NOT NULL, time_updated integer NOT NULL,
     time_compacting integer, time_archived integer, workspace_id text, path text, agent text, model text,
     cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
     tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
     tokens_cache_write integer DEFAULT 0 NOT NULL, metadata text)`,
  `CREATE TABLE message (
     id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
     time_updated integer NOT NULL, data text NOT NULL)`,
  `CREATE TABLE part (
     id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
     time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
  `CREATE TABLE project (
     id text PRIMARY KEY, worktree text, vcs text, name text, commands text, time_created integer)`,
  `CREATE TABLE todo (session_id text NOT NULL, content text, status text, position integer)`,
]

export interface SessionSeed {
  id: string
  projectId?: string
  parentId?: string | null
  directory?: string
  agent?: string | null
  version?: string
  cost?: number | null
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  timeCompacting?: number | null
  timeArchived?: number | null
  title?: string
  model?: unknown
  rowid?: number
}

export interface MessageSeed {
  id: string
  sessionId: string
  data: Record<string, unknown>
  created?: number
  updated?: number
}

export interface PartSeed {
  id: string
  messageId: string
  sessionId: string
  data: Record<string, unknown>
  created?: number
  updated?: number
}

export interface HostSeed {
  sessions?: SessionSeed[]
  messages?: MessageSeed[]
  parts?: PartSeed[]
  projectCommands?: unknown
  /** Build the store at `<tmp>/<subdir>/opencode.db` instead of directly under the tmp dir. */
  subdir?: string
  /** WAL + no `-wal`/`-shm` siblings: the case §18 row 7 says must be refused. */
  wal?: boolean
  /** Keep a write connection open so the WAL sidecars really exist on disk. */
  retainWriter?: boolean
}

export interface BuiltHost {
  dir: string
  /** Directory holding `opencode.db` (equals `dir` unless `subdir` was used). */
  root: string
  dbPath: string
  /** Close our connections but KEEP the files, for after-the-fact sidecar checks. */
  closeConnections(): void
  close(): Promise<void>
}

const DEFAULT_SESSIONS: SessionSeed[] = [
  {
    id: 'ses_root0000000000000000000A',
    projectId: 'prj_alpha',
    parentId: null,
    directory: '/work/alpha',
    agent: 'build',
    version: '1.18.31',
    // Measured shape: cache_read (193,792) is far ABOVE input (45,024), which is what
    // proves `tokens_input` excludes cached tokens.
    cost: 0.11701036,
    tokens: { input: 45024, output: 2177, reasoning: 860, cacheRead: 193792, cacheWrite: 0 },
    timeCompacting: T0 + 5_000,
    title: 'synthetic root session',
    model: { id: 'test-model', providerID: 'testp' },
  },
  {
    id: 'ses_child000000000000000000B',
    projectId: 'prj_alpha',
    parentId: 'ses_root0000000000000000000A',
    directory: '/work/alpha',
    agent: 'explore',
    version: '1.18.31',
    cost: 0.02,
    tokens: { input: 1000, output: 50, reasoning: 0, cacheRead: 4000, cacheWrite: 7 },
    title: 'synthetic subagent session',
  },
  {
    // No `cost` written and no archive marker: the NULL-cost case (§8 forbids $0).
    id: 'ses_nocost00000000000000000C',
    projectId: 'prj_beta',
    parentId: null,
    directory: '/work/beta',
    agent: null,
    version: 'local',
    cost: undefined,
    tokens: undefined,
    timeArchived: T0 + 9_000,
    title: 'synthetic archived session',
  },
]

const DEFAULT_MESSAGES: MessageSeed[] = [
  {
    id: 'msg_user00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { role: 'user', time: { created: T0 + 100 }, agent: 'build', mode: 'primary' },
    created: T0 + 100,
    updated: T0 + 100,
  },
  {
    id: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    // Measured `message.data.tokens`: {total, input, output, reasoning, cache:{read,write}}.
    // total === input + output + reasoning + cache.read ⇒ input is the UNCACHED remainder.
    data: {
      role: 'assistant',
      time: { created: T0 + 200, completed: T0 + 900 },
      agent: 'build',
      mode: 'primary',
      parentID: 'msg_user00000000000000000001',
      modelID: 'test-model',
      providerID: 'testp',
      variant: 'default',
      finish: 'stop',
      cost: 0.031,
      tokens: { total: 3023, input: 1100, output: 183, reasoning: 73, cache: { read: 1667, write: 0 } },
      tools: [],
    },
    created: T0 + 200,
    updated: T0 + 900,
  },
  {
    id: 'msg_err000000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      role: 'assistant',
      time: { created: T0 + 1_000 },
      error: { name: 'APIError', data: { message: 'synthetic upstream failure' } },
    },
    created: T0 + 1_000,
    updated: T0 + 1_100,
  },
  {
    id: 'msg_norole00000000000000000001',
    sessionId: 'ses_child000000000000000000B',
    data: { time: { created: T0 + 1_200 }, somethingNew: true },
    created: T0 + 1_200,
    updated: T0 + 1_200,
  },
]

const DEFAULT_PARTS: PartSeed[] = [
  {
    id: 'prt_ss0000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'step-start', snapshot: 'abc123', time: { created: T0 + 200 } },
    created: T0 + 200,
  },
  {
    id: 'prt_sf0000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'step-finish',
      reason: 'stop',
      cost: 0.031,
      tokens: { total: 3023, input: 1100, output: 183, reasoning: 73, cache: { read: 1667, write: 0 } },
    },
    created: T0 + 900,
  },
  {
    id: 'prt_sf0000000000000000000002',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    // A step whose cost is absent, not zero: normalize must keep it NULL (§8).
    data: { type: 'step-finish', tokens: { input: 10, output: 2, cache: {} } },
    created: T0 + 950,
  },
  {
    id: 'prt_read0000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'read',
      callID: 'call_read_1',
      state: {
        status: 'completed',
        input: { filePath: '/work/alpha/notes.md' },
        // A whole file body: must never reach the content layer (§3.2/§6).
        output: 'x'.repeat(2_048),
        title: 'synthetic title',
        metadata: { outputLines: 40 },
        time: { start: T0 + 300, end: T0 + 400 },
      },
    },
    created: T0 + 300,
    updated: T0 + 400,
  },
  {
    id: 'prt_bash0000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'bash',
      callID: 'call_bash_1',
      state: {
        status: 'completed',
        input: { command: 'echo synthetic' },
        output: 'synthetic\n',
        metadata: { exit: 0 },
        time: { start: T0 + 500, end: T0 + 640 },
      },
    },
    created: T0 + 500,
    updated: T0 + 640,
  },
  {
    id: 'prt_err00000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'bash',
      callID: 'call_bash_2',
      state: { status: 'error', input: { command: 'false' }, error: 'synthetic command failure', time: { start: T0 + 700, end: T0 + 720 } },
    },
    created: T0 + 700,
    updated: T0 + 720,
  },
  {
    id: 'prt_mcp00000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'search_docs',
      callID: 'call_mcp_1',
      state: {
        status: 'completed',
        input: { q: 'synthetic' },
        output: 'ok',
        // OpenCode names MCP tools plainly; the server is only in state.metadata.
        metadata: { server: 'docs-mcp' },
        time: { start: T0 + 800, end: T0 + 810 },
      },
    },
    created: T0 + 800,
  },
  {
    id: 'prt_task00000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'task',
      callID: 'call_task_1',
      state: {
        status: 'completed',
        input: { prompt: 'synthetic delegation', subagent_type: 'explore' },
        output: 'done',
        metadata: { sessionId: 'ses_child000000000000000000B' },
        time: { start: T0 + 850, end: T0 + 880 },
      },
    },
    created: T0 + 850,
  },
  {
    id: 'prt_edit00000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: {
      type: 'tool',
      tool: 'edit',
      callID: 'call_edit_1',
      // Whole-file bodies in `input`: excluded from payloads, only sizes kept.
      state: { status: 'pending', input: { path: '/work/alpha/a.ts', content: 'y'.repeat(4096) }, time: { start: T0 + 890 } },
    },
    created: T0 + 890,
  },
  {
    id: 'prt_text_u00000000000000000001',
    messageId: 'msg_user00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'text', text: 'synthetic user prompt', time: { created: T0 + 100 } },
    created: T0 + 100,
  },
  {
    id: 'prt_text_a00000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'text', text: 'synthetic assistant reply', time: { created: T0 + 210 } },
    created: T0 + 210,
  },
  {
    id: 'prt_reason00000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'reasoning', text: 'synthetic reasoning trace' },
    created: T0 + 215,
  },
  {
    id: 'prt_patch000000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'patch', hash: 'deadbeef', files: ['/work/alpha/a.ts', '/work/alpha/b.ts'] },
    created: T0 + 220,
  },
  {
    id: 'prt_future00000000000000000001',
    messageId: 'msg_asst00000000000000000001',
    sessionId: 'ses_root0000000000000000000A',
    data: { type: 'quantum-state', brandNewField: { nested: 1 } },
    created: T0 + 230,
  },
  {
    id: 'prt_child00000000000000000001',
    messageId: 'msg_norole00000000000000000001',
    sessionId: 'ses_child000000000000000000B',
    data: {
      type: 'step-finish',
      cost: 0.02,
      tokens: { total: 5_057, input: 1_000, output: 50, reasoning: 0, cache: { read: 4_000, write: 7 } },
    },
    created: T0 + 1_300,
  },
]

export async function buildHost(seed: HostSeed = {}): Promise<BuiltHost> {
  const dir = await mkdtemp(join(tmpdir(), 'agentlens-opencode-host-'))
  const root = seed.subdir ? join(dir, seed.subdir) : dir
  if (seed.subdir) await mkdir(root, { recursive: true })
  const dbPath = join(root, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = OFF')
  if (seed.wal) db.exec('PRAGMA journal_mode = WAL')
  for (const stmt of DDL) db.exec(stmt)

  const sessions = seed.sessions ?? DEFAULT_SESSIONS
  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
      time_compacting, time_archived, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const s of sessions) {
    const t = T0
    insertSession.run(
      s.id,
      s.projectId ?? 'prj_alpha',
      s.parentId ?? null,
      `slug-${s.id.slice(4, 8)}`,
      s.directory ?? '/work/alpha',
      s.title ?? 'synthetic',
      s.version ?? '1.18.31',
      t,
      t + 1_000,
      s.timeCompacting ?? null,
      s.timeArchived ?? null,
      s.agent ?? null,
      typeof s.model === 'string' ? s.model : s.model ? JSON.stringify(s.model) : null,
      s.cost ?? 0,
      s.tokens?.input ?? 0,
      s.tokens?.output ?? 0,
      s.tokens?.reasoning ?? 0,
      s.tokens?.cacheRead ?? 0,
      s.tokens?.cacheWrite ?? 0,
      '{}',
    )
  }

  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)',
  )
  for (const m of seed.messages ?? DEFAULT_MESSAGES) {
    insertMessage.run(m.id, m.sessionId, m.created ?? T0, m.updated ?? m.created ?? T0, JSON.stringify(m.data))
  }

  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
  )
  for (const p of seed.parts ?? DEFAULT_PARTS) {
    insertPart.run(p.id, p.messageId, p.sessionId, p.created ?? T0, p.updated ?? p.created ?? T0, JSON.stringify(p.data))
  }

  db.prepare('INSERT INTO project (id, worktree, vcs, name, commands, time_created) VALUES (?,?,?,?,?,?)').run(
    'prj_alpha',
    '/work/alpha',
    'git',
    'alpha',
    JSON.stringify(seed.projectCommands ?? []),
    T0,
  )

  // A retained writer keeps `-wal`/`-shm` on disk, which is the state the real
  // OpenCode app leaves behind and the only WAL state we may attach to.
  const writer: DatabaseSync | null = seed.retainWriter ? new DatabaseSync(dbPath) : null

  return {
    dir,
    root,
    dbPath,
    closeConnections() {
      writer?.close()
      db.close()
    },
    async close() {
      closeQuietly(writer)
      closeQuietly(db)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function closeQuietly(handle: DatabaseSync | null): void {
  try {
    handle?.close()
  } catch {
    // Already closed by an earlier `close()`; nothing left to clean up but the temp dir.
  }
}

/** Rows appended after the initial build, to exercise the rowid high-water resume. */
export function appendRows(dbPath: string, parts: PartSeed[], messages: MessageSeed[] = []): void {
  const db = new DatabaseSync(dbPath)
  try {
    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)',
    )
    for (const m of messages) {
      insertMessage.run(m.id, m.sessionId, m.created ?? T0, m.updated ?? m.created ?? T0, JSON.stringify(m.data))
    }
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
    )
    for (const p of parts) {
      insertPart.run(p.id, p.messageId, p.sessionId, p.created ?? T0, p.updated ?? p.created ?? T0, JSON.stringify(p.data))
    }
  } finally {
    db.close()
  }
}

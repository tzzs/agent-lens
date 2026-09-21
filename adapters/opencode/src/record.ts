/**
 * Read-only views over OpenCode's SQLite rows. The DDL (measured on this machine,
 * 2026-09-21) is:
 *
 *   session(id PK, project_id, parent_id, slug, directory, title, version,
 *           share_url, summary_*, revert, permission, time_created, time_updated,
 *           time_compacting, time_archived, workspace_id, path, agent, model,
 *           cost, tokens_input, tokens_output, tokens_reasoning,
 *           tokens_cache_read, tokens_cache_write, metadata)
 *   message(id PK, session_id, time_created, time_updated, data)   -- data is JSON
 *   part(id PK, message_id, session_id, time_created, time_updated, data)
 *
 * so per-row facts live either in a column (`session.cost`) or in the `data`
 * JSON blob (`message.data.tokens`, `part.data.state`), and the relational keys
 * (`session_id`, `message_id`) are columns, never inside `data`.
 */

export const AGENT_ID = 'opencode'
/**
 * §18 row 6 asks for an entrypoint→host table, but OpenCode's schema carries no
 * origin/platform column (measured: 25 session columns, none of them a host axis),
 * so every event gets this single host rather than an invented split.
 */
export const HOST_ID = 'opencode'

export const TABLE_SESSION = 'session'
export const TABLE_MESSAGE = 'message'
export const TABLE_PART = 'part'
export const TABLES = [TABLE_SESSION, TABLE_MESSAGE, TABLE_PART] as const
export type OpenCodeTable = (typeof TABLES)[number]

export interface UnknownRecord {
  [key: string]: unknown
}

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function bool(value: unknown): boolean {
  return value === true
}

/** OpenCode stores ms epochs; a sub-1e11 value is seconds and gets scaled. */
export function ms(value: unknown): number | null {
  const n = num(value)
  if (n === null || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

export function parseJson(value: unknown): UnknownRecord | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

/** `session.model` is a JSON column (`{"id":…,"providerID":…}`). */
export function modelRefOf(sessionModel: unknown, messageData: UnknownRecord | null) {
  const fromMessage = messageData
    ? {
        provider: str(messageData.providerID),
        name: str(messageData.modelID),
        tier: str(messageData.variant),
      }
    : null
  if (fromMessage?.name) {
    return {
      provider: fromMessage.provider ?? 'unknown',
      name: fromMessage.name,
      tier: fromMessage.tier,
    }
  }
  const parsed = parseJson(sessionModel) ?? asRecord(sessionModel)
  const name = str(parsed?.id) ?? str(parsed?.modelID)
  if (!name) return null
  return { provider: str(parsed?.providerID) ?? 'unknown', name, tier: str(parsed?.variant) }
}

// ---------------------------------------------------------------- token dialect

export interface TokenDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Fields actually seen: absent fields must not be reported as 0-token usage. */
  present: boolean
}

const EMPTY: TokenDraft = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  present: false,
}

function nonNeg(value: unknown): number {
  const n = num(value)
  return n === null || n < 0 ? 0 : Math.trunc(n)
}

/**
 * §18 row 4 — OpenCode's third cache dialect. Measured on this machine:
 * `message.data.tokens` is `{total, input, output, reasoning, cache:{read, write}}`
 * and `total === input + output + reasoning + cache.read` (verified over 488 rows,
 * with `cache.read > input` in 471 of them), so **`input` EXCLUDES cached tokens**
 * — the Claude/Anthropic convention, not OpenAI's. Therefore the mapping is a
 * straight field-to-field copy and `total` is deliberately ignored (summing it
 * would double count).
 */
export function tokensOf(data: UnknownRecord | null): TokenDraft {
  const tokens = asRecord(data?.tokens)
  if (!tokens) return EMPTY
  const cache = asRecord(tokens.cache)
  const present =
    tokens.input !== undefined ||
    tokens.output !== undefined ||
    tokens.reasoning !== undefined ||
    cache !== null
  if (!present) return EMPTY
  return {
    inputTokens: nonNeg(tokens.input),
    outputTokens: nonNeg(tokens.output),
    cacheReadTokens: nonNeg(cache?.read),
    cacheWriteTokens: nonNeg(cache?.write),
    reasoningTokens: nonNeg(tokens.reasoning),
    present: true,
  }
}

/** The same dialect on the `session` rollup columns. */
export function sessionTokensOf(row: UnknownRecord): TokenDraft {
  if (row.tokens_input === undefined && row.tokens_output === undefined) return EMPTY
  return {
    inputTokens: nonNeg(row.tokens_input),
    outputTokens: nonNeg(row.tokens_output),
    cacheReadTokens: nonNeg(row.tokens_cache_read),
    cacheWriteTokens: nonNeg(row.tokens_cache_write),
    reasoningTokens: nonNeg(row.tokens_reasoning),
    present: true,
  }
}

/** Reported cost (§18 row 1): NULL stays NULL — 0 means "free", absent means "unknown". */
export function costOf(data: UnknownRecord | null, key = 'cost'): number | null {
  const n = num(data?.[key])
  return n === null || n < 0 ? null : n
}

export function durationOf(value: unknown): number | null {
  const t = asRecord(value)
  if (!t) return null
  const start = ms(t.start ?? t.created)
  const end = ms(t.end ?? t.completed)
  if (start === null || end === null || end < start) return null
  return end - start
}

/**
 * OpenCode MCP tools are not namespaced the way Claude's `mcp__server__tool` is;
 * the server name rides in `state.metadata` (clientName/serverName) when present,
 * so check that first and fall back to the two separator dialects.
 */
export function mcpOf(
  toolName: string | null,
  stateMeta: UnknownRecord | null,
): { server: string; tool: string } | null {
  const server = str(stateMeta?.server) ?? str(stateMeta?.serverName) ?? str(stateMeta?.clientName)
  if (server && toolName) return { server, tool: toolName }
  if (!toolName) return null
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5)
    const sep = rest.indexOf('__')
    if (sep > 0) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
  }
  const colon = toolName.indexOf(':')
  if (colon > 0) return { server: toolName.slice(0, colon), tool: toolName.slice(colon + 1) }
  return null
}

// ---------------------------------------------------------------- metadata bounds

/**
 * §5.3 wants the raw row kept for drift, §3.2/§6 forbid whole file snapshots in
 * the metric layer — `part.data.state.output` and `patch.files` carry exactly that.
 */
const MAX_STRING = 200
const OMIT_KEYS = new Set([
  'text',
  'output',
  'input',
  'content',
  'snapshot',
  'files',
  'diff',
  'prompt',
  'title',
  'metadata',
  'error',
])

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length}ch)` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return depth > 2 ? `[array:${value.length}]` : value.slice(0, 12).map((v) => redact(v, depth + 1))
  }
  if (depth > 2) return '[object]'
  const out: UnknownRecord = {}
  for (const [k, v] of Object.entries(value as UnknownRecord)) {
    if (OMIT_KEYS.has(k) && (typeof v === 'string' || Array.isArray(v) || (v !== null && typeof v === 'object'))) {
      out[k] = `(omitted ${typeof v === 'string' ? `${v.length}ch` : Array.isArray(v) ? `${v.length} items` : 'object'})`
      continue
    }
    out[k] = redact(v, depth + 1)
  }
  return out
}

const PAYLOAD_LIMIT = 32 * 1024

export function truncate(text: string, max = PAYLOAD_LIMIT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Tool input/output payloads are JSON blobs; cap them like Claude's tool inputs. */
export function jsonPayload(value: unknown, max = 4096): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : safeStringify(value)
  if (text === '') return null
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The join columns `parse` attaches so a row knows its session/message context. */
export interface RowContext {
  rowid: number
  /** Full row: all columns + `data` parsed + `session`/`message` join fields. */
  row: UnknownRecord
  data: UnknownRecord | null
  /** False when the collector's single-column SQLite path delivered `data` alone. */
  hasColumns: boolean
}

export function readRow(record: unknown, sqliteTable: string | null | undefined): RowContext {
  const value = asRecord(record) ?? {}
  const data = asRecord(value.data)
  const hasColumns = value.data !== undefined || value.session_id !== undefined || value.id !== undefined
  if (!hasColumns && data === null) {
    return { rowid: 0, row: value, data: value, hasColumns: false }
  }
  return {
    rowid: num(value.__rowid ?? value.rowid) ?? 0,
    row: value,
    data: data ?? (hasColumns ? null : value),
    hasColumns,
  }
}

export function tableOf(sqliteTable: string | null | undefined): OpenCodeTable | string {
  return sqliteTable ?? 'unknown'
}

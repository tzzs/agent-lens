/**
 * Read-only view over an upstream Claude Code JSONL record.
 * Field names come from docs/research/claude-code.md's census (92 files / 68,314 records);
 * every accessor tolerates absence because record types drift across 2.1.x (§5.3).
 */

export const AGENT_ID = 'claude-code'
export const HOST_CLI = 'claude-code'
export const HOST_DESKTOP = 'claude-desktop'

/**
 * The one marker convention lives in the collector, so a parse-failure marker
 * produced by any framing path is recognised here too (§5.2 rule 1).
 */
export { PARSE_ERROR_KEY } from '@agentlens/event-model'

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

export function arr(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return []
  const out: UnknownRecord[] = []
  for (const item of value) {
    const r = asRecord(item)
    if (r) out.push(r)
  }
  return out
}

/** Shallow string map for catalog shapes (`{names: string[], ...}`). */
export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export function messageOf(rec: UnknownRecord): UnknownRecord | null {
  return asRecord(rec.message)
}

export function attachmentOf(rec: UnknownRecord): UnknownRecord | null {
  return asRecord(rec.attachment)
}

export function contentBlocks(rec: UnknownRecord): UnknownRecord[] {
  const content = messageOf(rec)?.content
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return arr(content)
}

export function contentText(rec: UnknownRecord): string | null {
  const content = messageOf(rec)?.content
  if (typeof content === 'string') return content
  const parts = contentBlocks(rec)
    .map((b) => (b.type === 'text' ? str(b.text) : null))
    .filter((t): t is string => t !== null)
  return parts.length > 0 ? parts.join('\n') : null
}

export interface UsageDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** `message.usage` is snake_case upstream (§2.1); absent usage is not zero usage. */
export function usageOf(rec: UnknownRecord): UsageDraft | null {
  const u = asRecord(messageOf(rec)?.usage)
  if (!u) return null
  const details = asRecord(u.output_tokens_details)
  return {
    inputTokens: nonNeg(u.input_tokens),
    outputTokens: nonNeg(u.output_tokens),
    cacheReadTokens: nonNeg(u.cache_read_input_tokens),
    cacheWriteTokens: nonNeg(u.cache_creation_input_tokens),
    reasoningTokens: nonNeg(u.reasoning_tokens ?? u.thinking_tokens ?? details?.thinking_tokens),
  }
}

function nonNeg(value: unknown): number {
  const n = num(value)
  return n === null || n < 0 ? 0 : Math.trunc(n)
}

export function usageIsZero(u: UsageDraft): boolean {
  return (
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadTokens === 0 &&
    u.cacheWriteTokens === 0 &&
    u.reasoningTokens === 0
  )
}

export const SYNTHETIC_MODEL = '<synthetic>'

export function modelOf(rec: UnknownRecord): string | null {
  return str(messageOf(rec)?.model)
}

/** §2.2 / §1.5-2: `entrypoint` is the identity axis, not metadata. */
export function resolveHost(entrypoint: unknown): { hostId: string; diagnostic: string | null } {
  const e = str(entrypoint)
  if (e === 'cli') return { hostId: HOST_CLI, diagnostic: null }
  if (e === null || e === '') return { hostId: HOST_CLI, diagnostic: 'entrypoint-absent' }
  if (e === 'claude-desktop') return { hostId: HOST_DESKTOP, diagnostic: null }
  return { hostId: HOST_DESKTOP, diagnostic: `entrypoint-unknown:${e}` }
}

/** §4.1 / §3.1 — native requestId, else the per-record (session, uuid) fallback group key. */
export function resolveRequestId(rec: UnknownRecord, nativeSessionId: string | null): string | null {
  const native = str(rec.requestId)
  if (native) return native
  const uuid = str(rec.uuid)
  if (nativeSessionId && uuid) return `req#${nativeSessionId}/${uuid}`
  return null
}

/** Provider is fixed: this log format is emitted by Claude Code / Claude Desktop only. */
export function modelRef(name: string | null): { provider: string; name: string } | null {
  return name ? { provider: 'anthropic', name } : null
}

/** §5.2: the record's own time, or `null` — the caller then reports what stood in for it. */
export function timestampMs(rec: UnknownRecord): number | null {
  const iso = str(rec.timestamp)
  if (iso) {
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms)) return ms
  }
  const epoch = num(rec.timestamp)
  if (epoch !== null) return epoch < 1e11 ? epoch * 1000 : epoch
  return null
}

/**
 * Bounded metadata copy (§5.3 wants the raw JSON kept, §3.2/§6 forbid the
 * prompt_snapshot/file bodies that make up most of the 255 MB source).
 */
const MAX_STRING = 240
const OMIT_KEYS = new Set([
  'content',
  'text',
  'stdout',
  'stderr',
  'prompt',
  'pastedContents',
  'display',
  'diff',
  'message',
  'systemPrompt',
  'toolUseResult',
  'context_management',
  'container',
  'diagnostics',
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
    out[k] = OMIT_KEYS.has(k) && typeof v === 'string' ? `(omitted ${v.length}ch)` : redact(v, depth + 1)
  }
  return out
}

/** Tool-call payload text, capped so a huge `Agent` prompt cannot enter the DB. */
export function toolInputText(input: unknown): string {
  const json = safeStringify(input)
  return json.length > 4096 ? `${json.slice(0, 4096)}…(truncated)` : json
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function truncate(text: string, max = 16 * 1024): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** `mcp__<server>__<tool>` (§2.6). Returns null when the name is not MCP-shaped. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string; isPlugin: boolean } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const server = rest.slice(0, sep)
  const tool = rest.slice(sep + 2)
  if (!server || !tool) return null
  return { server, tool, isPlugin: server.startsWith('plugin_') || server.startsWith('plugin-') }
}

/** §2.4 path 4: `<command-name>/foo</command-name>` (bracketed variant seen in the census). */
const COMMAND_NAME_RE = /<command-name>\s*\[?\s*([^\]<\n]+)/
export function parseCommandName(text: string): string | null {
  const m = COMMAND_NAME_RE.exec(text)
  const raw = m?.[1]?.trim()
  if (!raw) return null
  return raw.replace(/^\//, '')
}

/** §2.4 path 3: `isMeta` injection opens with the skill's base directory. */
const SKILL_BASE_DIR_RE = /^Base directory for this skill:\s*(\S+)/
export function parseSkillBaseDir(text: string): string | null {
  const m = SKILL_BASE_DIR_RE.exec(text)
  return m?.[1] ?? null
}

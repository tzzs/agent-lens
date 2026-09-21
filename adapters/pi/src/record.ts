/**
 * Read-only view over an upstream Pi trace record.
 *
 * Field names come from docs/research/pi.md §二/§三 — the measured census is 6 files /
 * 358 records. Every accessor tolerates absence; nothing beyond that document is
 * inferred (§5.3: unknown shapes land in `unknown` + raw JSON, not a guessed mapping).
 */

export const AGENT_ID = 'pi'

/**
 * §4.1 host axis: Pi has one measured surface (the `pi` CLI) and the trace carries no
 * entrypoint analogue, so there is exactly one host id.
 */
export const HOST_PI = 'pi'

/** `session` header `version` measured at 3 on every one of the 6 files (§二.1). */
export const MEASURED_TRACE_VERSION = 3

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

export function arr(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return []
  const out: UnknownRecord[] = []
  for (const item of value) {
    const r = asRecord(item)
    if (r) out.push(r)
  }
  return out
}

/** Records with a non-string `type` are drift evidence too, so the value is kept as text. */
export function typeName(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (value === undefined || value === null || typeof value === 'object') return null
  return String(value)
}

/**
 * §二: every record's top-level `timestamp` is ISO text in the census. Epoch numbers are
 * accepted (seconds scaled) because the census cannot prove ISO is universal. `null` means the
 * record states no time, and §5.2 makes the caller say what stood in.
 */
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

export function recordIdOf(rec: UnknownRecord): string | null {
  return str(rec.id)
}

export function parentIdOf(rec: UnknownRecord): string | null {
  return str(rec.parentId)
}

/** The `session` header: native session id, cwd, upstream trace format version (§二.1). */
export function sessionIdOf(rec: UnknownRecord): string | null {
  return str(rec.id)
}

export function cwdOf(rec: UnknownRecord): string | null {
  return str(rec.cwd)
}

export function traceVersionOf(rec: UnknownRecord): number | null {
  return num(rec.version)
}

/** The nested `message` object carried by every `type: 'message'` record (§二.2-4). */
export function messageOf(rec: UnknownRecord): UnknownRecord | null {
  return asRecord(rec.message)
}

export function roleOf(message: UnknownRecord): string | null {
  return str(message.role)
}

export function contentParts(message: UnknownRecord): UnknownRecord[] {
  return arr(message.content)
}

/** §二: `model` and `provider` sit on the assistant message itself, per record. */
export function modelRefOf(message: UnknownRecord): { provider: string; name: string } | null {
  const name = str(message.model)
  if (!name) return null
  return { provider: str(message.provider) ?? 'unknown', name }
}

/**
 * §三 fold group key: Pi names each API response with `responseId` (155/160 measured;
 * the 5 without are zero-usage error/abort rows).
 */
export function responseIdOf(message: UnknownRecord): string | null {
  return str(message.responseId)
}

export function apiOf(message: UnknownRecord): string | null {
  return str(message.api)
}

export function stopReasonOf(message: UnknownRecord): string | null {
  return str(message.stopReason)
}

export function errorMessageOf(message: UnknownRecord): string | null {
  return str(message.errorMessage)
}

/**
 * §二: `stopReason` vocabulary measured on the census: toolUse / stop / aborted / error.
 * Only the two failure values map to `error`; an unseen value is drift, reported as
 * 'unknown' rather than silently treated as success.
 */
export function mapStopReason(reason: string | null): 'ok' | 'error' | 'unknown' {
  switch (reason) {
    case 'stop':
    case 'toolUse':
      return 'ok'
    case 'error':
    case 'aborted':
      return 'error'
    case null:
      return 'unknown'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------- tool pairing

/** The assistant `toolCall` part: `{type:'toolCall', id, name, arguments}` (§二.3). */
export function callPartIdOf(part: UnknownRecord): string | null {
  return str(part.id)
}

export function callPartNameOf(part: UnknownRecord): string | null {
  return str(part.name)
}

/** The `toolResult` message: `{toolCallId, toolName, isError, details?}` (§二.4). */
export function toolCallIdOf(message: UnknownRecord): string | null {
  return str(message.toolCallId)
}

export function toolNameOf(message: UnknownRecord): string | null {
  return str(message.toolName)
}

export function isErrorOf(message: UnknownRecord): boolean | null {
  return typeof message.isError === 'boolean' ? message.isError : null
}

// ---------------------------------------------------------------- usage / cost

export interface UsageDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Which documented fields actually carried numbers. */
  reportedFields: string[]
  /** Numeric keys present but not mapped — `totalTokens` lives here (§三). */
  unmappedFields: string[]
}

/**
 * §三: the measured usage vocabulary is `input, output, cacheRead, cacheWrite,
 * totalTokens, cost`. Only the four disjoint buckets are mapped:
 *  - `totalTokens` is a derived roll-up (verified: equals the four-bucket sum on
 *    160/160 records); folding it as a fifth bucket is the cumulative trap (§18 row 2).
 *  - `cost` is an object, consumed separately via `costOf`, never as tokens.
 * The four buckets are DISJOINT (`input` excludes cache reads, pi.md §三), so they sum
 * as-is; `test/dedupe.test.ts` asserts this reading against the fixture.
 */
const USAGE_FIELD_MAP: Readonly<
  Record<string, keyof Pick<UsageDraft, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>>
> = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
}

export function usageOf(message: UnknownRecord): UsageDraft | null {
  const u = asRecord(message.usage)
  if (!u) return null
  const draft: UsageDraft = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reportedFields: [],
    unmappedFields: [],
  }
  for (const [key, value] of Object.entries(u)) {
    if (typeof value === 'object') continue // `cost` rides costOf(); an object is not a bucket
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    const mapped = USAGE_FIELD_MAP[key]
    if (mapped && typeof value === 'number') {
      draft[mapped] = value < 0 ? 0 : Math.trunc(value)
      draft.reportedFields.push(key)
    } else if (typeof value === 'number' || typeof value === 'string') {
      draft.unmappedFields.push(key)
    }
  }
  // "absent" and "zero" are different facts (§4.4 row 1): an object-shaped `usage` with
  // none of the four known counters is not usage.
  return draft.reportedFields.length > 0 ? draft : null
}

export interface CostDraft {
  total: number | null
  /** The per-bucket breakdown as reported (pi.md §三: total == sum of parts, 160/160). */
  breakdown: Record<string, number> | null
}

export function costOf(message: UnknownRecord): CostDraft | null {
  const u = asRecord(message.usage)
  const c = asRecord(u?.cost)
  if (!c) return null
  const breakdown: Record<string, number> = {}
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' && Number.isFinite(v)) breakdown[k] = v
  }
  return { total: num(c.total), breakdown: Object.keys(breakdown).length ? breakdown : null }
}

// ---------------------------------------------------------------- text helpers

/** Flatten the `text`/`thinking` string bodies of content parts of one type. */
export function partText(parts: UnknownRecord[], type: string): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (str(p.type) !== type) continue
    const t = str(p.text) ?? str(p.thinking)
    if (t) out.push(t)
  }
  return out
}

/**
 * §5.3 keeps the raw JSON for unrecognized records, §3.2/§6 forbid the payload bulk.
 * Pi tool results and prompts carry whole file bodies, so heavy keys are reduced to a
 * size marker instead of being copied.
 */
const MAX_STRING = 240
const OMIT_KEYS = new Set(['content', 'text', 'thinking', 'arguments', 'details', 'message', 'prompt'])

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

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Tool payload cap: one `arguments` blob must not dwarf the whole metric layer. */
export function toolText(value: unknown): string {
  const json = typeof value === 'string' ? value : safeStringify(value)
  return json.length > 4096 ? `${json.slice(0, 4096)}…(truncated)` : json
}

export function truncate(text: string, max = 16 * 1024): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

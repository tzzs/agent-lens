/**
 * Read-only view over an upstream WorkBuddy trace record.
 *
 * Field names come from docs/research/workbuddy.md §四 — the entire measured census is
 * 2 files / 52 records, so every accessor tolerates absence and nothing beyond that
 * document is inferred (§5.3: unknown shapes must land in `unknown` + raw JSON, not in
 * a guessed mapping).
 */

export const AGENT_ID = 'workbuddy'

/**
 * §4.1: `host_id` names the product surface that emitted a record (Claude Code splits
 * `claude-code` / `claude-desktop`). WorkBuddy traces carry no `entrypoint` analogue,
 * so exactly one surface is measured and `__codebuddyLocal` is kept as provenance
 * metadata rather than promoted to a second host id: the CodeBuddy lineage is the
 * report's own hedge ("疑为 CodeBuddy 系衍生"), and splitting identity on an unverified
 * field name is how a host axis silently doubles or halves a session count.
 */
export const HOST_WORKBUDDY = 'workbuddy'

/** The one marker the census does show on local records. */
export const CODEBUDDY_LOCAL_MARKER = '__codebuddyLocal'

export { PARSE_ERROR_KEY } from '@agentlens/collector'

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

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** Records with a non-string `type` are drift evidence too, so the value is kept as text. */
export function typeName(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (value === undefined || value === null || typeof value === 'object') return null
  return String(value)
}

/**
 * `timestamp` is a documented top-level key; the census does not say whether it is ISO
 * text or an epoch. Both are accepted, and a seconds-epoch is scaled.
 */
export function timestampMs(rec: UnknownRecord, fallback: number): number {
  const iso = str(rec.timestamp)
  if (iso) {
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms)) return ms
  }
  const epoch = num(rec.timestamp)
  if (epoch !== null) return epoch < 1e11 ? epoch * 1000 : epoch
  return fallback
}

/**
 * §4.1 host axis; see HOST_WORKBUDDY for why the marker does not create a second host.
 * A missing marker is reported as a diagnostic rather than treated as a different surface.
 */
export function resolveHost(rec: UnknownRecord): { hostId: string; marker: boolean | null; diagnostics: string[] } {
  const raw = rec[CODEBUDDY_LOCAL_MARKER]
  const diagnostics: string[] = []
  let marker: boolean | null = null
  if (typeof raw === 'boolean') marker = raw
  else if (raw === undefined) diagnostics.push('codebuddy-local-marker-absent')
  else diagnostics.push(`codebuddy-local-marker-not-boolean:${typeof raw}`)
  return { hostId: HOST_WORKBUDDY, marker, diagnostics }
}

/**
 * `cwd` is a documented top-level key (§四). Project grouping goes through the
 * event-model's three-step canonicalization, never through `sessions.project_id`, which
 * the report could only note as "exists", not as a canonical repo root (§三).
 */
export function cwdOf(rec: UnknownRecord): string | null {
  return str(rec.cwd)
}

export function sessionIdOf(rec: UnknownRecord): string | null {
  return str(rec.sessionId)
}

export function callIdOf(rec: UnknownRecord): string | null {
  return str(rec.callId)
}

export function parentIdOf(rec: UnknownRecord): string | null {
  return str(rec.parentId)
}

export function nameOf(rec: UnknownRecord): string | null {
  return str(rec.name)
}

export function roleOf(rec: UnknownRecord): string | null {
  return str(rec.role)
}

/** The `providerData` blob is the documented home of provider-side detail; nesting inside it is not specified. */
export function providerDataOf(rec: UnknownRecord): UnknownRecord | null {
  return asRecord(rec.providerData)
}

/**
 * §18 row 4: provider/model must be resolved per adapter and never assumed from the cache
 * dialect. WorkBuddy names its cache field Anthropic-style, but no provider field is
 * documented, so an unnamed provider stays 'unknown' — an unpriced model yields cost
 * NULL, while a wrong provider would silently pick a price sheet (§8: never fake a number).
 */
export function modelRefOf(rec: UnknownRecord): { provider: string; name: string } | null {
  const pd = providerDataOf(rec)
  const name = str(pd?.model) ?? str(pd?.modelId) ?? str(pd?.model_id) ?? str(rec.model)
  if (!name) return null
  return { provider: str(pd?.provider) ?? str(rec.provider) ?? 'unknown', name }
}

/**
 * Native request/response id when the blob carries one; used as the token fold group key
 * so a usage object echoed by two records of one request collapses (§3.1).
 */
export function nativeRequestIdOf(rec: UnknownRecord): string | null {
  const pd = providerDataOf(rec)
  return (
    str(pd?.requestId) ??
    str(pd?.request_id) ??
    str(pd?.responseId) ??
    str(pd?.response_id) ??
    str(pd?.id)
  )
}

/** §四 records a `status` key; its value vocabulary was not measured, so this is a tolerant map. */
export function mapStatus(value: unknown): 'ok' | 'error' | 'unknown' {
  const s = str(value)?.toLowerCase()
  if (!s) return 'unknown'
  if (s === 'ok' || s === 'success' || s === 'succeeded' || s === 'completed' || s === 'done' || s === 'finished') {
    return 'ok'
  }
  if (s === 'error' || s === 'failed' || s === 'failure' || s === 'cancelled' || s === 'canceled') return 'error'
  return s.includes('error') || s.includes('fail') ? 'error' : 'unknown'
}

export interface UsageDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Stays 0 for WorkBuddy: the trace has no cache-write field (§四). */
  cacheWriteTokens: number
  reasoningTokens: number
  /** Which documented fields actually carried numbers. */
  reportedFields: string[]
  /** Numeric keys present but not mapped — the drift signal for a fifth cache dialect (§18 row 4). */
  unmappedFields: string[]
}

/**
 * §四: the documented usage vocabulary is `input_tokens, output_tokens, total_tokens,
 * cache_read_input_tokens`. Only three of those are mapped:
 *  - `total_tokens` is a derived roll-up of the others; folding it as a fifth token bucket
 *    is the Codex-style cumulative trap (§18 row 2, ~1971x), so it is never summed.
 *  - there is no cache-write and no reasoning field, so those buckets stay absent —
 *    recorded in `reportedFields`/`unmappedFields` rather than fabricated as measured zeros.
 * `input_tokens` is treated as DISJOINT from `cache_read_input_tokens` (Anthropic
 * semantics, which the field naming follows); §18 row 4 requires this assumption to be
 * asserted by a test, which `test/dedupe.test.ts` does against `shared-usage.jsonl`.
 */
const USAGE_FIELD_MAP: Readonly<Record<string, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>> = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_read_input_tokens: 'cacheReadTokens',
}

/**
 * The census lists `providerData` as a top-level key and names the usage fields without
 * saying where they sit, so all three plausible sites are accepted and the one that hit
 * is recorded in metadata — a wrong guess becomes visible drift, not a silent 0.
 */
export type UsageSite = 'usage' | 'providerData.usage' | 'providerData'

export function usageOf(
  rec: UnknownRecord,
): { draft: UsageDraft; site: UsageSite } | null {
  const pd = providerDataOf(rec)
  const sites: readonly [UsageSite, UnknownRecord | null][] = [
    ['usage', asRecord(rec.usage)],
    ['providerData.usage', asRecord(pd?.usage)],
    ['providerData', pd],
  ]
  for (const [site, raw] of sites) {
    if (!raw) continue
    const draft = mapUsage(raw)
    if (draft) return { draft, site }
  }
  return null
}

function mapUsage(u: UnknownRecord): UsageDraft | null {
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
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    const mapped = USAGE_FIELD_MAP[key]
    if (mapped && typeof value === 'number') {
      draft[mapped] = value < 0 ? 0 : Math.trunc(value)
      draft.reportedFields.push(key)
    } else if (typeof value === 'number' || typeof value === 'string') {
      draft.unmappedFields.push(key)
    }
  }
  // An object-shaped `usage` with none of the three known counters is not usage; §4.4 row 1's
  // lesson is that "absent" and "zero" are different facts.
  return draft.reportedFields.length > 0 ? draft : null
}

/** Text of `content` / `rawContent` / `output`, which the census shows but does not type. */
export function textOf(...values: unknown[]): string | null {
  for (const value of values) {
    const t = flattenText(value)
    if (t !== null) return t
  }
  return null
}

function flattenText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') return item
        const r = asRecord(item)
        if (!r) return null
        return flattenText(r.text) ?? flattenText(r.content) ?? (typeof r.output === 'string' ? r.output : null)
      })
      .filter((p): p is string => p !== null && p !== '')
    return parts.length > 0 ? parts.join('\n') : null
  }
  const rec = asRecord(value)
  if (!rec) return null
  return flattenText(rec.text) ?? flattenText(rec.content) ?? null
}

/**
 * §5.3 keeps the raw JSON for unrecognized records, §3.2/§6 forbid the payload bulk that
 * makes those files huge. WorkBuddy traces are execution traces whose `output`,
 * `rawContent`, `arguments` and `snapshot` fields carry whole file bodies, so those keys
 * are reduced to a size marker instead of being copied.
 */
const MAX_STRING = 240
const OMIT_KEYS = new Set([
  'content',
  'rawContent',
  'output',
  'arguments',
  'snapshot',
  'text',
  'prompt',
  'message',
  'diff',
  'systemPrompt',
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

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Tool payload cap: a single `arguments` blob must not dwarf the whole metric layer. */
export function toolText(value: unknown): string {
  const json = typeof value === 'string' ? value : safeStringify(value)
  return json.length > 4096 ? `${json.slice(0, 4096)}…(truncated)` : json
}

export function truncate(text: string, max = 16 * 1024): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Read-only view over an upstream Qoder JSONL record. Field names come from
 * docs/research/qoder-opencode.md §1.1–1.3 (4,845 files / 14,742 records / 38
 * sessions sampled); every accessor tolerates absence because Qoder inherits
 * Claude's 2.1.x drift (§5.3).
 */

export const AGENT_ID = 'qoder'

/**
 * The measured store carries an `entrypoint` key whose only observed value is
 * `cli` (11,215 records) plus absence on host-metadata records (4,856) — no
 * second host exists on this machine yet. Rather than invent a split we do not
 * measure, every event gets this uniform host, and unknown values are flagged
 * as diagnostics instead of silently re-labelled (§18 row 6).
 */
export const HOST_QODER = 'qoder'

/** Placeholder model marker inherited from the fork (§4.4 row 6). */
export const SYNTHETIC_MODEL = '<synthetic>'

/**
 * The one parse-error marker convention lives in the collector, so a malformed
 * line framed by any reader path is recognised here too (§5.2 rule 1).
 */
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

export interface QoderUsage {
  tokens: UsageDraft
  /** Credit-economy fields (§18 rows 1–2); present on every measured usage object. */
  credits: number | null
  originalCredits: number | null
  billable: boolean | null
  contextUsageRatio: number | null
  requestId: string | null
  billing: UnknownRecord | null
  /**
   * A genuine monetary amount, if the record carries one in a currency-bearing
   * field. Credits are NOT dollars (§18 rows 1–2): `credits` never populates
   * this, so `costReported` can only come from an explicit money field — none
   * of which exists in the measured sample, keeping §8's computed-cost path
   * the live one.
   */
  money: number | null
}

export interface UsageDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/**
 * `message.usage` is Anthropic-named in the fork: `cache_read_input_tokens` /
 * `cache_creation_input_tokens` (§18 row 4 dialect 1). Input does NOT include
 * cached tokens — asserted by test.
 */
export function usageOf(rec: UnknownRecord): QoderUsage | null {
  const u = asRecord(messageOf(rec)?.usage)
  if (!u) return null
  const details = asRecord(u.output_tokens_details)
  return {
    tokens: {
      inputTokens: nonNeg(u.input_tokens),
      outputTokens: nonNeg(u.output_tokens),
      cacheReadTokens: nonNeg(u.cache_read_input_tokens),
      cacheWriteTokens: nonNeg(u.cache_creation_input_tokens),
      reasoningTokens: nonNeg(u.reasoning_tokens ?? u.thinking_tokens ?? details?.thinking_tokens),
    },
    credits: num(u.credits),
    originalCredits: num(u.original_credits),
    billable: typeof u.billable === 'boolean' ? u.billable : null,
    contextUsageRatio: num(u.context_usage_ratio),
    requestId: str(u.request_id) ?? str(u.requestId),
    money: moneyOf(u),
    billing: {
      service_tier: u.service_tier ?? null,
      inference_geo: u.inference_geo ?? null,
      speed: u.speed ?? null,
      iterations: Array.isArray(u.iterations) ? u.iterations.length : u.iterations ?? null,
    },
  }
}

/**
 * Currency-bearing field names. Qoder's measured usage objects carry none of
 * these — this list exists so a future fork that starts reporting real money
 * is adopted correctly instead of being guessed from credits (§18 row 1).
 */
const MONEY_KEYS = ['cost_usd', 'usd_cost', 'amount_usd', 'cost'] as const

function moneyOf(u: UnknownRecord): number | null {
  for (const key of MONEY_KEYS) {
    const n = num(u[key])
    if (n !== null) return n
  }
  return null
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

export function modelOf(rec: UnknownRecord): string | null {
  return str(messageOf(rec)?.model)
}

/**
 * Host resolution keeps the `entrypoint` axis wired (§18 row 6) even while only
 * one value is measured: new hosts then surface as diagnostics on `qoder`-hosted
 * events instead of an invented category, and the day Qoder ships a desktop
 * shell the mapping slot already exists.
 */
export function resolveHost(entrypoint: unknown): { hostId: string; diagnostic: string | null } {
  const e = str(entrypoint)
  if (e === null || e === '' || e === 'cli') return { hostId: HOST_QODER, diagnostic: e === null ? 'entrypoint-absent' : null }
  return { hostId: HOST_QODER, diagnostic: `entrypoint-unknown:${e}` }
}

/**
 * §18 row 2 / §4.1: requestId is taken natively only — `usage.request_id`
 * (measured: exactly one per usage record, 0 dupes, 0 missing in the sample)
 * or the `requestTokenAnchor` the fork stamps per request. Never fabricated
 * from a uuid: a wrong group key silently doubles token totals.
 */
export function resolveRequestId(rec: UnknownRecord, usage: QoderUsage | null): string | null {
  return usage?.requestId ?? str(rec.requestTokenAnchor) ?? str(rec.requestId)
}

/** Provider is fixed: this log format is emitted by Qoder only (§1.1 census). */
export function modelRef(name: string | null): { provider: string; name: string } | null {
  return name ? { provider: 'anthropic', name } : null
}

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
 * Bounded metadata copy: §5.3 wants the raw JSON kept for drift review, §3.2/§6
 * forbid the prompt/file bodies that make up most of the source bytes.
 */
const MAX_STRING = 240
const OMIT_KEYS = new Set([
  'content',
  'text',
  'stdout',
  'stderr',
  'prompt',
  'display',
  'diff',
  'message',
  'toolUseResult',
  'directories',
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

/** `mcp__<server>__<tool>` — the fork keeps Claude's MCP naming (probe: ~87 refs). */
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

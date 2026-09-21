/**
 * Read-only view over an upstream Codex rollout record.
 *
 * Field names come from docs/research/codex.md's census (379 files / 221,416 records /
 * 571 MB). Accessors tolerate absence because the format drifts INSIDE Codex: the older
 * `event_msg.token_count` (42,896) and the newer top-level `token_usage_record` (14)
 * coexist, and the latter moved the granularity to three levels.
 */
import type { Usage } from '@agentlens/event-model'

export const AGENT_ID = 'codex'

/** The one marker convention lives in the collector, so any framing path is recognised. */
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

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/**
 * Most Codex semantics hide one level down: `session_meta`/`turn_context`/`response_item`/
 * `event_msg` carry the real type in `payload.type` (codex.md §2.1). The new
 * `token_usage_record` writes its fields at the top level, so callers may pass either.
 */
export function payloadOf(rec: UnknownRecord): UnknownRecord {
  return asRecord(rec.payload) ?? rec
}

/** `payload.type` is the semantic type; the top-level `type` is the envelope. */
export function innerTypeOf(rec: UnknownRecord): string | null {
  return typeName(payloadOf(rec).type)
}

/** §5.3: a non-string type is drift evidence too, so it is kept as text rather than lost. */
export function typeName(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (value === undefined || value === null || typeof value === 'object') return null
  return String(value)
}

// ---------------------------------------------------------------- hosts (§18 row 6)

export const HOST_DESKTOP = 'codex-desktop'
export const HOST_TUI = 'codex-tui'
export const HOST_EXEC = 'codex-exec'
export const HOST_CLI_RS = 'codex-cli-rs'
export const HOST_UNKNOWN = 'codex-unknown'

/** codex.md §2.3: exactly four `originator` values were observed across 379 threads. */
const KNOWN_HOSTS: readonly string[] = [HOST_DESKTOP, HOST_TUI, HOST_EXEC, HOST_CLI_RS]

/** Lower-case, `-`-separated slug; `Codex Desktop`/`codex_exec`/`codex_cli_rs` all land well. */
export function slugOriginator(originator: string): string {
  return originator
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * §18 row 6: `originator` is Codex's host axis (Desktop 343 / tui 15 / exec 13 / cli_rs 8
 * share one rollout format). An unrecognised value must never vanish, so it lands on
 * `codex-unknown` with the raw string reported in the diagnostic the caller stores.
 */
export function resolveHost(originator: unknown): { hostId: string; diagnostic: string | null } {
  const raw = str(originator)
  if (raw === null || raw.trim() === '') return { hostId: HOST_UNKNOWN, diagnostic: 'originator-absent' }
  const slug = slugOriginator(raw)
  if (KNOWN_HOSTS.includes(slug)) return { hostId: slug, diagnostic: null }
  return { hostId: HOST_UNKNOWN, diagnostic: `originator-unknown:${raw}` }
}

// ---------------------------------------------------------------- usage (§18 rows 2 & 4)

/**
 * §18 row 2 / codex.md §一: which fields are PER CALL. Every sibling is a running total:
 * `total_token_usage` (whole thread), `turn_token_usage` (whole turn),
 * `thread_token_usage` (whole thread). Folding a cumulative field inflates ~1971x.
 */
export const PER_CALL_FIELDS: readonly string[] = ['last_token_usage', 'usage']

/** Cumulative siblings; kept for display, never summed. */
export const CUMULATIVE_FIELDS: readonly string[] = [
  'total_token_usage',
  'turn_token_usage',
  'thread_token_usage',
]

/** Codex's six-token dialect (codex.md §2.5). */
export interface CodexUsageObject {
  input_tokens?: unknown
  cached_input_tokens?: unknown
  cache_write_input_tokens?: unknown
  output_tokens?: unknown
  reasoning_output_tokens?: unknown
  total_tokens?: unknown
}

export interface UsageRow {
  usage: Usage
  /** Whether the reported per-call object carries any token at all. */
  isZero: boolean
  /**
   * §18 row 4: Codex's `input_tokens` ALREADY INCLUDES `cached_input_tokens`, while the
   * shared `events.input_tokens` column is priced as NET input (`packages/pricing/cost.ts`
   * multiplies it by `inputPerMTok` and `cache_read_tokens` separately by
   * `cacheReadPerMTok`). Emitting the reported value would therefore bill the cached prefix
   * twice and make Codex totals incomparable with Claude, whose `input_tokens` excludes
   * cache. So `inputTokens` is emitted as the remainder and the raw value kept for audit.
   */
  reportedInputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  reportedTotalTokens: number | null
  /**
   * Does `reasoning_output_tokens` live inside `output_tokens`? Decided per record from the
   * row's own `total_tokens` instead of guessed: the unified `Usage` has no subset flag, and
   * the query layer's grand total adds all five fields.
   */
  reasoningOverlap: 'separate' | 'included-in-output' | null
}

export function usageRow(source: UnknownRecord | null): UsageRow | null {
  if (!source) return null
  const o = source as CodexUsageObject
  const reportedInput = nonNeg(o.input_tokens)
  const cachedInput = nonNeg(o.cached_input_tokens)
  const cacheWrite = nonNeg(o.cache_write_input_tokens)
  const output = nonNeg(o.output_tokens)
  const reasoning = nonNeg(o.reasoning_output_tokens)
  const reportedTotal = num(o.total_tokens) === null ? null : nonNeg(o.total_tokens)
  const netInput = Math.max(0, reportedInput - cachedInput)
  return {
    usage: {
      inputTokens: netInput,
      outputTokens: output,
      cacheReadTokens: cachedInput,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
    },
    isZero: reportedInput === 0 && cachedInput === 0 && cacheWrite === 0 && output === 0 && reasoning === 0,
    reportedInputTokens: reportedInput,
    cachedInputTokens: cachedInput,
    cacheWriteInputTokens: cacheWrite,
    reportedTotalTokens: reportedTotal,
    reasoningOverlap: overlap(reportedTotal, reportedInput, output, reasoning),
  }
}

function overlap(total: number | null, input: number, output: number, reasoning: number): UsageRow['reasoningOverlap'] {
  if (total === null || reasoning === 0) return null
  if (total === input + output + reasoning) return 'separate'
  if (total === input + output) return 'included-in-output'
  return null
}

function nonNeg(value: unknown): number {
  const n = num(value)
  return n === null || n < 0 ? 0 : Math.trunc(n)
}

/** The per-call object of a container, plus which field name it came from. */
export function pickPerCall(container: UnknownRecord): { field: string; row: UsageRow } | null {
  for (const field of PER_CALL_FIELDS) {
    const obj = asRecord(container[field])
    const row = usageRow(obj)
    if (row) return { field, row }
  }
  return null
}

/**
 * Cumulative snapshot for display only (§18 row 2). Absent fields are omitted so the
 * metadata stays small and the shape of the source format is still legible.
 */
export function cumulativeSnapshot(container: UnknownRecord): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const field of CUMULATIVE_FIELDS) {
    const obj = asRecord(container[field])
    if (obj) out[field] = numbersOf(obj)
  }
  const window = num(container.model_context_window)
  if (window !== null) out.model_context_window = window
  return Object.keys(out).length > 0 ? out : null
}

function numbersOf(obj: UnknownRecord): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) {
    const n = num(v)
    if (n !== null) out[k] = n
  }
  return out
}

// ---------------------------------------------------------------- models

/** Placeholder model ids observed upstream; billing attribution must not use them. */
const PLACEHOLDER_MODELS = new Set(['<unknown>', '<synthetic>', '<placeholder>', 'unknown', ''])

/** codex.md §一 风险 5: `r1` / `resp_1` are synthetic response ids. */
const PLACEHOLDER_RESPONSE_IDS = new Set(['r1', 'resp_1'])

export function isPlaceholderModel(name: string | null | undefined): boolean {
  return name === null || name === undefined || PLACEHOLDER_MODELS.has(name.trim())
}

export function isPlaceholderResponseId(id: string | null): boolean {
  return id !== null && PLACEHOLDER_RESPONSE_IDS.has(id.trim())
}

export function modelRef(provider: string | null, name: string | null): { provider: string; name: string } | null {
  if (isPlaceholderModel(name)) return null
  // codex.md §2.3: `model_provider` is `openai` for 364 threads and the custom `agentx`
  // for 15; the provider is the only truthful axis, so an absent one stays absent.
  return { provider: provider ?? 'openai', name: String(name) }
}

// ---------------------------------------------------------------- misc helpers

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

/**
 * Bounded metadata copy: §5.3 wants the raw JSON kept for unknown records, but a rollout
 * file averages 1.5 MB and `base_instructions` / `replacement_history` carry whole prompts
 * and file bodies (§3.2/§6 forbid those in the metric layer).
 */
const MAX_STRING = 240
const OMIT_KEYS = new Set([
  'base_instructions',
  'content',
  'prompt',
  'instructions',
  'input_text',
  'output_text',
  'summary_content',
  'patch',
  'replacement_history',
  'text',
  'output',
  'arguments',
  'input',
  'agents_md',
  'instruction',
  'message',
  'summary',
  'diff',
  'stdout',
  'stderr',
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

/** Tool-call payload text, capped so a huge `apply_patch` body cannot enter the DB. */
export function toolText(value: unknown): string {
  const text = typeof value === 'string' ? value : safeStringify(value)
  return text.length > 4096 ? `${text.slice(0, 4096)}…(truncated)` : text
}

/** Codex message content is Responses-API shaped: `input_text` / `output_text` / `text`. */
export function blocksOf(payload: UnknownRecord): UnknownRecord[] {
  const content = payload.content ?? payload.output
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const blocks = arr(content)
  if (blocks.length > 0) return blocks
  // A `reasoning` item keeps its readable part in `summary_content` and leaves `content`
  // empty, so the summary is the same block list under another key.
  return arr(payload.summary_content ?? payload.summary)
}

export function blocksText(payload: UnknownRecord): string | null {
  const parts = blocksOf(payload)
    .map((b) => str(b.text) ?? str(b.input_text) ?? str(b.output_text) ?? str(b.summary))
    .filter((t): t is string => t !== null)
  if (parts.length > 0) return parts.join('\n')
  return str(payload.message) ?? str(payload.text)
}

/** ISO-8601 at the envelope level, like Claude's; epoch seconds appear in `payload`. */
export function timestampMs(rec: UnknownRecord, payload: UnknownRecord): number | null {
  for (const value of [rec.timestamp, payload.timestamp]) {
    if (typeof value === 'string') {
      const ms = Date.parse(value)
      if (!Number.isNaN(ms)) return ms
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e11 ? value * 1000 : value
    }
  }
  return null
}

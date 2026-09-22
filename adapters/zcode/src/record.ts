/**
 * Read-only views over ZCode's SQLite rows. The DDL below is the measured shape of
 * `~/.zcode/cli/db/db.sqlite` (docs/research/zcode.md §一/§五, re-verified against a
 * rollback-mode snapshot on 2026-09-22):
 *
 *   session(id PK, project_id, workspace_id, parent_id, slug, directory, path, title,
 *           version, share_url, summary_*, revert, permission, time_created, time_updated,
 *           time_compacting, time_archived, task_type, title_source, title_message_id,
 *           time_title_updated, trace_id)
 *   message(id PK, session_id FK, time_created, time_updated, data, sequence)   -- data is JSON
 *   part(id PK, message_id FK, session_id, time_created, time_updated, data, sequence)
 *   model_usage(id PK, logical_request_id, attempt_index, session_id FK, turn_id, trace_id,
 *           span_id, assistant_message_id, parent_user_message_id, query_source, provider_id,
 *           model_id, variant, agent, mode, task_type, status, started_at, first_token_at,
 *           completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count,
 *           input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
 *           cache_read_input_tokens, provider_total_tokens, computed_total_tokens, retry_count,
 *           retryable, cancelled_by_user, context_exceeded, error_type, error_code,
 *           error_message, raw_usage_json, provider_metadata_json)
 *   tool_usage(id PK, session_id FK, turn_id, trace_id, tool_call_id, tool_name,
 *           side_effect_scope, read_only, destructive, approval_status, status, started_at,
 *           first_output_at, completed_at, duration_ms, time_to_first_output_ms, exit_code,
 *           output_bytes, stdout_bytes, stderr_bytes, truncated, retry_count, retryable,
 *           cancelled_by_user, error_type, error_code, error_message)
 *
 * Two consequences the mappers rely on:
 *  - `session` carries **no** `cost`/`tokens_*` columns (unlike OpenCode's), so the only
 *    session-grain numbers are in tables this adapter deliberately does not read (§三);
 *  - `message`/`part` per-row facts live in the `data` JSON blob while the relational keys
 *    (`session_id`, `message_id`) are columns, exactly as in OpenCode — hence its `parse`
 *    joins and the shared `data`-shape helpers below.
 */

export const AGENT_ID = 'zcode'
/**
 * §18 row 6 asks for an entrypoint→host table, but `session` has no entrypoint/origin/
 * platform column and §二 measured that 10/10 root sessions here are desktop-app tasks
 * even though all the data sits under a directory named `cli/`. The cross-store join that
 * would prove per-event host cannot be done inside one source either, so the honest value
 * is the single product host.
 */
export const HOST_ID = 'zcode'

export const TABLE_SESSION = 'session'
export const TABLE_MESSAGE = 'message'
export const TABLE_PART = 'part'
export const TABLE_MODEL_USAGE = 'model_usage'
export const TABLE_TOOL_USAGE = 'tool_usage'
export const TABLES = [
  TABLE_SESSION,
  TABLE_MESSAGE,
  TABLE_PART,
  TABLE_MODEL_USAGE,
  TABLE_TOOL_USAGE,
] as const
export type ZcodeTable = (typeof TABLES)[number]

/**
 * The row-kind label the sixth source's records carry in `__table` / `metadata.table`
 * (§八·5a). It is NOT a SQLite table and NOT in `TABLES`: `cli/agents/…/metadata.json` is a
 * file tree, and putting its name in the table list would hand `detect`'s required-tables
 * check and the collector's rowid framing something the store does not have.
 */
export const TABLE_AGENT_METADATA = 'agents_metadata'

/**
 * §三/§七: present in the store, never a source. Each is a rollup or rollup-ish table
 * whose numbers are restatements of what `model_usage`/`tool_usage` already say, so
 * reading one as a source would double count. Anything they carry that is worth keeping
 * as evidence goes to `metadata.rollup`, never to `usage`.
 */
export const NON_SOURCE_TABLES: readonly string[] = [
  'turn_usage',
  'session_target',
  'session_entry',
  'input_history',
  'todo',
  'local_setting',
  'schema_migration',
]

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

/** SQLite boolean columns: NULL stays unknown, so this is three-valued on purpose. */
export function bool(value: unknown): boolean | null {
  if (value === 1 || value === true) return true
  if (value === 0 || value === false) return false
  return null
}

/**
 * ZCode stores **epoch ms** in its time columns (measured: `started_at` 1789244988278).
 * The sub-1e11 branch is a guard, not the expected path: it is what keeps an upstream
 * switch to seconds from silently producing 1970 timestamps.
 */
export function ms(value: unknown): number | null {
  const n = num(value)
  if (n === null || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * The one ISO-8601 dialect this adapter reads (§八·5a): `cli/agents/…/metadata.json` writes
 * `createdAt`/`completedAt` as `"2026-09-13T12:35:47.705Z"` while every SQLite column is
 * epoch ms, so the two readers are separate by name — confusing them puts a subagent's close
 * 55 years off. `cli/rollout/` is ISO too and stays unread (§六).
 */
export function iso(value: unknown): number | null {
  const text = str(value)
  if (text === null || text === '') return null
  const n = Date.parse(text)
  // An unparseable date stays NULL rather than becoming 0: 1970 would answer a question the
  // document never asked, and NaN would poison the timestamp.
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parseJson(value: unknown): UnknownRecord | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

/** `message.data` spells the model two ways: flat on assistant rows, nested on user rows. */
export function modelRefOf(data: UnknownRecord | null | undefined, columns: UnknownRecord | null = null) {
  const nested = asRecord(data?.model)
  const name =
    str(columns?.__message_model_id) ??
    str(data?.modelID) ??
    str(data?.modelId) ??
    str(nested?.modelID)
  if (!name) return null
  const provider =
    str(columns?.__message_provider_id) ??
    str(data?.providerID) ??
    str(data?.providerId) ??
    str(nested?.providerID)
  const tier =
    str(columns?.__message_variant) ?? str(data?.variant) ?? str(nested?.variant) ?? null
  return { provider: provider ?? 'unknown', name, tier }
}

// ------------------------------------------------------------- token dialect

/**
 * §18 row 4's fifth cache dialect: the COLUMN NAMES are Anthropic's
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`) but the SEMANTICS are
 * Codex's — `input_tokens` already CONTAINS `cache_read_input_tokens`. Measured over all
 * 1,395 `model_usage` rows (§四):
 *
 *   computed_total_tokens == input_tokens + output_tokens      1395/1395  ← holds
 *   computed_total_tokens == input + output + cache_read          40/1395  ← only the cache_read=0 rows
 *   cache_read_input_tokens <= input_tokens                      1395/1395
 *
 * and ccusage's independent split of the same store reproduces
 * `166,230,363 − 158,848,192 = 7,382,171` exactly. So the mapping must SUBTRACT.
 *
 * The mechanism is visible in one row's `raw_usage_json`: the provider said
 * `{input_tokens: 98, cache_read_input_tokens: 192}` and the engine stored
 * `input_tokens = 290`, `cache_read_input_tokens = 192`, `computed_total = 290 + 84 = 374`
 * — i.e. it folded the cached buckets back into `input_tokens` and kept them alongside.
 */
export interface UsageDraft {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** True only when at least one token column is present: absent must not read as 0. */
  present: boolean
  /** The columns that exist for reconciliation but must never enter `usage` (§四). */
  rollup: { provider_total_tokens: number | null; computed_total_tokens: number | null }
}

const EMPTY_DRAFT: UsageDraft = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  present: false,
  rollup: { provider_total_tokens: null, computed_total_tokens: null },
}

function nonNeg(value: unknown): number {
  const n = num(value)
  return n === null || n < 0 ? 0 : Math.trunc(n)
}

/**
 * The ONLY place a number becomes `usage` in this adapter (§三 rule 1).
 *
 * `provider_total_tokens`/`computed_total_tokens` are returned separately as `rollup`
 * because they are sums of the very fields being mapped: folding them into `usage`
 * would double the bill on every row.
 */
export function usageFromModelUsage(row: UnknownRecord | null): UsageDraft {
  if (row === null) return EMPTY_DRAFT
  const hasAny =
    row.input_tokens !== undefined ||
    row.output_tokens !== undefined ||
    row.cache_read_input_tokens !== undefined ||
    row.cache_creation_input_tokens !== undefined
  if (!hasAny) return EMPTY_DRAFT
  const cacheRead = nonNeg(row.cache_read_input_tokens)
  const cacheWrite = nonNeg(row.cache_creation_input_tokens)
  const rawInput = nonNeg(row.input_tokens)
  return {
    // Containment is measured, not assumed; the floor only protects unseen shapes.
    inputTokens: Math.max(0, rawInput - cacheRead - cacheWrite),
    outputTokens: nonNeg(row.output_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: nonNeg(row.reasoning_tokens),
    present: true,
    rollup: {
      provider_total_tokens: num(row.provider_total_tokens),
      computed_total_tokens: num(row.computed_total_tokens),
    },
  }
}

/**
 * §18 row 1: ZCode's `cost` columns exist (`model_usage` has none; `message.data.cost`
 * and `part.data.cost` both do) and are uniformly **0** across all 1,414 assistant
 * messages and 1,355 step-finish parts, because the measured provider is a BigModel
 * coding PLAN (`builtin:bigmodel-start-plan` / `account:bigmodel-start-plan`). Under a
 * plan, `0` means "not billed per token", not "free" — so publishing it as
 * `costReported` would claim $0 for 167M tokens, which is exactly the fake zero §18
 * row 1 forbids. The price layer computes the equivalent API cost instead.
 */
export const COST_REASON =
  'cost columns exist but are uniformly 0 under a BigModel coding plan; reporting them would claim $0 for real tokens (§18 row 1, zcode.md §四)'

/**
 * The two cost-bearing fields (`message.data.cost`, `part.data.cost`) as reconciliation
 * only. `cost` is never returned as a number: see `COST_REASON`, and note that
 * `model_usage` has no cost column at all, so the single usage-carrying event type could
 * not state one even if it were adopted.
 */
export function costCopy(data: UnknownRecord | null): { reported: null; column_present: boolean; value: number | null } {
  const raw = num(asRecord(data)?.cost)
  return { reported: null, column_present: raw !== null, value: raw }
}

// --------------------------------------------------------- content-layer caps

/**
 * §3.2/§6: these tools carry whole file or page bodies. Measured on the real store
 * (max `part.data` is 185,959 B; `state.output` peaks at 37,659 chars on `Read`,
 * `state.input` at 22,877 on `Write`), with ZCode's Claude Code dialect names.
 */
export const FILE_BODY_INPUT_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'patch',
])
export const FILE_BODY_OUTPUT_TOOLS = new Set(['read', 'webfetch'])

/** Tool names are matched case-insensitively: ZCode uses `Read`/`Write`, OpenCode `read`. */
export function bodyExcluded(set: ReadonlySet<string>, toolName: string | null): boolean {
  return toolName !== null && set.has(toolName.toLowerCase())
}

/** `message.data.semantics` — the §五 dispatch table every message row carries. */
export function sem(data: UnknownRecord | null | undefined): UnknownRecord | null {
  return asRecord(data?.semantics)
}

/** Kinds recognised inside `part.data.type`; anything else is drift and lands as `unknown` (§5.3). */
export const KNOWN_PART_TYPES: readonly string[] = [
  'step-start',
  'step-finish',
  'tool',
  'text',
  'reasoning',
  'timeline',
  'file',
]

/**
 * `message.data.semantics.kind` dispatch (§五). The `INJECTED` set is why mapping by
 * `role` is forbidden: 189 rows carry `role='user'` but only 89 are `user_prompt` +
 * `origin='real_user'`, so a role mapping would inflate user turns 2.12×.
 */
export const SEMANTICS_USER_PROMPT = 'user_prompt'
export const SEMANTICS_ASSISTANT_RESPONSE = 'assistant_response'
export const INJECTED_SEMANTICS_KINDS: readonly string[] = [
  'todo_reminder',
  'system_reminder',
  'background_notification',
  'timeline_event',
]

/** `query_source` values that are the model's own background calls, not user turns (§五). */
export const BACKGROUND_QUERY_SOURCES: readonly string[] = [
  'session_title',
  'goal_summary_title',
  'target_completion_verification',
]

// ------------------------------------------------------------ capability grain

/**
 * ZCode's tool names are Claude Code dialect plus TWO MCP shapes measured side by side:
 * `mcp__computer-use__screenshot` and the three-segment
 * `mcp__plugin_mimosa_mimosa__security_scan_start`. Splitting on the first `__` after the
 * prefix keeps the whole middle segment as the server name, so the plugin-qualified form
 * is not silently truncated at an underscore.
 */
export function mcpOf(toolName: string | null): { server: string; tool: string } | null {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** Tools that spawn a subagent; `state.input.subagent_type` names the kind (measured: `Explore`, `general-purpose`). */
export const SUBAGENT_TOOLS = new Set(['agent', 'task'])
export const SKILL_TOOL = 'Skill'

// -------------------------------------------------------------- redaction

/**
 * §5.3 wants the raw row for drift accounting, §3.2/§6 forbid whole bodies in the metric
 * layer — `part.data.state.output`, `part.data.text` and the prompt bodies inside
 * `state.input` carry exactly that, so they are counted, not copied.
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
  'url',
  'contextSnapshot',
  'raw_usage_json',
  'provider_metadata_json',
  'error_message',
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

/** Tool input/output payloads are JSON blobs; capped at 4 KiB like OpenCode's. */
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

export function tableOf(sqliteTable: string | null | undefined): ZcodeTable | string {
  return sqliteTable ?? 'unknown'
}

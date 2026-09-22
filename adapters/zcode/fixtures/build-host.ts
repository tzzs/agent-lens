/**
 * Fixture builder — SQLite cannot be checked in as a text fixture, so the throwaway host
 * database is CREATED here (a build script tests run, never shipped data) inside
 * `node:os.tmpdir()`.
 *
 * The DDL is copied column-for-column from the measured schema of
 * `~/.zcode/cli/db/db.sqlite` (docs/research/zcode.md §一/§五, re-verified against a
 * rollback-mode snapshot), including the CHECK constraints, because those constraints ARE
 * the vocabulary the mapper whitelists: `status IN ('running','completed','error',
 * 'cancelled')`, `title_source IN ('default','first_input','generated','custom')`,
 * `read_only IN (0,1)`.
 *
 * `turn_usage` and `session_target` are built too even though they are NOT sources — the
 * suite needs them present so "ignored" is an observation rather than an absence, and their
 * numbers are seeded to be the EXACT sums of the `model_usage` rows so a test can show that
 * reading both would double every total (§三).
 *
 * Every string, path, id and token figure below is invented. The row shapes are real; no
 * prompt text, title, command, error message or path from this machine's 30MB store was
 * copied here.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

/** Fixed base timestamp so derived ids and snapshots are machine independent (ms epoch). */
export const T0 = 1_760_000_000_000

/** `n` comma-joined `?` markers, so a column list and its bind list cannot drift apart. */
function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

const DDL: readonly string[] = [
  `CREATE TABLE session (
     id text primary key,
     project_id text not null,
     workspace_id text,
     parent_id text,
     slug text not null,
     directory text not null,
     path text,
     title text not null,
     version text not null,
     share_url text,
     summary_additions integer,
     summary_deletions integer,
     summary_files integer,
     summary_diffs text,
     revert text,
     permission text,
     time_created integer not null,
     time_updated integer not null,
     time_compacting integer,
     time_archived integer,
     task_type text not null default 'interactive',
     title_source text not null default 'first_input'
       check(title_source in ('default', 'first_input', 'generated', 'custom')),
     title_message_id text,
     time_title_updated integer,
     trace_id text)`,
  `CREATE TABLE message (
     id text primary key,
     session_id text not null references session(id) on delete cascade,
     time_created integer not null,
     time_updated integer not null,
     data text not null,
     sequence integer)`,
  `CREATE TABLE part (
     id text primary key,
     message_id text not null references message(id) on delete cascade,
     session_id text not null,
     time_created integer not null,
     time_updated integer not null,
     data text not null,
     sequence integer)`,
  `CREATE TABLE model_usage (
     id text primary key,
     logical_request_id text not null,
     attempt_index integer not null default 0,
     session_id text not null references session(id) on delete cascade,
     turn_id text,
     trace_id text,
     span_id text,
     assistant_message_id text,
     parent_user_message_id text,
     query_source text not null,
     provider_id text not null,
     model_id text not null,
     variant text,
     agent text,
     mode text,
     task_type text,
     status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
     started_at integer not null,
     first_token_at integer,
     completed_at integer,
     duration_ms integer,
     time_to_first_token_ms integer,
     finish_reason text,
     tool_call_count integer not null default 0,
     input_tokens integer not null default 0,
     output_tokens integer not null default 0,
     reasoning_tokens integer not null default 0,
     cache_creation_input_tokens integer not null default 0,
     cache_read_input_tokens integer not null default 0,
     provider_total_tokens integer,
     computed_total_tokens integer not null default 0,
     retry_count integer not null default 0,
     retryable integer not null default 0 check(retryable in (0, 1)),
     cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
     context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
     error_type text,
     error_code text,
     error_message text,
     raw_usage_json text,
     provider_metadata_json text)`,
  `CREATE TABLE tool_usage (
     id text primary key,
     session_id text not null references session(id) on delete cascade,
     turn_id text,
     trace_id text,
     tool_call_id text not null,
     tool_name text not null,
     side_effect_scope text,
     read_only integer check(read_only in (0, 1)),
     destructive integer check(destructive in (0, 1)),
     approval_status text,
     status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
     started_at integer not null,
     first_output_at integer,
     completed_at integer,
     duration_ms integer,
     time_to_first_output_ms integer,
     exit_code integer,
     output_bytes integer not null default 0,
     stdout_bytes integer not null default 0,
     stderr_bytes integer not null default 0,
     truncated integer not null default 0 check(truncated in (0, 1)),
     retry_count integer not null default 0,
     retryable integer not null default 0 check(retryable in (0, 1)),
     cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
     error_type text,
     error_code text,
     error_message text)`,
  // NOT a source (§三 copy #4): seeded as the exact sum of its turn's `model_usage` rows.
  `CREATE TABLE turn_usage (
     session_id text not null references session(id) on delete cascade,
     turn_id text not null,
     trace_id text,
     user_message_id text,
     status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
     started_at integer not null,
     first_model_start_at integer,
     first_token_at integer,
     completed_at integer,
     duration_ms integer,
     time_to_first_token_ms integer,
     model_request_count integer not null default 0,
     model_retry_count integer not null default 0,
     tool_call_count integer not null default 0,
     tool_error_count integer not null default 0,
     input_tokens integer not null default 0,
     output_tokens integer not null default 0,
     reasoning_tokens integer not null default 0,
     cache_creation_input_tokens integer not null default 0,
     cache_read_input_tokens integer not null default 0,
     computed_total_tokens integer not null default 0,
     retryable integer not null default 0 check(retryable in (0, 1)),
     cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
     context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
     error_type text,
     error_code text,
     primary key(session_id, turn_id))`,
  // NOT a source (§三 copy #5): session-grain `tokens_used`.
  `CREATE TABLE session_target (
     session_id text primary key references session(id) on delete cascade,
     target_id text not null,
     objective text not null,
     status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
     token_budget integer,
     tokens_used integer not null default 0,
     time_used_seconds integer not null default 0,
     time_created integer not null,
     time_updated integer not null,
     summary_title text,
     active_input_id text,
     active_run_started_at integer,
     active_run_last_seen_at integer)`,
]

// ------------------------------------------------------------------ seed types

export interface SessionSeed {
  id: string
  projectId?: string
  parentId?: string | null
  directory?: string
  path?: string | null
  version?: string
  title?: string
  titleSource?: 'default' | 'first_input' | 'generated' | 'custom'
  taskType?: string
  permission?: string | null
  timeArchived?: number | null
  timeCompacting?: number | null
  summaryAdditions?: number | null
  summaryDeletions?: number | null
  summaryFiles?: number | null
}

export interface MessageSeed {
  id: string
  sessionId: string
  data: Record<string, unknown>
  created?: number
  updated?: number
  /** Written verbatim; used for the undecodable-JSON drift row. */
  rawData?: string
}

export interface PartSeed {
  id: string
  messageId: string
  sessionId: string
  data: Record<string, unknown>
  created?: number
  updated?: number
  rawData?: string
}

export interface ModelUsageSeed {
  id: string
  logicalRequestId: string
  sessionId: string
  turnId?: string | null
  traceId?: string | null
  assistantMessageId?: string | null
  parentUserMessageId?: string | null
  querySource: string
  providerId?: string
  modelId?: string
  variant?: string | null
  agent?: string | null
  mode?: string | null
  taskType?: string | null
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  firstTokenAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
  timeToFirstTokenMs?: number | null
  finishReason?: string | null
  toolCallCount?: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens: number
  providerTotalTokens?: number | null
  computedTotalTokens: number
  retryCount?: number
  errorType?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  rawUsageJson?: string | null
}

export interface ToolUsageSeed {
  id: string
  sessionId: string
  turnId?: string | null
  traceId?: string | null
  toolCallId: string
  toolName: string
  sideEffectScope?: string | null
  readOnly?: number | null
  destructive?: number | null
  approvalStatus?: string | null
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  firstOutputAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
  timeToFirstOutputMs?: number | null
  exitCode?: number | null
  outputBytes?: number
  stdoutBytes?: number
  stderrBytes?: number
  truncated?: number
  errorType?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

export interface TurnUsageSeed {
  sessionId: string
  turnId: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: number
  completedAt?: number | null
  durationMs?: number | null
  modelRequestCount?: number
  toolCallCount?: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens: number
  computedTotalTokens: number
  userMessageId?: string | null
}

export interface HostSeed {
  sessions?: SessionSeed[]
  messages?: MessageSeed[]
  parts?: PartSeed[]
  modelUsage?: ModelUsageSeed[]
  toolUsage?: ToolUsageSeed[]
  turnUsage?: TurnUsageSeed[]
  /** Build the store at `<tmp>/<subdir>/db.sqlite`; the real layout is `cli/db`. */
  subdir?: string
  /** WAL + no `-wal`/`-shm` siblings: the case §18 row 7 says must be refused. */
  wal?: boolean
  /** Keep a write connection open so the WAL sidecars really exist on disk. */
  retainWriter?: boolean
}

export interface BuiltHost {
  dir: string
  /** Directory holding `db.sqlite` (equals `dir` unless `subdir` was used). */
  root: string
  dbPath: string
  /** Close our connections but KEEP the files, for after-the-fact sidecar checks. */
  closeConnections(): void
  close(): Promise<void>
}

// ------------------------------------------------------------------ fixed names

export const ROOT_SESSION = 'sess_fixture_root_0000000001'
export const CHILD_SESSION = 'sess_fixture_child_0000000002'
export const ARCHIVED_SESSION = 'sess_fixture_archived_0003'
export const COMPACTING_SESSION = 'sess_fixture_compacting_006'
export const CYCLE_A_SESSION = 'sess_fixture_cycle_a_0004'
export const CYCLE_B_SESSION = 'sess_fixture_cycle_b_0005'

export const PROMPT_MESSAGE = 'msg_fixture_prompt_0001'
export const ASSISTANT_MESSAGE = 'msg_fixture_assistant_0001'
export const CHILD_ASSISTANT_MESSAGE = 'msg_fixture_child_asst_001'
export const ERROR_MESSAGE = 'msg_fixture_error_00000001'
export const REMINDER_MESSAGE = 'msg_fixture_todo_reminder_001'
export const BACKGROUND_MESSAGE = 'msg_fixture_background_0001'
export const SYSTEM_REMINDER_MESSAGE = 'msg_fixture_sys_reminder_01'
export const TIMELINE_MESSAGE = 'msg_fixture_timeline_00001'
export const NEW_KIND_MESSAGE = 'msg_fixture_new_kind_00001'
export const NO_SEMANTICS_MESSAGE = 'msg_fixture_no_semantics_001'

export const TURN_ROOT = 'turn_fixture_root_0001'
export const TURN_CHILD = 'turn_fixture_child_001'

const PROVIDER = 'builtin:bigmodel-plan-demo'
const MODEL = 'Demo-Model-Pro'

// ------------------------------------------------------------------ the rows

export const FIXTURE_SESSIONS: SessionSeed[] = [
  {
    id: ROOT_SESSION,
    projectId: 'proj_work-zroot',
    parentId: null,
    directory: '/work/zroot',
    path: '/work/zroot',
    version: '0.16.5',
    title: 'synthetic root session title',
    titleSource: 'generated',
    taskType: 'interactive',
    permission: '{"mode":"yolo"}',
    // Measured: `session` has no cost/tokens columns and `time_archived` is NULL on 38/38
    // rows, so no `session.end` may come from this row.
    summaryAdditions: 12,
    summaryDeletions: 3,
    summaryFiles: 2,
  },
  {
    id: CHILD_SESSION,
    projectId: 'proj_work-zroot',
    parentId: ROOT_SESSION,
    directory: '/work/zroot',
    version: '0.16.5',
    title: 'synthetic subagent session title',
    titleSource: 'first_input',
    // §五: `task_type='subagent_child'` ⟺ `parent_id IS NOT NULL` ⟺
    // `query_source='subagent'`, all three seeded consistently here.
    taskType: 'subagent_child',
    permission: '{"mode":"yolo"}',
  },
  {
    id: ARCHIVED_SESSION,
    projectId: 'proj_work-zbeta',
    parentId: null,
    directory: '/work/zbeta',
    version: 'local',
    title: 'synthetic archived session title',
    titleSource: 'custom',
    taskType: 'interactive',
    permission: null,
    timeArchived: T0 + 9_000,
  },
  // A two-row parent cycle the store could in principle contain (`parent_id` is not a
  // foreign key in ZCode's schema). Without the walk's cycle guard `parse` spins forever.
  { id: CYCLE_A_SESSION, parentId: CYCLE_B_SESSION, directory: '/work/zroot', version: '0.16.5', title: 'cycle a', taskType: 'interactive' },
  { id: CYCLE_B_SESSION, parentId: CYCLE_A_SESSION, directory: '/work/zroot', version: '0.16.5', title: 'cycle b', taskType: 'interactive' },
  // ZCode expresses compaction the way OpenCode does: a session timestamp, not a transcript
  // record (`time_compacting` is NULL on 38/38 local rows, so this branch has no live evidence
  // and only a seeded one). §17 item 5 asks per agent whether a compact event exists at all.
  {
    id: COMPACTING_SESSION,
    projectId: 'proj_work-zroot',
    parentId: null,
    directory: '/work/zroot',
    version: '0.16.5',
    title: 'synthetic compacted session title',
    titleSource: 'first_input',
    taskType: 'interactive',
    permission: '{"mode":"plan"}',
    timeCompacting: T0 + 12_000,
  },
]

/** `message.data.semantics` is what the mapper dispatches on; `role` is deliberately misleading. */
function semanticsOf(kind: string, origin: string): Record<string, unknown> {
  return { origin, kind, uiVisibility: kind === 'todo_reminder' ? 'hidden' : 'visible', providerVisibility: 'visible' }
}

export const FIXTURE_MESSAGES: MessageSeed[] = [
  {
    id: PROMPT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 100,
    data: {
      role: 'user',
      time: { created: T0 + 100 },
      agent: 'zcode-agent',
      mode: 'yolo',
      model: { providerID: PROVIDER, modelID: MODEL, variant: 'max' },
      semantics: semanticsOf('user_prompt', 'real_user'),
      contextSnapshot: { envInfo: { cwd: '/work/zroot', platform: 'darwin' } },
    },
  },
  {
    id: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 200,
    updated: T0 + 900,
    data: {
      role: 'assistant',
      time: { created: T0 + 200, completed: T0 + 900 },
      parentID: PROMPT_MESSAGE,
      modelID: MODEL,
      providerID: PROVIDER,
      variant: 'max',
      mode: 'yolo',
      agent: 'zcode-agent',
      path: { cwd: '/work/zroot', root: '/work/zroot' },
      // §三 copy #3 and §四's plan-zero cost, with `input` CONTAINING `cache.read`
      // (30527 = 4031 uncached + 26496 cached; total = input + output).
      cost: 0,
      tokens: { total: 32_601, input: 30_527, output: 2_074, reasoning: 0, cache: { read: 26_496, write: 0 } },
      finish: 'tool-calls',
      semantics: semanticsOf('assistant_response', 'agent_runtime'),
    },
  },
  {
    id: CHILD_ASSISTANT_MESSAGE,
    sessionId: CHILD_SESSION,
    created: T0 + 1_200,
    data: {
      role: 'assistant',
      time: { created: T0 + 1_200, completed: T0 + 1_400 },
      modelID: MODEL,
      providerID: PROVIDER,
      agent: 'zcode-general-purpose',
      cost: 0,
      tokens: { total: 5_200, input: 5_000, output: 200, reasoning: 0, cache: { read: 4_000, write: 0 } },
      finish: 'stop',
      semantics: semanticsOf('assistant_response', 'agent_runtime'),
    },
  },
  {
    // The measured error shape: `error` rides ON an assistant_response row.
    id: ERROR_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 2_000,
    data: {
      role: 'assistant',
      time: { created: T0 + 2_000, completed: T0 + 2_100 },
      parentID: PROMPT_MESSAGE,
      modelID: MODEL,
      providerID: PROVIDER,
      agent: 'zcode-agent',
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: {
        name: 'AiSdkModelAdapterError',
        data: {
          message: 'synthetic concurrency limit exceeded',
          code: 'model_rate_limited',
          attribution: {
            source: 'provider',
            reason: 'rate_limited',
            errorPhase: 'stream',
            providerId: PROVIDER,
            modelId: MODEL,
            statusCode: 429,
            providerErrorCode: '3008',
            retryable: false,
          },
        },
      },
      semantics: semanticsOf('assistant_response', 'agent_runtime'),
    },
  },
  // The four injected kinds, all with the role that would make them look like user turns:
  // 94 + 5 + 1 measured `role='user'` rows of these kinds are why §五 forbids role mapping.
  {
    id: REMINDER_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_000,
    data: {
      role: 'user',
      time: { created: T0 + 3_000 },
      agent: 'zcode-agent',
      model: { providerID: PROVIDER, modelID: MODEL },
      metadata: { source: 'todo_reminder', visibility: 'model-only' },
      semantics: semanticsOf('todo_reminder', 'agent_runtime'),
    },
  },
  {
    id: BACKGROUND_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_100,
    data: {
      role: 'user',
      time: { created: T0 + 3_100 },
      agent: 'zcode-agent',
      semantics: semanticsOf('background_notification', 'agent_runtime'),
    },
  },
  {
    id: SYSTEM_REMINDER_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_200,
    data: {
      role: 'user',
      time: { created: T0 + 3_200 },
      agent: 'zcode-agent',
      semantics: semanticsOf('system_reminder', 'agent_runtime'),
    },
  },
  {
    id: TIMELINE_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_300,
    data: {
      role: 'assistant',
      time: { created: T0 + 3_300 },
      agent: 'zcode-Explore',
      cost: 0,
      semantics: semanticsOf('timeline_event', 'system'),
    },
  },
  // Two drift shapes the store does not produce today but §5.3 must survive.
  {
    id: NEW_KIND_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_400,
    data: { role: 'user', time: { created: T0 + 3_400 }, semantics: semanticsOf('quantum_notification', 'agent_runtime') },
  },
  {
    id: NO_SEMANTICS_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_500,
    data: { role: 'user', time: { created: T0 + 3_500 }, somethingNew: true },
  },
]

/** A file body large enough to prove the content-layer exclusions and the 32 KiB cap. */
const BIG_OUTPUT = 'x'.repeat(4_096)
const BIG_INPUT = 'y'.repeat(4_200)
const HUGE_REASONING = 'z'.repeat(40_000)

function toolPart(id: string, tool: string, callId: string, status: string, input: unknown, output: unknown, start: number, end: number): PartSeed {
  return {
    id,
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: start,
    updated: end,
    data: { type: 'tool', tool, callID: callId, state: { status, input, output, title: 'synthetic title', metadata: { schemaVersion: 1 }, time: { start, end } } },
  }
}

export const FIXTURE_PARTS: PartSeed[] = [
  {
    id: 'part_fixture_step_start_0001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 200,
    // Measured: ZCode's `step-start` carries only `{type}`, no `snapshot` like OpenCode's.
    data: { type: 'step-start' },
  },
  {
    id: 'part_fixture_step_finish_0001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 900,
    // §三 copy #2: byte-identical to the `model_usage` row's `computed_total`/`input`.
    data: {
      type: 'step-finish',
      reason: 'tool-calls',
      cost: 0,
      tokens: { total: 32_601, input: 30_527, output: 2_074, reasoning: 0, cache: { read: 26_496, write: 0 } },
    },
  },
  {
    id: 'part_fixture_step_finish_0002',
    messageId: CHILD_ASSISTANT_MESSAGE,
    sessionId: CHILD_SESSION,
    created: T0 + 1_400,
    data: {
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { total: 5_200, input: 5_000, output: 200, reasoning: 0, cache: { read: 4_000, write: 0 } },
    },
  },
  toolPart('part_fixture_tool_bash_0001', 'Bash', 'call_fixture_bash_1', 'completed', { command: 'echo synthetic', description: 'synthetic description' }, 'synthetic output line\n', T0 + 300, T0 + 440),
  toolPart('part_fixture_tool_read_0001', 'Read', 'call_fixture_read_1', 'completed', { file_path: '/work/zroot/notes.md' }, BIG_OUTPUT, T0 + 450, T0 + 470),
  toolPart('part_fixture_tool_write_0001', 'Write', 'call_fixture_write_1', 'completed', { file_path: '/work/zroot/a.ts', content: BIG_INPUT }, 'ok', T0 + 480, T0 + 500),
  toolPart('part_fixture_tool_agent_0001', 'Agent', 'call_fixture_agent_1', 'completed', { description: 'synthetic delegation', prompt: 'synthetic delegation prompt', subagent_type: 'general-purpose' }, 'done', T0 + 510, T0 + 900),
  toolPart('part_fixture_tool_skill_0001', 'Skill', 'call_fixture_skill_1', 'completed', { skill: 'synthetic-skill', args: 'synthetic args' }, '<skill_content name="synthetic-skill"/>', T0 + 520, T0 + 530),
  toolPart('part_fixture_tool_mcp2_0001', 'mcp__computer-use__screenshot', 'call_fixture_mcp2_1', 'completed', { display_id: 1 }, 'ok', T0 + 540, T0 + 590),
  toolPart('part_fixture_tool_mcp3_0001', 'mcp__plugin_mimosa_mimosa__security_scan_start', 'call_fixture_mcp3_1', 'completed', { scope: 'synthetic' }, 'started', T0 + 600, T0 + 610),
  toolPart('part_fixture_tool_err_0001', 'Bash', 'call_fixture_basherr_1', 'error', { command: 'false' }, undefined, T0 + 700, T0 + 720),
  // The part whose state is still pending when the snapshot is taken: the outcome must come
  // from `tool_usage`, and this row must still produce a `tool.start`.
  {
    id: 'part_fixture_tool_pending_001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 750,
    data: { type: 'tool', tool: 'WebFetch', callID: 'call_fixture_fetch_1', state: { status: 'pending', input: { url: 'https://example.invalid' }, time: { start: T0 + 750 } } },
  },
  {
    id: 'part_fixture_text_user_0001',
    messageId: PROMPT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 100,
    data: { type: 'text', text: 'synthetic user prompt body', time: { start: T0 + 100, end: T0 + 100 } },
  },
  {
    id: 'part_fixture_text_reminder_001',
    messageId: REMINDER_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_000,
    // `role='user'` on the owning row and a `text` part on it: exactly the 100-row shape
    // that must NOT become a user turn (§五).
    data: { type: 'text', text: 'synthetic injected reminder body' },
  },
  {
    id: 'part_fixture_text_assistant_001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 210,
    data: { type: 'text', text: 'synthetic assistant reply body' },
  },
  {
    id: 'part_fixture_reasoning_0001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 215,
    data: { type: 'reasoning', text: 'synthetic reasoning trace', metadata: { anthropic: { signature: 'deadbeef' } }, time: { start: T0 + 215, end: T0 + 400 } },
  },
  {
    id: 'part_fixture_reasoning_huge_001',
    messageId: CHILD_ASSISTANT_MESSAGE,
    sessionId: CHILD_SESSION,
    created: T0 + 1_250,
    // Measured max `part.data` is 185,959 B, most of it reasoning.
    data: { type: 'reasoning', text: HUGE_REASONING },
  },
  {
    id: 'part_fixture_timeline_0001',
    messageId: TIMELINE_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 3_300,
    data: { type: 'timeline', timelineType: 'model_change', display: 'separator', status: 'completed', toModel: { providerID: PROVIDER, modelID: MODEL } },
  },
  {
    id: 'part_fixture_file_0001',
    messageId: PROMPT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 105,
    data: { type: 'file', mime: 'image/png', url: 'zcode-artifact://sess_fixture_root_0000000001/tool-result-0001', metadata: { image: { width: 10, height: 10 } } },
  },
  {
    id: 'part_fixture_quantum_000001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 950,
    data: { type: 'quantum-state', brandNewField: { nested: 1 }, text: 'synthetic body that must not be copied raw' },
  },
  {
    id: 'part_fixture_broken_json_001',
    messageId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    created: T0 + 960,
    data: {},
    rawData: '{"type":"text", not-json',
  },
]

/**
 * Token figures chosen so §四's identities hold on every row
 * (`computed_total == input + output`, `cache_read + cache_creation <= input`) while
 * `cache_read > 0` on the rows that matter, and one row seeds
 * `cache_creation_input_tokens > 0` even though this machine never uses that column.
 */
export const FIXTURE_MODEL_USAGE: ModelUsageSeed[] = [
  {
    id: 'usage_model_main_turn_msg_fixture_assistant_0001_0',
    logicalRequestId: ASSISTANT_MESSAGE,
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-shared-0001',
    assistantMessageId: ASSISTANT_MESSAGE,
    parentUserMessageId: PROMPT_MESSAGE,
    querySource: 'main_turn',
    providerId: PROVIDER,
    modelId: MODEL,
    variant: 'max',
    agent: 'zcode-agent',
    mode: 'yolo',
    taskType: 'interactive',
    status: 'completed',
    startedAt: T0 + 200,
    firstTokenAt: T0 + 500,
    completedAt: T0 + 900,
    durationMs: 8_700,
    timeToFirstTokenMs: 300,
    finishReason: 'tool-calls',
    toolCallCount: 6,
    inputTokens: 30_527,
    outputTokens: 2_074,
    reasoningTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 26_496,
    providerTotalTokens: 32_601,
    computedTotalTokens: 32_601,
    rawUsageJson: '{"inputTokens":30527,"outputTokens":2074,"totalTokens":32601,"cacheReadTokens":26496,"cacheWriteTokens":0}',
  },
  {
    id: 'usage_model_subagent_msg_fixture_child_asst_001_0',
    logicalRequestId: CHILD_ASSISTANT_MESSAGE,
    sessionId: CHILD_SESSION,
    turnId: TURN_CHILD,
    traceId: 'trace-fixture-shared-0001',
    assistantMessageId: CHILD_ASSISTANT_MESSAGE,
    querySource: 'subagent',
    providerId: PROVIDER,
    modelId: MODEL,
    variant: 'max',
    agent: 'zcode-general-purpose',
    mode: 'yolo',
    taskType: 'subagent_child',
    status: 'completed',
    startedAt: T0 + 1_200,
    completedAt: T0 + 1_400,
    durationMs: 200,
    finishReason: 'stop',
    toolCallCount: 1,
    inputTokens: 5_000,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 4_000,
    providerTotalTokens: 5_200,
    computedTotalTokens: 5_200,
  },
  {
    // §五: error rows carry ZERO tokens and a `trace_id` shared with healthy rows.
    id: 'usage_model_main_turn_msg_fixture_error_00000001_0',
    logicalRequestId: ERROR_MESSAGE,
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-shared-0001',
    assistantMessageId: ERROR_MESSAGE,
    parentUserMessageId: PROMPT_MESSAGE,
    querySource: 'main_turn',
    providerId: PROVIDER,
    modelId: MODEL,
    variant: 'max',
    agent: 'zcode-agent',
    mode: 'yolo',
    taskType: 'interactive',
    status: 'error',
    startedAt: T0 + 2_000,
    completedAt: T0 + 2_100,
    durationMs: 1_000,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    providerTotalTokens: null,
    computedTotalTokens: 0,
    errorType: 'rate_limited',
    errorCode: '3008',
    errorMessage: 'synthetic concurrency limit exceeded',
  },
  {
    // §五: a background call the user never asked for, real spend nonetheless.
    id: 'usage_model_session_title_005f0580_0001_0',
    logicalRequestId: '005f0580-fixture-01',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-shared-0001',
    parentUserMessageId: PROMPT_MESSAGE,
    querySource: 'session_title',
    providerId: PROVIDER,
    modelId: MODEL,
    variant: 'disabled',
    agent: 'zcode-agent',
    mode: 'yolo',
    taskType: 'interactive',
    status: 'completed',
    startedAt: T0 + 4_000,
    completedAt: T0 + 4_200,
    durationMs: 200,
    finishReason: 'stop',
    inputTokens: 290,
    outputTokens: 84,
    cacheReadInputTokens: 192,
    providerTotalTokens: 374,
    computedTotalTokens: 374,
    rawUsageJson: '{"inputTokens":290,"outputTokens":84,"totalTokens":374,"cacheReadTokens":192,"cacheWriteTokens":0}',
  },
  {
    // The unseen-but-legal shape: `cache_creation_input_tokens > 0` must be subtracted too.
    id: 'usage_model_main_turn_msg_fixture_cache_wr_0',
    logicalRequestId: 'msg_fixture_cache_write_00001',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-other-0002',
    querySource: 'main_turn',
    providerId: PROVIDER,
    modelId: MODEL,
    variant: 'low',
    agent: 'zcode-agent',
    mode: 'plan',
    taskType: 'interactive',
    status: 'completed',
    startedAt: T0 + 5_000,
    completedAt: T0 + 5_100,
    durationMs: 100,
    finishReason: 'stop',
    inputTokens: 1_000,
    outputTokens: 50,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 200,
    providerTotalTokens: 1_050,
    computedTotalTokens: 1_050,
  },
  {
    id: 'usage_model_main_turn_msg_fixture_cancel_0_0',
    logicalRequestId: 'msg_fixture_cancelled_0001',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-shared-0001',
    querySource: 'main_turn',
    providerId: PROVIDER,
    modelId: MODEL,
    agent: 'zcode-agent',
    mode: 'yolo',
    taskType: 'interactive',
    status: 'cancelled',
    startedAt: T0 + 6_000,
    durationMs: 50,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    computedTotalTokens: 0,
    errorType: 'cancelled',
  },
]

export const FIXTURE_TOOL_USAGE: ToolUsageSeed[] = [
  {
    id: 'usage_tool_fixture_root_bash_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    traceId: 'trace-fixture-shared-0001',
    toolCallId: 'call_fixture_bash_1',
    toolName: 'Bash',
    sideEffectScope: 'system',
    readOnly: 0,
    destructive: 0,
    approvalStatus: 'none',
    status: 'completed',
    startedAt: T0 + 300,
    firstOutputAt: T0 + 400,
    completedAt: T0 + 440,
    durationMs: 140,
    timeToFirstOutputMs: 100,
    exitCode: 0,
    outputBytes: 21,
    stdoutBytes: 21,
  },
  {
    id: 'usage_tool_fixture_root_read_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_read_1',
    toolName: 'Read',
    sideEffectScope: 'none',
    readOnly: 1,
    destructive: 0,
    approvalStatus: 'none',
    status: 'completed',
    startedAt: T0 + 450,
    completedAt: T0 + 470,
    durationMs: 20,
    exitCode: 0,
    outputBytes: 4_096,
    truncated: 1,
  },
  {
    id: 'usage_tool_fixture_root_write_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_write_1',
    toolName: 'Write',
    sideEffectScope: 'workspace',
    readOnly: 0,
    destructive: 1,
    approvalStatus: 'none',
    status: 'completed',
    startedAt: T0 + 480,
    completedAt: T0 + 500,
    durationMs: 20,
    exitCode: 0,
    outputBytes: 2,
  },
  {
    id: 'usage_tool_fixture_root_agent_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_agent_1',
    toolName: 'Agent',
    sideEffectScope: 'session',
    readOnly: 0,
    destructive: 0,
    status: 'completed',
    startedAt: T0 + 510,
    completedAt: T0 + 900,
    durationMs: 390,
    exitCode: 0,
    outputBytes: 4,
  },
  {
    id: 'usage_tool_fixture_root_mcp2_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_mcp2_1',
    toolName: 'mcp__computer-use__screenshot',
    sideEffectScope: 'network',
    readOnly: 1,
    destructive: 0,
    status: 'completed',
    startedAt: T0 + 540,
    completedAt: T0 + 590,
    durationMs: 50,
    exitCode: 0,
    outputBytes: 493,
  },
  {
    // The three-segment plugin form measured alongside the two-segment one (§五).
    id: 'usage_tool_fixture_root_mcp3_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_mcp3_1',
    toolName: 'mcp__plugin_mimosa_mimosa__security_scan_start',
    sideEffectScope: 'userInteraction',
    readOnly: 0,
    destructive: 0,
    status: 'completed',
    startedAt: T0 + 600,
    completedAt: T0 + 610,
    durationMs: 10,
    exitCode: 0,
    outputBytes: 661,
  },
  {
    id: 'usage_tool_fixture_root_basherr_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_basherr_1',
    toolName: 'Bash',
    sideEffectScope: 'system',
    readOnly: 0,
    destructive: 0,
    status: 'error',
    startedAt: T0 + 700,
    completedAt: T0 + 720,
    durationMs: 20,
    // Measured: `exit_code` is NULL on all 51 error rows, non-NULL on all 1,800 completed.
    exitCode: null,
    outputBytes: 0,
    stderrBytes: 0,
    errorType: 'tool_execution_failed',
    errorCode: 'E_TOOL',
    errorMessage: 'synthetic command failure',
  },
  {
    // No `part` row for this call: the store's own timing, and the reason the two sources
    // are not joined (§5.2 forbids the adapter from querying for the link).
    id: 'usage_tool_fixture_root_pending_1',
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    toolCallId: 'call_fixture_orphan_1',
    toolName: 'TodoWrite',
    sideEffectScope: 'session',
    status: 'running',
    startedAt: T0 + 800,
    outputBytes: 0,
  },
]

/**
 * Each row is the EXACT sum of its turn's `model_usage` rows, which is what §三 measures
 * (`SUM(turn_usage.computed_total_tokens)` = `SUM(model_usage.computed_total_tokens)` up to
 * the error rows' zeros). The fixture therefore proves the double count arithmetically.
 */
export const FIXTURE_TURN_USAGE: TurnUsageSeed[] = [
  {
    sessionId: ROOT_SESSION,
    turnId: TURN_ROOT,
    status: 'completed',
    startedAt: T0 + 100,
    completedAt: T0 + 6_100,
    durationMs: 6_000,
    modelRequestCount: 4,
    toolCallCount: 7,
    inputTokens: 31_817,
    outputTokens: 2_208,
    reasoningTokens: 0,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 26_888,
    computedTotalTokens: 34_025,
    userMessageId: PROMPT_MESSAGE,
  },
  {
    sessionId: CHILD_SESSION,
    turnId: TURN_CHILD,
    status: 'completed',
    startedAt: T0 + 1_200,
    completedAt: T0 + 1_400,
    durationMs: 200,
    modelRequestCount: 1,
    toolCallCount: 1,
    inputTokens: 5_000,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 4_000,
    computedTotalTokens: 5_200,
  },
]

/** §三 copy #5's session-grain rollup. */
export const FIXTURE_SESSION_TARGET: { sessionId: string; tokensUsed: number }[] = [
  { sessionId: ROOT_SESSION, tokensUsed: 34_025 },
  { sessionId: CHILD_SESSION, tokensUsed: 5_200 },
]

// ------------------------------------------------------------------ builder

export async function buildHost(seed: HostSeed = {}): Promise<BuiltHost> {
  const dir = await mkdtemp(join(tmpdir(), 'agentlens-zcode-host-'))
  const root = seed.subdir ? join(dir, seed.subdir) : dir
  if (seed.subdir) await mkdir(root, { recursive: true })
  const dbPath = join(root, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = OFF')
  if (seed.wal) db.exec('PRAGMA journal_mode = WAL')
  for (const stmt of DDL) db.exec(stmt)

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, permission,
       summary_additions, summary_deletions, summary_files, time_created, time_updated, time_compacting,
       time_archived, task_type, title_source, trace_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const s of seed.sessions ?? FIXTURE_SESSIONS) {
    insertSession.run(
      s.id,
      s.projectId ?? 'proj_work-zroot',
      s.parentId ?? null,
      `slug-${s.id}`,
      s.directory ?? '/work/zroot',
      s.directory ?? null,
      s.title ?? 'synthetic',
      s.version ?? '0.16.5',
      s.permission ?? '{"mode":"yolo"}',
      s.summaryAdditions ?? null,
      s.summaryDeletions ?? null,
      s.summaryFiles ?? null,
      T0,
      T0 + 7_000,
      s.timeCompacting ?? null,
      s.timeArchived ?? null,
      s.taskType ?? 'interactive',
      s.titleSource ?? 'first_input',
      'trace-fixture-shared-0001',
    )
  }

  const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
  for (const m of seed.messages ?? FIXTURE_MESSAGES) {
    insertMessage.run(m.id, m.sessionId, m.created ?? T0, m.updated ?? m.created ?? T0, m.rawData ?? JSON.stringify(m.data))
  }

  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
  for (const p of seed.parts ?? FIXTURE_PARTS) {
    insertPart.run(p.id, p.messageId, p.sessionId, p.created ?? T0, p.updated ?? p.created ?? T0, p.rawData ?? JSON.stringify(p.data))
  }

  const insertModelUsage = db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, attempt_index, session_id, turn_id, trace_id, span_id,
       assistant_message_id, parent_user_message_id, query_source, provider_id, model_id, variant, agent, mode,
       task_type, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms,
       finish_reason, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
       cache_read_input_tokens, provider_total_tokens, computed_total_tokens, retry_count, retryable,
       cancelled_by_user, context_exceeded, error_type, error_code, error_message, raw_usage_json)
     VALUES (${marks(39)})`,
  )
  for (const u of seed.modelUsage ?? FIXTURE_MODEL_USAGE) {
    insertModelUsage.run(
      u.id,
      u.logicalRequestId,
      0,
      u.sessionId,
      u.turnId ?? null,
      u.traceId ?? null,
      null,
      u.assistantMessageId ?? null,
      u.parentUserMessageId ?? null,
      u.querySource,
      u.providerId ?? PROVIDER,
      u.modelId ?? MODEL,
      u.variant ?? null,
      u.agent ?? null,
      u.mode ?? null,
      u.taskType ?? null,
      u.status,
      u.startedAt,
      u.firstTokenAt ?? null,
      u.completedAt ?? null,
      u.durationMs ?? null,
      u.timeToFirstTokenMs ?? null,
      u.finishReason ?? null,
      u.toolCallCount ?? 0,
      u.inputTokens,
      u.outputTokens,
      u.reasoningTokens ?? 0,
      u.cacheCreationInputTokens ?? 0,
      u.cacheReadInputTokens,
      u.providerTotalTokens ?? null,
      u.computedTotalTokens,
      0,
      0,
      u.status === 'cancelled' ? 1 : 0,
      0,
      u.errorType ?? null,
      u.errorCode ?? null,
      u.errorMessage ?? null,
      u.rawUsageJson ?? null,
    )
  }

  const insertToolUsage = db.prepare(
    `INSERT INTO tool_usage (id, session_id, turn_id, trace_id, tool_call_id, tool_name, side_effect_scope,
       read_only, destructive, approval_status, status, started_at, first_output_at, completed_at, duration_ms,
       time_to_first_output_ms, exit_code, output_bytes, stdout_bytes, stderr_bytes, truncated, retry_count,
       retryable, cancelled_by_user, error_type, error_code, error_message)
     VALUES (${marks(27)})`,
  )
  for (const t of seed.toolUsage ?? FIXTURE_TOOL_USAGE) {
    insertToolUsage.run(
      t.id,
      t.sessionId,
      t.turnId ?? null,
      t.traceId ?? null,
      t.toolCallId,
      t.toolName,
      t.sideEffectScope ?? null,
      t.readOnly ?? null,
      t.destructive ?? null,
      t.approvalStatus ?? 'none',
      t.status,
      t.startedAt,
      t.firstOutputAt ?? null,
      t.completedAt ?? null,
      t.durationMs ?? null,
      t.timeToFirstOutputMs ?? null,
      t.exitCode ?? null,
      t.outputBytes ?? 0,
      t.stdoutBytes ?? 0,
      t.stderrBytes ?? 0,
      t.truncated ?? 0,
      0,
      0,
      t.status === 'cancelled' ? 1 : 0,
      t.errorType ?? null,
      t.errorCode ?? null,
      t.errorMessage ?? null,
    )
  }

  const insertTurnUsage = db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, duration_ms,
       model_request_count, tool_call_count, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, user_message_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const t of seed.turnUsage ?? FIXTURE_TURN_USAGE) {
    insertTurnUsage.run(
      t.sessionId,
      t.turnId,
      t.status,
      t.startedAt,
      t.completedAt ?? null,
      t.durationMs ?? null,
      t.modelRequestCount ?? 0,
      t.toolCallCount ?? 0,
      t.inputTokens,
      t.outputTokens,
      t.reasoningTokens ?? 0,
      t.cacheCreationInputTokens ?? 0,
      t.cacheReadInputTokens,
      t.computedTotalTokens,
      t.userMessageId ?? null,
    )
  }

  const insertTarget = db.prepare(
    `INSERT INTO session_target (session_id, target_id, objective, status, tokens_used, time_used_seconds, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  for (const target of FIXTURE_SESSION_TARGET) {
    insertTarget.run(target.sessionId, `target-${target.sessionId}`, 'synthetic objective', 'complete', target.tokensUsed, 60, T0, T0 + 7_000)
  }

  // A retained writer keeps `-wal`/`-shm` on disk, which is the state ZCode's own process
  // leaves behind and the only WAL state a fixture can honestly present as "live".
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

/**
 * The static capability surface (§一): `cli/plugins/installed_plugins.json` plus the
 * unpacked `cli/plugins/data/<name>@<marketplace>/` directories. Written next to a built
 * host so `capabilities()` can be pointed at one root. Two of the three manifest names are
 * also data directories and two data dirs have no manifest entry — the real machine shows
 * 3 manifest entries against 8 data directories, so a plugin can be unpacked without an
 * install-manifest entry and neither surface alone is the catalog.
 */
export async function writePluginCatalog(dataRoot: string): Promise<void> {
  const plugins = join(dataRoot, 'cli', 'plugins')
  const manifest = {
    version: 1,
    plugins: [
      { id: 'mimosa@demo-market', name: 'mimosa', marketplace: 'demo-market', version: '1.0.3' },
      { id: 'github@demo-market', name: 'github', marketplace: 'demo-market', version: '0.1.2' },
      { id: 'lark-cli@no-market', name: 'lark-cli', version: '0.4.0' },
    ],
  }
  const dataDirs = [
    'browser-use@demo-market',
    'computer-use@demo-market',
    'github@demo-market',
    'lark-cli@demo-market',
    'mimosa@demo-market',
    'not-a-plugin-dir',
  ]
  for (const dir of dataDirs) await mkdir(join(plugins, 'data', dir), { recursive: true })
  await mkdir(join(plugins, 'marketplaces'), { recursive: true })
  await writeFile(join(plugins, 'installed_plugins.json'), JSON.stringify(manifest), 'utf8')
}

/** Rows appended after the initial build, to exercise the rowid high-water resume. */
export function appendRows(
  dbPath: string,
  options: { parts?: PartSeed[]; modelUsage?: ModelUsageSeed[]; messages?: MessageSeed[] } = {},
): void {
  const db = new DatabaseSync(dbPath)
  try {
    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
    for (const m of options.messages ?? []) {
      insertMessage.run(m.id, m.sessionId, m.created ?? T0, m.updated ?? m.created ?? T0, m.rawData ?? JSON.stringify(m.data))
    }
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
    for (const p of options.parts ?? []) {
      insertPart.run(p.id, p.messageId, p.sessionId, p.created ?? T0, p.updated ?? p.created ?? T0, p.rawData ?? JSON.stringify(p.data))
    }
    const insertModelUsage = db.prepare(
      `INSERT INTO model_usage (id, logical_request_id, attempt_index, session_id, turn_id, query_source,
         provider_id, model_id, status, started_at, completed_at, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const u of options.modelUsage ?? []) {
      insertModelUsage.run(
        u.id,
        u.logicalRequestId,
        0,
        u.sessionId,
        u.turnId ?? null,
        u.querySource,
        u.providerId ?? PROVIDER,
        u.modelId ?? MODEL,
        u.status,
        u.startedAt,
        u.completedAt ?? null,
        u.inputTokens,
        u.outputTokens,
        u.cacheCreationInputTokens ?? 0,
        u.cacheReadInputTokens,
        u.computedTotalTokens,
      )
    }
  } finally {
    db.close()
  }
}

/** A second pass over the fixture's totals, derived from the seeds so no magic number is hand-copied. */
export function modelUsageColumnTotals(rows: readonly ModelUsageSeed[] = FIXTURE_MODEL_USAGE) {
  return rows.reduce(
    (acc, r) => ({
      input: acc.input + r.inputTokens,
      output: acc.output + r.outputTokens,
      cacheRead: acc.cacheRead + r.cacheReadInputTokens,
      cacheCreation: acc.cacheCreation + (r.cacheCreationInputTokens ?? 0),
      providerTotal: acc.providerTotal + (r.providerTotalTokens ?? 0),
      computedTotal: acc.computedTotal + r.computedTotalTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, providerTotal: 0, computedTotal: 0 },
  )
}

export function turnUsageTotal(rows: readonly TurnUsageSeed[] = FIXTURE_TURN_USAGE): number {
  return rows.reduce((n, r) => n + r.computedTotalTokens, 0)
}

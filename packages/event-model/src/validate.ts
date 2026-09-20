/**
 * §3.1 conformance checks for AgentEvent. Pure, returns human-readable
 * problems; used by collector ingest and doctor (§11) to surface schema drift
 * before numbers silently go wrong.
 */
import {
  CAPABILITY_TYPES,
  EVENT_TYPES,
  type AgentEvent,
  type Usage,
} from './types.ts'

const USAGE_FIELDS: readonly (keyof Usage)[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]

const USAGE_SOURCES = ['reported', 'estimated', 'missing'] as const
const STATUSES = ['ok', 'error', 'unknown'] as const
const REQUIRED_IDS = ['agentId', 'hostId', 'sourceId', 'sessionId', 'projectId'] as const

const HEX64 = /^[0-9a-f]{64}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegativeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

export function validateEvent(e: unknown): string[] {
  const problems: string[] = []
  if (!isPlainObject(e)) {
    return ['event must be a non-null object']
  }

  if (typeof e.type !== 'string' || !EVENT_TYPES.includes(e.type as (typeof EVENT_TYPES)[number])) {
    problems.push(`type must be one of EVENT_TYPES, got ${JSON.stringify(e.type)}`)
  }

  if (typeof e.id !== 'string' || e.id === '') {
    problems.push('id must be a non-empty string')
  } else if (!HEX64.test(e.id)) {
    problems.push(`id must be a 64-char lowercase hex fingerprint, got ${JSON.stringify(e.id)}`)
  }

  for (const field of REQUIRED_IDS) {
    const v = e[field]
    if (typeof v !== 'string' || v === '') {
      problems.push(`${field} must be a non-empty string`)
    }
  }

  if (typeof e.timestamp !== 'number' || !Number.isInteger(e.timestamp) || e.timestamp <= 0) {
    problems.push(`timestamp must be a positive integer ms, got ${JSON.stringify(e.timestamp)}`)
  }

  if (!isNonNegativeInteger(e.rawSeq)) {
    problems.push(`rawSeq must be a non-negative integer, got ${JSON.stringify(e.rawSeq)}`)
  }
  if (!isNonNegativeInteger(e.rawOffset)) {
    problems.push(`rawOffset must be a non-negative integer, got ${JSON.stringify(e.rawOffset)}`)
  }

  const usage = e.usage
  if (usage !== undefined && usage !== null) {
    if (!isPlainObject(usage)) {
      problems.push('usage must be an object when present')
    } else {
      for (const field of USAGE_FIELDS) {
        if (!isNonNegativeInteger(usage[field])) {
          problems.push(`usage.${field} must be a finite non-negative integer, got ${JSON.stringify(usage[field])}`)
        }
      }
    }
  }

  if (typeof e.usageSource !== 'string' || !USAGE_SOURCES.includes(e.usageSource as (typeof USAGE_SOURCES)[number])) {
    problems.push(`usageSource must be one of ${USAGE_SOURCES.join('|')}, got ${JSON.stringify(e.usageSource)}`)
  }

  const capability = e.capability
  if (capability !== undefined && capability !== null) {
    if (!isPlainObject(capability) || typeof capability.type !== 'string' || !CAPABILITY_TYPES.includes(capability.type as (typeof CAPABILITY_TYPES)[number])) {
      problems.push(`capability.type must be one of CAPABILITY_TYPES, got ${JSON.stringify(isPlainObject(capability) ? capability.type : capability)}`)
    }
  }

  if (typeof e.status !== 'string' || !STATUSES.includes(e.status as (typeof STATUSES)[number])) {
    problems.push(`status must be one of ${STATUSES.join('|')}, got ${JSON.stringify(e.status)}`)
  }

  if (usage !== undefined && usage !== null && e.usageSource === 'missing') {
    problems.push('event carrying usage must not have usageSource "missing"')
  }

  return problems
}

export function assertEvent(e: unknown): AgentEvent {
  const problems = validateEvent(e)
  if (problems.length > 0) {
    throw new Error(`invalid AgentEvent: ${problems.join('; ')}`)
  }
  return e as AgentEvent
}

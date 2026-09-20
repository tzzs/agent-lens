import { describe, expect, it } from 'vitest'
import { assertEvent, validateEvent } from '../src/validate.ts'
import { makeEvent, usage } from './helpers.ts'

describe('validateEvent', () => {
  it('accepts a well-formed event', () => {
    expect(
      validateEvent(
        makeEvent({
          usage: usage({ inputTokens: 10 }),
          capability: { type: 'hook', name: 'PreToolUse:Bash', provider: 'settings' },
          requestId: 'req-1',
        }),
      ),
    ).toEqual([])
  })

  it('accepts a minimal event without usage or capability', () => {
    expect(validateEvent(makeEvent({ usage: null, capability: null }))).toEqual([])
  })

  it('rejects non-objects and arrays', () => {
    expect(validateEvent(null)).toHaveLength(1)
    expect(validateEvent('x')).toHaveLength(1)
    expect(validateEvent([])).toHaveLength(1)
  })

  it('rejects a type outside EVENT_TYPES', () => {
    const problems = validateEvent(makeEvent({ type: 'generation.finished' as never }))
    expect(problems.some((p) => p.startsWith('type'))).toBe(true)
  })

  it('rejects malformed or empty ids', () => {
    expect(validateEvent(makeEvent({ id: '' })).some((p) => p.includes('id'))).toBe(true)
    expect(validateEvent(makeEvent({ id: 'zz'.repeat(32) })).some((p) => p.includes('64-char'))).toBe(true)
    expect(validateEvent(makeEvent({ id: 'a'.repeat(63) })).some((p) => p.includes('64-char'))).toBe(true)
    for (const field of ['agentId', 'hostId', 'sourceId', 'sessionId', 'projectId'] as const) {
      expect(validateEvent(makeEvent({ [field]: '' })).some((p) => p.startsWith(field))).toBe(true)
    }
  })

  it('rejects bad timestamps and raw positions', () => {
    expect(validateEvent(makeEvent({ timestamp: 0 })).some((p) => p.startsWith('timestamp'))).toBe(true)
    expect(validateEvent(makeEvent({ timestamp: 1.5 })).some((p) => p.startsWith('timestamp'))).toBe(true)
    expect(validateEvent(makeEvent({ rawSeq: -1 })).some((p) => p.startsWith('rawSeq'))).toBe(true)
    expect(validateEvent(makeEvent({ rawOffset: 2.5 })).some((p) => p.startsWith('rawOffset'))).toBe(true)
    expect(validateEvent(makeEvent({ rawSeq: 0, rawOffset: 0 }))).toEqual([])
  })

  it('rejects non-integer or negative token counts', () => {
    expect(
      validateEvent(makeEvent({ usage: usage({ inputTokens: -3 }), usageSource: 'reported' })).some((p) =>
        p.includes('usage.inputTokens'),
      ),
    ).toBe(true)
    expect(
      validateEvent(makeEvent({ usage: usage({ reasoningTokens: Number.NaN }), usageSource: 'reported' })).some(
        (p) => p.includes('usage.reasoningTokens'),
      ),
    ).toBe(true)
  })

  it('rejects unknown usageSource, capability.type and status', () => {
    expect(validateEvent(makeEvent({ usageSource: 'inferred' as never })).some((p) => p.startsWith('usageSource'))).toBe(
      true,
    )
    expect(
      validateEvent(makeEvent({ capability: { type: 'widget' as never, name: 'w' } })).some((p) =>
        p.startsWith('capability.type'),
      ),
    ).toBe(true)
    expect(validateEvent(makeEvent({ status: 'failed' as never })).some((p) => p.startsWith('status'))).toBe(true)
  })

  it('rejects usage combined with usageSource missing', () => {
    expect(validateEvent(makeEvent({ usage: usage({ outputTokens: 5 }), usageSource: 'missing' })).some((p) =>
      p.includes('usageSource "missing"'),
    )).toBe(true)
  })
})

describe('assertEvent', () => {
  it('returns the event when valid', () => {
    const e = makeEvent()
    expect(assertEvent(e)).toBe(e)
  })

  it('throws a joined problem list when invalid', () => {
    expect(() => assertEvent(makeEvent({ status: 'failed' as never, timestamp: -1 }))).toThrowError(
      /invalid AgentEvent: .*timestamp.*; .*status.*/s,
    )
  })
})

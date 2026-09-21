import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { loadAgentAggregations, setAgentAggregations } from '../src/write.ts'

function db() {
  const handle = openDatabase(':memory:')
  migrate(handle)
  return handle
}

describe('agent aggregation policies (§18 row 2)', () => {
  it('round-trips a policy through the agents table', () => {
    const handle = db()
    setAgentAggregations(handle, {
      codex: { mode: 'last_call_sum', subagentsIncluded: false },
      'claude-code': { mode: 'request_max', subagentsIncluded: true },
    })
    expect(loadAgentAggregations(handle)).toEqual({
      codex: { mode: 'last_call_sum', subagentsIncluded: false },
      'claude-code': { mode: 'request_max', subagentsIncluded: true },
    })
  })

  it('replaces a prior declaration, because the rule is the adapter\'s current claim', () => {
    const handle = db()
    setAgentAggregations(handle, { qoder: { mode: 'request_max', subagentsIncluded: true } })
    setAgentAggregations(handle, { qoder: { mode: 'per_record_sum', subagentsIncluded: false } })
    expect(loadAgentAggregations(handle).qoder).toEqual({ mode: 'per_record_sum', subagentsIncluded: false })
  })

  it('leaves an agent absent when it has no declaration, so the caller default applies', () => {
    const handle = db()
    handle.prepare("INSERT INTO agents (id) VALUES ('legacy')").run()
    expect(loadAgentAggregations(handle)).toEqual({})
  })

  it('refuses a stored mode outside the enum instead of guessing', () => {
    const handle = db()
    setAgentAggregations(handle, { weird: { mode: 'request_max', subagentsIncluded: true } })
    handle.prepare("UPDATE agents SET aggregation_mode = 'sum_everything' WHERE id = 'weird'").run()
    expect(() => loadAgentAggregations(handle)).toThrow(/sum_everything/)
  })
})

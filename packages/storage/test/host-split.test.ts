/**
 * §14: the host-split decision is one rule, not two. The terminal used to warn only at ≥80%
 * with a 20-event floor and a `host === agent` exclusion, while the served banner fired at >50%
 * with none of them, so the measured 73.4% split alarmed in the browser and stayed silent in the
 * terminal — and with `host_id` equal to the agent's own name the sentence came out as "90% of
 * claude-code came from claude-code".
 */
import { describe, expect, it } from 'vitest'
import {
  HOST_WARN_MIN_EVENTS,
  hostSplitFor,
  hostSplitNotice,
  hostSplitSentence,
  pickHostSplit,
  pickHostWarning,
  rankHostShares,
} from '../src/host-split.ts'

const shares = (n: number, rest: number) => [
  { host: 'claude-desktop', events: n },
  { host: 'claude-code', events: rest },
]

describe('hostSplitFor (§14: one decision, two statements)', () => {
  it('ranks dominant-first and keeps the share the surfaces quote identical', () => {
    const split = hostSplitFor('claude-code', shares(734, 266))!
    expect(split.dominant.host).toBe('claude-desktop')
    expect(split.dominant.share).toBeCloseTo(0.734, 6)
    expect(rankHostShares(shares(1, 2))[0]!.host).toBe('claude-code')
  })

  it('splits at a majority but only warns on the loud-and-rare condition', () => {
    const mid = hostSplitFor('claude-code', shares(734, 266))!
    expect(mid.splittable).toBe(true)
    expect(mid.warnable).toBe(false)

    const loud = hostSplitFor('claude-code', shares(900, 100))!
    expect(loud.warnable).toBe(true)
    expect(hostSplitSentence(loud, 'events')).toBe('90.0% of claude-code events came from claude-desktop, not claude-code')
  })

  it('stays quiet when there is nothing to compare or too little data', () => {
    expect(hostSplitFor('claude-code', shares(1_000, 0))).toBeNull()
    expect(hostSplitFor('claude-code', [{ host: 'x', events: 5 }])).toBeNull()
    const tiny = hostSplitFor('claude-code', shares(HOST_WARN_MIN_EVENTS - 2, 1))!
    expect(tiny.dominant.share).toBeGreaterThan(0.8)
    expect(tiny.warnable).toBe(false)
  })

  it('refuses to call the agent\'s own host name a distortion', () => {
    const own = hostSplitFor('claude-code', [{ host: 'claude-code', events: 900 }, { host: 'claude-desktop', events: 100 }])!
    expect(own.warnable).toBe(false)
    expect(own.splittable).toBe(true)
    // The useful fact is the minority, so the sentence names it instead of restating the subject.
    expect(hostSplitNotice(own, 'records')).toBe('90.0% of claude-code records are its own host, the rest is claude-desktop 10.0%')
  })
})

describe('the two picks', () => {
  const split = (agentId: string, dominant: number, rest: number, dominantHost = 'desk') =>
    hostSplitFor(agentId, [
      { host: dominantHost, events: dominant },
      { host: `${agentId}-cli`, events: rest },
    ])!

  it('warns about the highest share and annotates the busiest view', () => {
    const a = split('alpha', 85, 15)
    const b = split('beta', 95, 5)
    const c = split('gamma', 60, 40)
    expect(pickHostWarning([a, b, c])?.agentId).toBe('beta')
    // Busiest, not loudest: the note describes what the page is doing to the user's numbers.
    expect(pickHostSplit([split('big', 8_000, 1_000), split('small', 950, 50)])?.agentId).toBe('big')
    expect(pickHostWarning([c])).toBeNull()
  })

  it('returns nothing when no agent has two distinct hosts', () => {
    expect(pickHostSplit([hostSplitFor('solo', [{ host: 'solo', events: 10 }])])).toBeNull()
  })
})

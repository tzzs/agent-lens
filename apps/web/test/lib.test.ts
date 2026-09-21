import { describe, expect, it } from 'vitest'
import { projectLabel, shortId, looksLikeHash, formatMs } from '../src/lib/format.ts'
import { halfOverHalf, topN } from '../src/lib/series.ts'
import { barGeometry, buildForest, parentIds, sessionSpan, visibleRows, type ForestNode } from '../src/lib/timeline.ts'
import { eventKind } from '../src/lib/eventKinds.ts'

const n = (id: string, parent: string | null = null, ts: number | null = 0, dur: number | null = null): ForestNode => ({
  id,
  parentEventId: parent,
  timestamp: ts,
  durationMs: dur,
})

describe('format helpers', () => {
  it('shortens hash ids and leaves human names alone', () => {
    const h = 'd42d99c3305e156cfed44f339624e342a662ead29b44e32be9d357d4575fd1b3'
    expect(looksLikeHash(h)).toBe(true)
    expect(projectLabel(h)).toBe('d42d99c3')
    expect(projectLabel('agent-lens')).toBe('agent-lens')
    expect(projectLabel(null)).toBe('(no project)')
    expect(shortId('abc')).toBe('abc')
    expect(shortId(null)).toBe('—')
  })
  it('formats durations with a real unit, never "Kms"', () => {
    expect(formatMs(201_170_000)).toBe('55h 52m')
    expect(formatMs(0)).toBe('0ms')
  })
})

describe('series', () => {
  it('folds the tail into Other and drops zero slices', () => {
    const rows = [5, 4, 3, 2, 1, 0].map((v, i) => ({ label: `p${i}`, value: v }))
    const out = topN(rows, 3)
    expect(out.map((r) => r.label)).toEqual(['p0', 'p1', 'Other (3)'])
    expect(out[2]!.value).toBe(6)
    expect(topN(rows, 10)).toHaveLength(5)
  })
  it('compares the second half of a window with the first', () => {
    expect(halfOverHalf([1, 1, 2, 2])).toBe(1)
    expect(halfOverHalf([0, 0, 5, 5])).toBeNull()
    expect(halfOverHalf([1, 2])).toBeNull()
  })
})

describe('timeline', () => {
  const nodes = [n('a'), n('a1', 'a'), n('a1x', 'a1'), n('a2', 'a'), n('b'), n('o', 'missing')]
  const forest = buildForest(nodes)

  it('builds the parent forest and counts orphans as roots', () => {
    expect(forest.roots.map((r) => r.id)).toEqual(['a', 'b', 'o'])
    expect(forest.orphans).toBe(1)
    expect(parentIds(forest)).toEqual(new Set(['a', 'a1']))
  })

  it('shows only roots until a subtree is expanded, in depth-first order', () => {
    expect(visibleRows(forest, nodes, new Set()).map((r) => r.node.id)).toEqual(['a', 'b', 'o'])
    const rows = visibleRows(forest, nodes, new Set(['a', 'a1']))
    expect(rows.map((r) => `${r.node.id}@${r.depth}`)).toEqual(['a@0', 'a1@1', 'a1x@2', 'a2@1', 'b@0', 'o@0'])
    expect(rows[0]!.childCount).toBe(2)
  })

  it('flattens matches regardless of collapsed parents when filtering', () => {
    const rows = visibleRows(forest, nodes, new Set(), (x) => x.id.includes('1'))
    expect(rows.map((r) => r.node.id)).toEqual(['a1', 'a1x'])
  })

  it('handles a very deep chain without recursion', () => {
    const chain = Array.from({ length: 20_000 }, (_, i) => n(`c${i}`, i ? `c${i - 1}` : null))
    const f = buildForest(chain)
    const rows = visibleRows(f, chain, parentIds(f))
    expect(rows).toHaveLength(20_000)
    expect(rows.at(-1)!.depth).toBe(19_999)
  })

  it('places waterfall bars within the session span', () => {
    const span = sessionSpan([n('x', null, 1000, 500), n('y', null, 2000, null)])!
    expect(span).toEqual({ start: 1000, end: 2000 })
    expect(barGeometry(n('x', null, 1000, 500), span)).toEqual({ left: 0, width: 50 })
    expect(barGeometry(n('y', null, 2000, null), span)).toEqual({ left: 100, width: 0 })
    expect(barGeometry(n('z', null, 1500, 1), span)!.width).toBe(0.4)
    expect(barGeometry(n('t', null, null), span)).toBeNull()
  })
})

describe('eventKind', () => {
  it('maps types to labels, groups and theme colours', () => {
    expect(eventKind('message.user')).toMatchObject({ label: 'user', group: 'message' })
    expect(eventKind('tool.bash')).toMatchObject({ label: 'bash', group: 'tool' })
    expect(eventKind('subagent.start').group).toBe('agent')
    expect(eventKind('error.api').color).toBe('var(--red)')
    expect(eventKind(null).label).toBe('event')
  })
})

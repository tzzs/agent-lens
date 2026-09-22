/**
 * Session waterfall shaping. A session can hold tens of thousands of events, so
 * the page never renders the parent_event_id forest recursively: it builds the
 * forest once, then flattens only the *visible* rows (roots plus the subtrees the
 * user expanded) into an array that a fixed-row-height virtual list windows.
 */

export interface ForestNode {
  id: string
  parentEventId: string | null
  timestamp: number | null
  durationMs: number | null
}

export interface Forest<N extends ForestNode> {
  roots: N[]
  children: Map<string, N[]>
  /** events whose parent id is set but absent from this session (shown as roots) */
  orphans: number
}

export function buildForest<N extends ForestNode>(nodes: N[]): Forest<N> {
  const ids = new Set(nodes.map((n) => n.id))
  const children = new Map<string, N[]>()
  const roots: N[] = []
  let orphans = 0
  for (const n of nodes) {
    if (n.parentEventId && ids.has(n.parentEventId)) {
      const arr = children.get(n.parentEventId)
      if (arr) arr.push(n)
      else children.set(n.parentEventId, [n])
    } else {
      if (n.parentEventId) orphans++
      roots.push(n)
    }
  }
  return { roots, children, orphans }
}

export interface Row<N> {
  node: N
  depth: number
  childCount: number
}

/**
 * Depth-first flattening of the forest, descending only into `expanded` ids.
 * With a `match` predicate the tree is ignored and every matching node is
 * returned flat (depth 0, in source order) — filtering a tree by type would
 * otherwise hide matches under collapsed parents.
 */
export function visibleRows<N extends ForestNode>(
  forest: Forest<N>,
  all: N[],
  expanded: ReadonlySet<string>,
  match?: (n: N) => boolean,
): Row<N>[] {
  if (match) {
    const out: Row<N>[] = []
    for (const n of all) if (match(n)) out.push({ node: n, depth: 0, childCount: forest.children.get(n.id)?.length ?? 0 })
    return out
  }
  const out: Row<N>[] = []
  // Iterative DFS: a deep subagent chain must not blow the call stack.
  const stack: { node: N; depth: number }[] = []
  for (let i = forest.roots.length - 1; i >= 0; i--) stack.push({ node: forest.roots[i]!, depth: 0 })
  while (stack.length) {
    const { node, depth } = stack.pop()!
    const kids = forest.children.get(node.id)
    out.push({ node, depth, childCount: kids?.length ?? 0 })
    if (kids && expanded.has(node.id)) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, depth: depth + 1 })
    }
  }
  return out
}

/** Every id that has children — for "expand all". */
export function parentIds<N extends ForestNode>(forest: Forest<N>): Set<string> {
  return new Set(forest.children.keys())
}

export interface Span {
  start: number
  end: number
}

/** The session's time extent: explicit bounds when known, else the nodes' own. */
export function sessionSpan(nodes: ForestNode[], first?: number | null, last?: number | null): Span | null {
  let start = Number.isFinite(first) ? (first as number) : Infinity
  let end = Number.isFinite(last) ? (last as number) : -Infinity
  for (const n of nodes) {
    if (n.timestamp === null || !Number.isFinite(n.timestamp)) continue
    start = Math.min(start, n.timestamp)
    end = Math.max(end, n.timestamp + Math.max(0, n.durationMs ?? 0))
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start, end: Math.max(end, start + 1) }
}

/**
 * Waterfall bar geometry in percent of the session span. Events without a
 * duration get `width: 0` and render as a tick; a real duration is floored at
 * 0.4% so a 5ms call in a 3-hour session is still visible.
 */
export function barGeometry(n: ForestNode, span: Span | null): { left: number; width: number } | null {
  if (!span || n.timestamp === null || !Number.isFinite(n.timestamp)) return null
  const total = span.end - span.start
  const left = Math.min(100, Math.max(0, ((n.timestamp - span.start) / total) * 100))
  const dur = n.durationMs ?? 0
  const width = dur > 0 ? Math.min(100 - left, Math.max(0.4, (dur / total) * 100)) : 0
  return { left, width }
}

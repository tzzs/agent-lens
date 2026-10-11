/**
 * One place that decides how a timeline event type reads: its short label, its
 * colour (a --cat-N theme token, so light/dark both stay legible) and the filter
 * group it belongs to. TimelineNode, Payload and the session filter chips all
 * read this instead of carrying their own hex tables.
 *
 * Labels come from the message catalog because they are UI words ("user",
 * "compact"), but a *named* tool keeps its own name: `tool.bash` reads "bash"
 * in every locale, since that is an identifier this tool did not choose.
 */

import { msg } from '@agentlens/i18n'

export type EventGroup = 'message' | 'tool' | 'agent' | 'context' | 'error' | 'other'

export interface EventKind {
  label: string
  color: string
  group: EventGroup
}

const cat = (n: number) => `var(--cat-${n})`

export function eventKind(type: string | null | undefined): EventKind {
  const t = type ?? ''
  if (t.startsWith('message.user')) return { label: msg('ev.user'), color: cat(1), group: 'message' }
  if (t.startsWith('message.assistant')) return { label: msg('ev.assistant'), color: cat(2), group: 'message' }
  if (t.startsWith('tool')) return { label: t.replace('tool.', '') || msg('ev.tool'), color: cat(4), group: 'tool' }
  if (t.startsWith('skill')) return { label: msg('ev.skill'), color: cat(3), group: 'tool' }
  if (t.startsWith('mcp')) return { label: msg('ev.mcp'), color: cat(2), group: 'tool' }
  if (t.startsWith('plugin')) return { label: msg('ev.plugin'), color: cat(8), group: 'tool' }
  if (t.startsWith('connector')) return { label: msg('ev.connector'), color: cat(2), group: 'tool' }
  if (t.startsWith('command')) return { label: msg('ev.command'), color: cat(7), group: 'tool' }
  if (t.startsWith('subagent')) return { label: msg('ev.subagent'), color: cat(5), group: 'agent' }
  if (t.startsWith('hook')) return { label: msg('ev.hook'), color: cat(7), group: 'tool' }
  if (t.startsWith('generation')) return { label: msg('ev.generation'), color: cat(1), group: 'message' }
  if (t.startsWith('context.compact')) return { label: msg('ev.compact'), color: cat(6), group: 'context' }
  if (t.startsWith('error')) return { label: msg('ev.error'), color: 'var(--red)', group: 'error' }
  if (t.startsWith('session')) return { label: t.replace('session.', ''), color: 'var(--cat-muted)', group: 'other' }
  return { label: t || msg('ev.event'), color: 'var(--cat-muted)', group: 'other' }
}

/**
 * Filter chips on the session page, in display order. A function, not a const:
 * the labels are locale-dependent, so they cannot be read once at import time.
 */
export function eventGroups(): { key: EventGroup; label: string }[] {
  return [
    { key: 'message', label: msg('ev.groupMessage') },
    { key: 'tool', label: msg('ev.groupTool') },
    { key: 'agent', label: msg('ev.groupAgent') },
    { key: 'context', label: msg('ev.groupContext') },
    { key: 'error', label: msg('ev.groupError') },
    { key: 'other', label: msg('ev.groupOther') },
  ]
}

/** Payload kinds (content layer) share the same palette as the events that carry them. */
export function payloadColor(kind: string): string {
  switch (kind) {
    case 'user_message':
      return cat(1)
    case 'assistant_message':
      return cat(2)
    case 'tool_input':
      return cat(4)
    case 'tool_output':
      return cat(3)
    case 'reasoning':
      return cat(1)
    default:
      return 'var(--cat-muted)'
  }
}

/** Categorical series colours for charts, in slot order. */
// Order, not hue, is what keeps neighbours apart: charts hand these out in sequence, so
// adjacent slots are adjacent segments and lines. The token order put green (5) beside
// red (6) — ΔE 2.8 under deuteranopia. This order, searched against the dataviz
// validator over both themes, keeps every adjacent pair at ΔE ≥ 11 (target 8) and the
// normal-vision floor at 18. Tokens are unchanged; only the hand-out order moved.
export const SERIES = [1, 3, 8, 7, 2, 6, 4, 5].map(cat)

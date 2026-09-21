/**
 * One place that decides how a timeline event type reads: its short label, its
 * colour (a --cat-N theme token, so light/dark both stay legible) and the filter
 * group it belongs to. TimelineNode, Payload and the session filter chips all
 * read this instead of carrying their own hex tables.
 */

export type EventGroup = 'message' | 'tool' | 'agent' | 'context' | 'error' | 'other'

export interface EventKind {
  label: string
  color: string
  group: EventGroup
}

const cat = (n: number) => `var(--cat-${n})`

export function eventKind(type: string | null | undefined): EventKind {
  const t = type ?? ''
  if (t.startsWith('message.user')) return { label: 'user', color: cat(1), group: 'message' }
  if (t.startsWith('message.assistant')) return { label: 'assistant', color: cat(2), group: 'message' }
  if (t.startsWith('tool')) return { label: t.replace('tool.', '') || 'tool', color: cat(4), group: 'tool' }
  if (t.startsWith('skill')) return { label: 'skill', color: cat(3), group: 'tool' }
  if (t.startsWith('mcp')) return { label: 'mcp', color: cat(2), group: 'tool' }
  if (t.startsWith('plugin')) return { label: 'plugin', color: cat(8), group: 'tool' }
  if (t.startsWith('connector')) return { label: 'connector', color: cat(2), group: 'tool' }
  if (t.startsWith('command')) return { label: 'command', color: cat(7), group: 'tool' }
  if (t.startsWith('subagent')) return { label: 'subagent', color: cat(5), group: 'agent' }
  if (t.startsWith('hook')) return { label: 'hook', color: cat(7), group: 'tool' }
  if (t.startsWith('generation')) return { label: 'gen', color: cat(1), group: 'message' }
  if (t.startsWith('context.compact')) return { label: 'compact', color: cat(6), group: 'context' }
  if (t.startsWith('error')) return { label: 'error', color: 'var(--red)', group: 'error' }
  if (t.startsWith('session')) return { label: t.replace('session.', ''), color: 'var(--cat-muted)', group: 'other' }
  return { label: t || 'event', color: 'var(--cat-muted)', group: 'other' }
}

/** Filter chips on the session page, in display order. */
export const EVENT_GROUPS: { key: EventGroup; label: string }[] = [
  { key: 'message', label: 'Messages' },
  { key: 'tool', label: 'Tools' },
  { key: 'agent', label: 'Subagents' },
  { key: 'context', label: 'Compaction' },
  { key: 'error', label: 'Errors' },
  { key: 'other', label: 'Other' },
]

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
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map(cat)

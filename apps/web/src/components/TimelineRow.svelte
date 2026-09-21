<script lang="ts">
  // One waterfall row, fixed height. Left: tree indent, expand toggle, kind chip and
  // name. Right: the event's bar on the session's time axis, then duration, tokens
  // and wall-clock time. Selecting the row opens it in the inspector.
  import type { TimelineNode } from '../lib/api.ts'
  import { eventKind } from '../lib/eventKinds.ts'
  import { barGeometry, type Span } from '../lib/timeline.ts'
  import { formatCompact, formatMs, formatClock } from '../lib/format.ts'
  import Icon from './ui/Icon.svelte'

  let {
    node,
    depth,
    childCount,
    expanded,
    selected,
    span,
    onToggle,
    onSelect,
  }: {
    node: TimelineNode
    depth: number
    childCount: number
    expanded: boolean
    selected: boolean
    span: Span | null
    onToggle: () => void
    onSelect: () => void
  } = $props()

  const kind = $derived(eventKind(node.type))
  // The chip already names the kind; only show text that adds information, and
  // fall back to the raw type just for kinds the map does not know.
  const name = $derived(node.capability?.name ?? node.subtype ?? node.model?.name ?? (kind.group === 'other' ? node.type : ''))
  const tokens = $derived(
    node.usage ? node.usage.inputTokens + node.usage.outputTokens + node.usage.cacheReadTokens + node.usage.cacheWriteTokens + node.usage.reasoningTokens : 0,
  )
  const bar = $derived(barGeometry(node, span))
  const errored = $derived(node.status === 'error')
  const indent = $derived(Math.min(depth, 12) * 14)
</script>

<div
  class="tl-grid group h-full items-center border-b border-line-soft px-3 text-[13px] transition-colors
    {selected ? 'bg-accent-tint' : 'hover:bg-hover'}"
>
  <div class="flex min-w-0 items-center gap-1.5" style="padding-left:{indent}px">
    {#if childCount > 0}
      <button
        type="button"
        class="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-hover-2 hover:text-ink"
        aria-expanded={expanded}
        aria-label="{expanded ? 'Collapse' : 'Expand'} {childCount} child events"
        onclick={onToggle}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
      </button>
    {:else}
      <span class="grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
        {#if depth > 0}<span class="h-px w-2 bg-line-strong"></span>{/if}
      </span>
    {/if}
    <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={onSelect} aria-pressed={selected}>
      <span
        class="inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[11px] font-medium"
        style="color:{kind.color};background:color-mix(in oklch, {kind.color} 14%, transparent)"
      >{kind.label}</span>
      <span class="truncate {node.capability ? 'nums text-ink' : 'text-ink-2'}">{name}</span>
      {#if childCount > 0 && !expanded}<span class="nums shrink-0 text-xs text-ink-3">+{childCount}</span>{/if}
      {#if errored}<span class="shrink-0 rounded-full bg-red-tint px-1.5 text-[11px] font-medium text-red">error</span>{/if}
    </button>
  </div>

  <div class="tl-track relative h-3.5" aria-hidden="true">
    {#if bar}
      {#if bar.width > 0}
        <span class="absolute inset-y-0 rounded-[3px]" style="left:{bar.left}%;width:{bar.width}%;background:{errored ? 'var(--red)' : kind.color};opacity:.85"></span>
      {:else}
        <span class="absolute inset-y-0.5 w-[2px] -translate-x-1/2 rounded-full" style="left:{bar.left}%;background:{kind.color}"></span>
      {/if}
    {/if}
  </div>

  <span class="nums text-right text-xs text-ink-2">{node.durationMs != null ? formatMs(node.durationMs) : ''}</span>
  <span class="nums tl-tokens text-right text-xs text-ink-3">{tokens > 0 ? formatCompact(tokens) : ''}</span>
  <span class="nums text-right text-xs text-ink-3">{formatClock(node.timestamp).slice(0, 8)}</span>
</div>

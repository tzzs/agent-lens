<script lang="ts" generics="T">
  // Fixed-row-height windowing: only the rows in (or near) the viewport exist in
  // the DOM, so a 13k-event session renders as fast as a 30-event one. Rows must
  // all be `itemHeight` px tall — variable-height detail lives in a side panel.
  import type { Snippet } from 'svelte'
  import { msg } from '@agentlens/i18n'

  let {
    items,
    itemHeight,
    height = '60vh',
    overscan = 12,
    key,
    row,
    label = msg('comps.list'),
    role = 'list',
    itemAttrs,
    onkeydown,
  }: {
    items: T[]
    itemHeight: number
    height?: string
    overscan?: number
    key: (item: T, i: number) => string
    row: Snippet<[T, number]>
    label?: string
    /** `tree` when rows expand/collapse and arrow keys navigate (the session waterfall) */
    role?: 'list' | 'tree'
    itemAttrs?: (item: T) => Record<string, string | number | boolean | undefined>
    onkeydown?: (e: KeyboardEvent) => void
  } = $props()

  let viewport: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let viewH = $state(600)

  const start = $derived(Math.max(0, Math.floor(scrollTop / itemHeight) - overscan))
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + viewH) / itemHeight) + overscan))
  const slice = $derived(items.slice(start, end))

  /** Bring row `i` into view with minimal scrolling (keyboard navigation). */
  export function scrollToIndex(i: number) {
    if (!viewport) return
    const top = i * itemHeight
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + itemHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + itemHeight - viewport.clientHeight
  }
</script>

<div
  bind:this={viewport}
  bind:clientHeight={viewH}
  class="relative overflow-y-auto overscroll-contain"
  style="height:{height}"
  onscroll={() => (scrollTop = viewport?.scrollTop ?? 0)}
  {role}
  aria-label={label}
  tabindex="-1"
  {onkeydown}
>
  <div style="height:{items.length * itemHeight}px;position:relative">
    <div style="position:absolute;inset-inline:0;top:{start * itemHeight}px">
      {#each slice as item, j (key(item, start + j))}
        <div role={role === 'tree' ? 'treeitem' : 'listitem'} {...itemAttrs?.(item)} style="height:{itemHeight}px">{@render row(item, start + j)}</div>
      {/each}
    </div>
  </div>
</div>

<script lang="ts" module>
  export interface Column {
    key: string
    label: string
    align?: 'left' | 'right'
    width?: string
    info?: string
  }
</script>

<script lang="ts" generics="T">
  // Beautiful UI records table. Columns declare label/alignment/width; pages render
  // their own <td>s through the `row` snippet so cells stay free-form (links, cost
  // figures, chips). Column widths are fixed through <colgroup> and cells truncate,
  // so one long hash can no longer push the rest of the table off-screen.
  import type { Snippet } from 'svelte'
  import InfoTip from './InfoTip.svelte'

  let {
    columns,
    rows,
    key,
    row,
    expanded,
    isExpanded,
    footer,
    empty = 'No rows',
    maxHeight = 0,
    dense = false,
    caption = '',
    minWidth = 720,
  }: {
    columns: Column[]
    rows: T[]
    key: (r: T, i: number) => string
    row: Snippet<[T, number]>
    expanded?: Snippet<[T]>
    isExpanded?: (r: T) => boolean
    footer?: Snippet
    empty?: string
    maxHeight?: number
    dense?: boolean
    caption?: string
    /** below this width the table scrolls sideways inside its card instead of squeezing every cell to an ellipsis */
    minWidth?: number
  } = $props()
</script>

<div class="dt overflow-auto" class:dense style={maxHeight ? `max-height:${maxHeight}px` : ''}>
  <table class="w-full table-fixed border-separate border-spacing-0 text-left text-[13px]" style="min-width:{minWidth}px">
    {#if caption}<caption class="sr-only">{caption}</caption>{/if}
    <colgroup>
      {#each columns as c (c.key)}<col style={c.width ? `width:${c.width}` : ''} />{/each}
    </colgroup>
    <thead>
      <tr>
        {#each columns as c (c.key)}
          <th scope="col" class="sticky top-0 z-[1] border-b border-line bg-surface text-xs font-medium text-ink-3 {c.align === 'right' ? 'text-right' : ''}">
            <span class="inline-flex items-center gap-1 {c.align === 'right' ? 'flex-row-reverse' : ''}">
              {c.label}{#if c.info}<InfoTip text={c.info} />{/if}
            </span>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as r, i (key(r, i))}
        <tr class="transition-colors hover:bg-hover">{@render row(r, i)}</tr>
        {#if expanded && isExpanded?.(r)}
          <tr><td colspan={columns.length} class="!p-0">{@render expanded(r)}</td></tr>
        {/if}
      {:else}
        <tr><td colspan={columns.length} class="!py-10 text-center text-ink-3">{empty}</td></tr>
      {/each}
    </tbody>
    {#if footer}
      <tfoot>{@render footer()}</tfoot>
    {/if}
  </table>
</div>

<style>
  .dt :global(th),
  .dt :global(td) {
    padding: 9px 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dt.dense :global(th),
  .dt.dense :global(td) {
    padding: 6px 12px;
  }
  .dt :global(tbody td) {
    border-bottom: 1px solid var(--line-soft);
  }
  .dt :global(tbody tr:last-child td) {
    border-bottom: 0;
  }
  .dt :global(tfoot td) {
    border-top: 1px solid var(--line);
    color: var(--ink-2);
  }
</style>

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
  import { msg } from '@agentlens/i18n'
  import { t } from '../../lib/lang.js'
  import InfoTip from './InfoTip.svelte'

  let {
    columns,
    rows,
    key,
    row,
    expanded,
    isExpanded,
    footer,
    empty = msg('comps.noRows'),
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

  /**
   * A table that scrolls sideways has to say so: at phone widths the last two or three
   * columns sit entirely off-screen and nothing on the page hinted that more existed. The
   * fade answers "is there more to the right", which only the scrolled box knows, so it is
   * measured rather than guessed from a breakpoint — a wide table on a desktop gets no fade
   * and no tab stop, and neither can go stale when the window resizes or rows change.
   */
  let scrollable = $state(false)
  let atEnd = $state(true)

  function trackScroll(node: HTMLElement) {
    const measure = () => {
      const slack = node.scrollWidth - node.clientWidth
      scrollable = slack > 1
      atEnd = slack - node.scrollLeft <= 1
    }
    const observer = new ResizeObserver(measure)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    node.addEventListener('scroll', measure, { passive: true })
    measure()
    return { update: measure, destroy: () => { observer.disconnect(); node.removeEventListener('scroll', measure) } }
  }
</script>

<div class="relative">
  <div
    class="dt overflow-auto"
    class:dense
    class:scrollable
    style={maxHeight ? `max-height:${maxHeight}px` : ''}
    use:trackScroll
    role={scrollable ? 'region' : undefined}
    aria-label={scrollable ? $t('comps.scrollTable') : undefined}
    tabindex={scrollable ? 0 : undefined}
  >
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
  {#if scrollable && !atEnd}<span class="dt-fade" aria-hidden="true"></span>{/if}
</div>

<style>
  .dt-fade {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 40px;
    pointer-events: none;
    /* Not a fade into `--surface`: on the light theme that is white on white and says
       nothing. A wash of the muted ink colour reads on both themes, and it is the only
       hint that the columns cut off at the card edge continue. */
    background: linear-gradient(to right, transparent, color-mix(in oklch, var(--ink-3) 30%, transparent));
  }
  /* Only a table that actually scrolls pins its first column: otherwise the sticky cell
     paints over its own row for no reason. */
  .dt.scrollable :global(th:first-child),
  .dt.scrollable :global(td:first-child) {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--surface);
  }
  .dt.scrollable :global(tbody tr:hover td:first-child) {
    background: var(--hover);
  }
  /* the top-left cell is sticky in both directions, so it has to beat the sticky header row */
  .dt.scrollable :global(thead th:first-child) {
    z-index: 2;
  }
  .dt:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
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

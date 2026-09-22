<script lang="ts">
  // The card shell every page is built from (Beautiful UI's surface: white on the
  // page canvas, hairline ring + soft shadow instead of a hard border).
  import type { Snippet } from 'svelte'
  import InfoTip from './InfoTip.svelte'

  let {
    title = '',
    subtitle = '',
    note = '',
    info = '',
    padded = true,
    class: cls = '',
    actions,
    children,
  }: {
    title?: string
    subtitle?: string
    note?: string
    info?: string
    padded?: boolean
    class?: string
    actions?: Snippet
    children?: Snippet
  } = $props()
</script>

<!-- unpadded surfaces hold edge-to-edge content (tables, lists): clip it to the rounded corners -->
<section class="min-w-0 rounded-card bg-surface shadow-card {padded ? '' : 'overflow-hidden'} {cls}">
  {#if title || subtitle || actions}
    <header class="flex items-start justify-between gap-3 px-4 pt-3.5 {padded ? 'pb-0' : 'pb-3 border-b border-line-soft'}">
      <div class="min-w-0">
        {#if title}
          <h3 class="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span class="truncate">{title}</span>
            {#if info}<InfoTip text={info} />{/if}
          </h3>
        {/if}
        {#if subtitle}<p class="mt-0.5 truncate text-xs text-ink-3">{subtitle}</p>{/if}
      </div>
      <div class="flex shrink-0 items-center gap-2">
        {#if note}<span class="text-xs text-ink-3">{note}</span>{/if}
        {@render actions?.()}
      </div>
    </header>
  {/if}
  <div class={padded ? 'p-4' : ''}>
    {@render children?.()}
  </div>
</section>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { t } from '../../lib/lang.js'
  import InfoTip from './InfoTip.svelte'
  let {
    title,
    description = '',
    info = '',
    refreshing = false,
    back,
    actions,
  }: {
    title: string
    description?: string
    info?: string
    refreshing?: boolean
    back?: { href: string; label: string }
    actions?: Snippet
  } = $props()
</script>

<div class="mb-5 flex flex-wrap items-end justify-between gap-3">
  <div class="min-w-0">
    {#if back}
      <a href={back.href} class="mb-1.5 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-accent">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
        {back.label}
      </a>
    {/if}
    <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight text-ink">
      <span class="truncate">{title}</span>
      {#if info}<InfoTip text={info} />{/if}
      {#if refreshing}
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" title={$t('comps.refreshing')} aria-label={$t('comps.refreshing')}></span>
      {/if}
    </h1>
    {#if description}<p class="mt-1 text-[13px] text-ink-2">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
</div>

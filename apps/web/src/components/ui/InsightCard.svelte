<script lang="ts">
  // KPI tile (Beautiful UI insight card): label, one big figure, an optional
  // change vs the previous half of the window, and free-form detail below.
  import type { Snippet } from 'svelte'
  import InfoTip from './InfoTip.svelte'

  let {
    label,
    info = '',
    delta = null,
    deltaLabel = 'vs prior period',
    children,
    detail,
  }: {
    label: string
    info?: string
    /** fractional change, e.g. 0.12 = +12%; null hides the badge */
    delta?: number | null
    deltaLabel?: string
    children: Snippet
    detail?: Snippet
  } = $props()

  const deltaText = $derived(
    delta === null || !Number.isFinite(delta) ? '' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}%`,
  )
</script>

<section class="flex min-w-0 flex-col rounded-card bg-surface p-4 shadow-card">
  <div class="flex items-center justify-between gap-2">
    <h3 class="flex items-center gap-1.5 text-xs font-medium text-ink-2">{label}{#if info}<InfoTip text={info} />{/if}</h3>
    {#if deltaText}
      <span class="nums rounded-full bg-hover-2/70 px-1.5 py-0.5 text-[11px] text-ink-2" title={deltaLabel}>{deltaText}</span>
    {/if}
  </div>
  <div class="mt-2 min-w-0">{@render children()}</div>
  {#if detail}<div class="mt-3 border-t border-line-soft pt-3">{@render detail()}</div>{/if}
</section>

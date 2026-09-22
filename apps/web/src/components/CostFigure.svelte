<script lang="ts">
  // One cost number, rendered with the same basis the server gave (§8/§18):
  //  - null -> "n/a" (never "$0"; an unknown price must not read as free)
  //  - a partial total (some agents unpriced) -> "≥ $x" so the figure is a floor
  //  - an estimate is labelled "est." so a computed cost is never mistaken for cash
  import { formatUsd } from '../lib/format.ts'

  let {
    value,
    basis = 'est',
    partial = false,
    size = 'sm',
    showLabel = true,
  }: {
    value: number | null | undefined
    basis?: 'est' | 'actual' | 'reported'
    partial?: boolean
    size?: 'sm' | 'lg'
    showLabel?: boolean
  } = $props()

  const labelText = { est: 'est.', actual: 'actual', reported: 'reported' }
  const titles = {
    est: 'Computed estimate: tokens × list price (cost_api_equiv). Not a cash figure.',
    actual: 'Actual cash after the declared billing mode — subscription and local models spend 0 (§8).',
    reported: "Cost the agent logged for itself (§18 row 1): only where an agent's own log carries the figure, so which agents report is a fact about the data, not a fixed list; every other cost here falls back to the computed estimate (est.).",
  }
  const text = $derived(formatUsd(value))
  const na = $derived(text === 'n/a')
  const shown = $derived(!na && partial ? `≥ ${text}` : text)
  const title = $derived(
    na ? 'No price available for this model — shown as n/a, never $0 (§8).' : partial ? `${titles[basis]} At least this much: some agents have no price and are excluded.` : titles[basis],
  )
</script>

<span class="nums inline-flex items-baseline gap-1 whitespace-nowrap" {title}>
  <span class="{size === 'lg' ? 'text-[26px] font-semibold tracking-tight' : ''} {na ? 'text-ink-3' : 'text-ink'}">{shown}</span>
  {#if showLabel}
    <span class="font-sans {size === 'lg' ? 'text-xs' : 'text-[11px]'} text-ink-3">{labelText[basis]}</span>
  {/if}
</span>

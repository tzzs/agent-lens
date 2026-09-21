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
  }: {
    value: number | null | undefined
    basis?: 'est' | 'actual' | 'reported'
    partial?: boolean
    size?: 'sm' | 'lg'
  } = $props()

  const labelText = { est: 'est. API', actual: 'actual', reported: 'reported' }
  const titles = {
    est: 'computed estimate: tokens × price (cost_api_equiv). Not a cash figure.',
    actual: 'actual cash after the declared billing mode (§8: subscription/local real spend is 0)',
    reported: 'cost the agent logged for itself (§18 row 1); only OpenCode/WorkBuddy report it',
  }
  const text = $derived(formatUsd(value))
  const shown = $derived(text !== 'n/a' && partial ? `≥ ${text}` : text)
  const big = $derived(size === 'lg')
</script>

<span class="nums" class:text-mist-500={text === 'n/a'} title={titles[basis]}>
  <span class={big ? 'text-2xl font-semibold' : ''}>{shown}</span>
  <span class="ml-1 {big ? 'text-xs' : 'text-[10px]'} uppercase tracking-wide text-mist-500">{labelText[basis]}</span>
</span>

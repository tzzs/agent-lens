<script lang="ts">
  // One cost number, rendered with the same basis the server gave (§8/§18):
  //  - null -> "n/a" (never "$0"; an unknown price must not read as free)
  //  - a partial total (some agents unpriced) -> "≥ $x" so the figure is a floor
  //  - an estimate is labelled "est." so a computed cost is never mistaken for cash
  import { formatUsd, isUnpriced } from '../lib/format.ts'
  import { t } from '../lib/lang.js'

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

  const labelText = $derived({
    est: $t('viz.costLabelEst'),
    actual: $t('viz.costLabelActual'),
    reported: $t('viz.costLabelReported'),
  })
  const titles = $derived({
    est: $t('viz.costTitleEst'),
    actual: $t('viz.costTitleActual'),
    reported: $t('viz.costTitleReported'),
  })
  const text = $derived(formatUsd(value))
  // Decided from the input, never from the rendered glyph: "n/a" is a word, and
  // the word changes with the interface language.
  const na = $derived(isUnpriced(value))
  const shown = $derived(!na && partial ? `≥ ${text}` : text)
  const title = $derived(
    na ? $t('viz.costTitleNoPrice') : partial ? `${titles[basis]} ${$t('viz.costTitlePartial')}` : titles[basis],
  )
</script>

<span class="nums inline-flex items-baseline gap-1 whitespace-nowrap" {title}>
  <span class="{size === 'lg' ? 'text-[26px] font-semibold tracking-tight' : ''} {na ? 'text-ink-3' : 'text-ink'}">{shown}</span>
  {#if showLabel}
    <span class="font-sans {size === 'lg' ? 'text-xs' : 'text-[11px]'} text-ink-3">{labelText[basis]}</span>
  {/if}
</span>

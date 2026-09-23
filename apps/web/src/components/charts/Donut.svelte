<script lang="ts">
  // Hand-rolled SVG donut (Recharts is React-only; charts stay dependency-free and
  // local). Long tails fold into "Other" so the legend stays readable; colours come
  // from the --cat-N theme tokens.
  import { SERIES } from '../../lib/eventKinds.ts'
  import { topN } from '../../lib/series.ts'
  import { msg } from '@agentlens/i18n'
  import { t } from '../../lib/lang.js'

  let {
    data = [],
    size = 148,
    thickness = 18,
    max = 6,
    format = (n: number) => String(n),
    label = msg('viz.donutBreakdown'),
  }: {
    data: { label: string; value: number; title?: string }[]
    size?: number
    thickness?: number
    max?: number
    format?: (n: number) => string
    label?: string
  } = $props()

  const rows = $derived(topN(data, max))
  const total = $derived(rows.reduce((a, b) => a + b.value, 0))
  const r = $derived((size - thickness) / 2)
  const c = $derived(2 * Math.PI * r)
  // a hairline gap between segments reads cleaner than touching arcs
  const gap = $derived(rows.length > 1 ? 2 : 0)

  const arcs = $derived.by(() => {
    let acc = 0
    return rows.map((d, i) => {
      const frac = total === 0 ? 0 : d.value / total
      const seg = {
        ...d,
        color: 'other' in d && d.other ? 'var(--cat-muted)' : SERIES[i % SERIES.length]!,
        dash: Math.max(0, frac * c - gap),
        offset: -acc * c,
        pct: frac,
      }
      acc += frac
      return seg
    })
  })
  let active = $state<number | null>(null)
  const centre = $derived(active === null ? { v: format(total), l: $t('viz.total') } : { v: format(arcs[active]!.value), l: arcs[active]!.label })
</script>

{#if total === 0}
  <div class="grid h-[148px] place-items-center rounded-lg border border-dashed border-line-strong text-xs text-ink-3">{$t('viz.noDataInRange')}</div>
{:else}
  <!-- container query: side-by-side only when the card itself is wide enough -->
  <div class="@container">
  <div class="flex flex-col items-center gap-4 @md:flex-row @md:items-center">
    <svg width={size} height={size} viewBox="0 0 {size} {size}" class="shrink-0" role="img" aria-label={$t('viz.donutAria', { values: { label, v: format(total) } })}>
      <g transform="translate({size / 2},{size / 2}) rotate(-90)">
        <circle {r} fill="none" stroke="var(--hover-2)" stroke-width={thickness} />
        {#each arcs as a, i (a.label)}
          <circle
            {r}
            fill="none"
            stroke={a.color}
            stroke-width={active === i ? thickness + 4 : thickness}
            stroke-dasharray="{a.dash} {c - a.dash}"
            stroke-dashoffset={a.offset}
            opacity={active === null || active === i ? 1 : 0.35}
            class="transition-[opacity,stroke-width] duration-150"
          />
        {/each}
      </g>
      <text x="50%" y="47%" text-anchor="middle" dominant-baseline="central" fill="var(--ink)" font-size="17" font-weight="600" font-family="var(--font-mono)">{centre.v}</text>
      <text x="50%" y="62%" text-anchor="middle" dominant-baseline="central" fill="var(--ink-3)" font-size="10.5">{centre.l.length > 18 ? centre.l.slice(0, 17) + '…' : centre.l}</text>
    </svg>
    <ul class="w-full min-w-0 flex-1 space-y-0.5 text-[13px]">
      {#each arcs as a, i (a.label)}
        <li>
          <div
            class="flex items-center gap-2 rounded-md px-1.5 py-1 {active === i ? 'bg-hover' : ''}"
            onpointerenter={() => (active = i)}
            onpointerleave={() => (active = null)}
            role="presentation"
          >
            <span class="h-2.5 w-2.5 shrink-0 rounded-[3px]" style="background:{a.color}"></span>
            <span class="min-w-0 flex-1 truncate text-ink-2" title={a.title ?? a.label}>{a.label}</span>
            <span class="nums shrink-0 text-ink">{format(a.value)}</span>
            <span class="nums w-9 shrink-0 text-right text-xs text-ink-3">{(a.pct * 100).toFixed(0)}%</span>
          </div>
        </li>
      {/each}
    </ul>
  </div>
  </div>
{/if}

<script lang="ts">
  // Stacked area over time: how a total splits into its parts, bucket by bucket (capability
  // calls by type, tokens by model). One metric per chart, like Sparkline, and one axis.
  // Series beyond the palette arrive already folded into "Other" (series.ts pivotSeries),
  // so every colour here follows its series key, never its rank.
  //
  // Reading it: hover or arrow keys put a crosshair on a bucket and list every series'
  // value there; the legend carries each series' total; an sr-only table carries all of it.
  import { msg } from '@agentlens/i18n'
  import { t } from '../../lib/lang.js'

  type Series = { key: string; label: string; color: string; values: number[]; total: number }
  let {
    buckets = [],
    series = [],
    height = 180,
    format = (n: number) => String(n),
    label = msg('viz.sparkTrend'),
  }: {
    buckets?: string[]
    series?: Series[]
    height?: number
    format?: (n: number) => string
    label?: string
  } = $props()

  const W = 600
  const padTop = 6
  const n = $derived(buckets.length)
  const stackTotals = $derived(buckets.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0)))
  const max = $derived(Math.max(0, ...stackTotals))
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => (max === 0 ? height : padTop + (height - padTop) * (1 - v / max))

  // Bottom-up cumulative bands: series[0] (the largest) sits on the baseline; the legend
  // and the tooltip list the same order, largest first, which is how people scan them.
  const bands = $derived.by(() => {
    const base = new Array<number>(n).fill(0)
    return series.map((s) => {
      const lo = base.slice()
      const hi = lo.map((b, i) => b + (s.values[i] ?? 0))
      for (let i = 0; i < n; i++) base[i] = hi[i]!
      const top = hi.map((v, i) => `${x(i)},${y(v)}`)
      const bottom = lo.map((v, i) => `${x(i)},${y(v)}`).reverse()
      return { ...s, area: `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`, line: top.join(' ') }
    })
  })

  let hover = $state<number | null>(null)
  let box: HTMLDivElement | undefined = $state()
  function onMove(e: PointerEvent) {
    if (!box || n === 0) return
    const r = box.getBoundingClientRect()
    hover = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (n - 1))
  }
  function onKey(e: KeyboardEvent) {
    if (n === 0) return
    if (e.key === 'ArrowRight') hover = Math.min(n - 1, (hover ?? -1) + 1)
    else if (e.key === 'ArrowLeft') hover = Math.max(0, (hover ?? n) - 1)
    else return
    e.preventDefault()
  }
  const pct = $derived(hover === null ? 0 : (x(hover) / W) * 100)
</script>

<div class="w-full">
  {#if n === 0 || max === 0}
    <div class="grid place-items-center rounded-lg border border-dashed border-line-strong text-xs text-ink-3" style="height:{height}px">
      {$t('viz.noDataInRange')}
    </div>
  {:else}
    {#if series.length > 1}
      <ul class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={$t('viz.legend')}>
        {#each series as s (s.key || '__other')}
          <li class="flex min-w-0 items-center gap-1.5">
            <span class="h-2.5 w-2.5 shrink-0 rounded-[3px]" style="background:{s.color}" aria-hidden="true"></span>
            <span class="truncate text-ink-2" title={s.label}>{s.label}</span>
            <span class="nums text-ink-3">{format(s.total)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <div
      bind:this={box}
      class="relative outline-none"
      style="height:{height}px"
      role="slider"
      tabindex="0"
      aria-label={$t('viz.sparkAria', { values: { label } })}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={hover ?? n - 1}
      aria-valuetext={hover === null ? `${$t('viz.peak')} ${format(max)}` : `${buckets[hover]}: ${format(stackTotals[hover] ?? 0)}`}
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
      onkeydown={onKey}
      onblur={() => (hover = null)}
    >
      <svg viewBox="0 0 {W} {height}" class="chart-reveal h-full w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={W} y1={y(max / 2)} y2={y(max / 2)} stroke="var(--line-soft)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--line)" vector-effect="non-scaling-stroke" />
        {#each bands as b (b.key || '__other')}
          <path d={b.area} fill={b.color} fill-opacity="0.78" />
          <!-- the surface-coloured edge is the 2px gap that keeps stacked fills apart -->
          <polyline points={b.line} fill="none" stroke="var(--surface)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        {/each}
      </svg>
      <span class="nums pointer-events-none absolute left-1 top-0 text-[10px] text-ink-3">{format(max)}</span>
      {#if hover !== null}
        <div class="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style="left:{pct}%"></div>
        <div
          class="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg bg-tooltip px-2.5 py-1.5 text-xs text-tooltip-fg shadow-overlay"
          style={pct > 60 ? `right:${100 - pct}%;margin-right:8px` : `left:${pct}%;margin-left:8px`}
        >
          <div class="mb-1 flex justify-between gap-3 text-tooltip-muted">
            <span class="nums">{buckets[hover]}</span><span class="nums">{format(stackTotals[hover] ?? 0)}</span>
          </div>
          {#each series as s (s.key || '__other')}
            {#if (s.values[hover] ?? 0) > 0}
              <div class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-[2px]" style="background:{s.color}"></span><span class="truncate">{s.label}</span></span>
                <span class="nums font-medium">{format(s.values[hover] ?? 0)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    <div class="nums mt-2 flex justify-between gap-3 text-[11px] text-ink-3">
      <span>{buckets[0] ?? ''}</span>
      <span>{buckets[n - 1] ?? ''}</span>
    </div>
    <table class="sr-only">
      <caption>{label}</caption>
      <thead><tr><th scope="col"></th>{#each series as s (s.key || '__other')}<th scope="col">{s.label}</th>{/each}</tr></thead>
      <tbody>
        {#each buckets as b, i (b)}
          <tr><th scope="row">{b}</th>{#each series as s (s.key || '__other')}<td>{format(s.values[i] ?? 0)}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

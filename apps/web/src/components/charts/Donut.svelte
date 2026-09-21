<script lang="ts">
  // Hand-rolled SVG donut. Recharts was listed in the original package.json but it
  // is a React component library and cannot render inside Svelte 5 without pulling
  // React back in, so charts are dependency-free local SVG (also keeps the
  // local-first, no-external-asset rule intact).
  let {
    data = [],
    size = 168,
    thickness = 22,
    format = (n: number) => String(n),
  }: {
    data: { label: string; value: number; color?: string }[]
    size?: number
    thickness?: number
    format?: (n: number) => string
  } = $props()

  const palette = ['#4fd1c5', '#7aa2f7', '#f6c453', '#f2777a', '#7fd88f', '#c586c0', '#e5a15c', '#5cc8d6']
  const rows = $derived(data.filter((d) => Number.isFinite(d.value) && d.value > 0))
  const total = $derived(rows.reduce((a, b) => a + b.value, 0))
  const r = $derived((size - thickness) / 2)
  const c = $derived(2 * Math.PI * r)

  const arcs = $derived.by(() => {
    let acc = 0
    return rows.map((d, i) => {
      const frac = total === 0 ? 0 : d.value / total
      const seg = {
        label: d.label,
        value: d.value,
        color: d.color ?? palette[i % palette.length],
        dash: frac * c,
        offset: -acc * c,
        pctv: frac,
      }
      acc += frac
      return seg
    })
  })
</script>

<div class="flex items-center gap-4">
  {#if total === 0}
    <div class="grid place-items-center rounded-full border border-dashed border-line text-xs text-mist-500" style="width:{size}px;height:{size}px">
      no data in range
    </div>
  {:else}
    <svg width={size} height={size} viewBox="0 0 {size} {size}" role="img" aria-label="breakdown donut">
      <g transform="translate({size / 2},{size / 2}) rotate(-90)">
        <circle r={r} fill="none" stroke="var(--color-ink-800)" stroke-width={thickness} />
        {#each arcs as a}
          <circle
            r={r}
            fill="none"
            stroke={a.color}
            stroke-width={thickness}
            stroke-dasharray="{a.dash} {c - a.dash}"
            stroke-dashoffset={a.offset}
          />
        {/each}
      </g>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="fill-mist-100" font-size="15" font-family="var(--font-mono)">
        {format(total)}
      </text>
    </svg>
    <ul class="min-w-0 flex-1 space-y-1 text-xs">
      {#each arcs as a}
        <li class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style="background:{a.color}"></span>
          <span class="truncate text-mist-300" title={a.label}>{a.label}</span>
          <span class="nums ml-auto shrink-0 text-mist-100">{format(a.value)}</span>
          <span class="nums w-10 shrink-0 text-right text-mist-500">{(a.pctv * 100).toFixed(0)}%</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<script lang="ts">
  // Single-series sparkline. One metric per chart on purpose: the overview trend
  // mixes tokens / events / sessions whose scales differ by orders of magnitude,
  // and normalising them onto one axis would imply a comparison that is not real.
  let {
    values = [],
    labels = [],
    color = '#4fd1c5',
    height = 90,
    format = (n: number) => String(n),
  }: {
    values?: number[]
    labels?: string[]
    color?: string
    height?: number
    format?: (n: number) => string
  } = $props()

  const W = 600
  const pad = 6
  const n = $derived(values.length)
  const max = $derived(Math.max(0, ...values))
  const min = $derived(values.length ? Math.min(...values) : 0)

  const pts = $derived.by(() => {
    if (n === 0) return []
    const innerW = W - pad * 2
    const innerH = height - pad * 2
    const stepX = n === 1 ? 0 : innerW / (n - 1)
    return values.map((v, i) => {
      const x = pad + (n === 1 ? innerW / 2 : i * stepX)
      const y = max === min ? pad + innerH / 2 : pad + innerH - ((v - min) / (max - min)) * innerH
      return { x, y, v, label: labels[i] }
    })
  })
  const line = $derived(pts.map((p) => `${p.x},${p.y}`).join(' '))
  const area = $derived(pts.length ? `M ${pts[0].x},${height - pad} L ${pts.map((p) => `${p.x},${p.y}`).join(' L ')} L ${pts[pts.length - 1].x},${height - pad} Z` : '')
</script>

<div class="w-full">
  {#if n === 0}
    <div class="flex h-[90px] items-center justify-center rounded-md border border-dashed border-line text-xs text-mist-500">
      no data in range
    </div>
  {:else}
    <svg viewBox="0 0 {W} {height}" class="w-full" preserveAspectRatio="none" style="height:{height}px" role="img" aria-label="trend">
      <path d={area} fill={color} opacity="0.10" />
      <polyline points={line} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      {#each pts as p (p.x)}
        <circle cx={p.x} cy={p.y} r="1.6" fill={color} />
      {/each}
    </svg>
    <div class="nums mt-1 flex justify-between text-[10px] text-mist-500">
      <span>{labels[0] ?? ''}</span>
      <span>peak {format(max)}</span>
      <span>{labels[labels.length - 1] ?? ''}</span>
    </div>
  {/if}
</div>

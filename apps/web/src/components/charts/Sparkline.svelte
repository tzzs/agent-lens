<script lang="ts">
  // Single-series area chart. One metric per chart on purpose: the overview trend
  // mixes tokens / events / cost whose scales differ by orders of magnitude, and
  // normalising them onto one axis would imply a comparison that is not real.
  // Hover (or arrow keys when focused) reads out the exact bucket value.
  //
  // A bucket may be `null`, which means "unknown", not "zero" (§8 forbids reading an
  // unpriced model as $0). Unknown buckets are gaps: the line breaks, they are excluded
  // from the peak, and the readout says so. Plotting them as 0 would draw the exact
  // falsehood §8 exists to prevent — a day that looks free because we could not price it.
  let {
    values = [],
    labels = [],
    color = 'var(--cat-1)',
    height = 110,
    format = (n: number) => String(n),
    unknown = 'n/a',
    label = 'trend',
  }: {
    values?: (number | null)[]
    labels?: string[]
    color?: string
    height?: number
    format?: (n: number) => string
    unknown?: string
    label?: string
  } = $props()

  const W = 600
  const padY = 8
  const n = $derived(values.length)
  const priced = $derived(values.filter((v): v is number => v !== null))
  const max = $derived(Math.max(0, ...priced))
  const hasGaps = $derived(priced.length !== n)
  const text = (v: number | null) => (v === null ? unknown : format(v))

  const pts = $derived.by(() => {
    if (n === 0) return []
    const innerH = height - padY * 2
    return values.map((v, i) => ({
      x: n === 1 ? W / 2 : (i / (n - 1)) * W,
      // zero-based axis: a flat-but-high series must not look like a flat-zero one
      y: v === null ? null : max === 0 ? height - padY : padY + innerH - (v / max) * innerH,
      v,
      label: labels[i] ?? '',
    }))
  })
  /** Consecutive known runs; a gap ends a run so the polyline never bridges "unknown". */
  const runs = $derived.by(() => {
    const out: { line: string; area: string }[] = []
    let run: number[] = []
    const flush = () => {
      if (run.length === 0) return
      const seg = run.map((i) => `${pts[i]!.x},${pts[i]!.y}`)
      const first = pts[run[0]!]!
      const last = pts[run[run.length - 1]!]!
      out.push({ line: seg.join(' '), area: `M ${first.x},${height} L ${seg.join(' L ')} L ${last.x},${height} Z` })
      run = []
    }
    pts.forEach((p, i) => {
      if (p.y === null) flush()
      else run.push(i)
    })
    flush()
    return out
  })

  let hover = $state<number | null>(null)
  let box: HTMLDivElement | undefined = $state()

  function onMove(e: PointerEvent) {
    if (!box || n === 0) return
    const r = box.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    hover = Math.round(f * (n - 1))
  }
  function onKey(e: KeyboardEvent) {
    if (n === 0) return
    if (e.key === 'ArrowRight') hover = Math.min(n - 1, (hover ?? -1) + 1)
    else if (e.key === 'ArrowLeft') hover = Math.max(0, (hover ?? n) - 1)
    else return
    e.preventDefault()
  }
  const hp = $derived(hover === null ? null : pts[hover] ?? null)
  const gid = `g${Math.random().toString(36).slice(2, 8)}`
</script>

<div class="w-full">
  {#if n === 0}
    <div class="grid place-items-center rounded-lg border border-dashed border-line-strong text-xs text-ink-3" style="height:{height}px">
      No data in range
    </div>
  {:else}
    <div
      bind:this={box}
      class="relative outline-none"
      style="height:{height}px"
      role="slider"
      aria-label="{label} — arrow keys step through points"
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={hover ?? n - 1}
      aria-valuetext={hp ? `${hp.label}: ${text(hp.v)}` : `peak ${priced.length === 0 ? unknown : format(max)}`}
      tabindex="0"
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
      onkeydown={onKey}
      onblur={() => (hover = null)}
    >
      <svg viewBox="0 0 {W} {height}" class="h-full w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.22" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--line)" vector-effect="non-scaling-stroke" />
        {#each runs as r, i (i)}
          <path d={r.area} fill="url(#{gid})" />
          <polyline points={r.line} fill="none" stroke={color} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        {/each}
      </svg>
      {#if hp && hp.y !== null}
        <div class="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style="left:{(hp.x / W) * 100}%"></div>
        <div
          class="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
          style="left:{(hp.x / W) * 100}%;top:{(hp.y / height) * 100}%;background:{color}"
        ></div>
        <div
          class="pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-lg bg-tooltip px-2 py-1 text-xs text-tooltip-fg shadow-overlay"
          style="left:clamp(0px, calc({(hp.x / W) * 100}% - 48px), calc(100% - 110px))"
        >
          <span class="text-tooltip-muted">{hp.label}</span> <span class="nums font-medium">{text(hp.v)}</span>
        </div>
      {:else if hp}
        <div class="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style="left:{(hp.x / W) * 100}%"></div>
        <div
          class="pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-lg bg-tooltip px-2 py-1 text-xs text-tooltip-fg shadow-overlay"
          style="left:clamp(0px, calc({(hp.x / W) * 100}% - 48px), calc(100% - 110px))"
        >
          <span class="text-tooltip-muted">{hp.label}</span> <span class="nums font-medium">{unknown}</span>
        </div>
      {/if}
    </div>
    <div class="nums mt-2 flex justify-between text-[11px] text-ink-3">
      <span>{labels[0] ?? ''}</span>
      <span>{hasGaps ? `${priced.length ? `peak ${format(max)} · ` : ''}${unknown} in ${n - priced.length}` : `peak ${format(max)}`}</span>
      <span>{labels[labels.length - 1] ?? ''}</span>
    </div>
    <table class="sr-only">
      <caption>{label}</caption>
      <tbody>{#each pts as p, i (i)}<tr><th scope="row">{p.label}</th><td>{text(p.v)}</td></tr>{/each}</tbody>
    </table>
  {/if}
</div>

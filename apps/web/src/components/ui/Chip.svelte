<script lang="ts">
  // Beautiful UI "tool chip": a small rounded label. `tone` picks a status colour
  // (soft tint + ink), `color` overrides with any CSS colour (event kinds), and
  // `dashed` marks an absence ("not reported") so it never reads like a zero.
  import type { Snippet } from 'svelte'
  type Tone = 'neutral' | 'accent' | 'green' | 'orange' | 'red'
  let {
    tone = 'neutral',
    color = '',
    dashed = false,
    dot = false,
    mono = false,
    title = '',
    class: cls = '',
    children,
  }: {
    tone?: Tone
    color?: string
    dashed?: boolean
    dot?: boolean
    mono?: boolean
    title?: string
    class?: string
    children: Snippet
  } = $props()

  const tones: Record<Tone, string> = {
    neutral: 'bg-hover-2/70 text-ink-2',
    accent: 'bg-accent-tint text-accent-ink',
    green: 'bg-green-tint text-green',
    orange: 'bg-orange-tint text-orange',
    red: 'bg-red-tint text-red',
  }
  const style = $derived(
    color ? `color:${color};background:color-mix(in oklch, ${color} 14%, transparent)` : '',
  )
</script>

<span
  class="inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium leading-none
    {dashed ? 'border border-dashed border-line-strong bg-transparent text-ink-3' : color ? '' : tones[tone]}
    {mono ? 'nums' : ''} {cls}"
  {style}
  title={title || undefined}
>
  {#if dot}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-current"></span>{/if}
  <span class="truncate">{@render children()}</span>
</span>

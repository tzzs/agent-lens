<script lang="ts">
  // Segmented control (Beautiful UI's Drive / Dots / Orbit switcher): one of N.
  // The selected pill is one element that slides to the chosen option, so a change reads
  // as movement from the old choice to the new one rather than two buttons swapping paint.
  import type { IconName } from './Icon.svelte'
  import Icon from './Icon.svelte'
  type Opt = { value: string; label: string; icon?: IconName }
  let {
    options,
    value = $bindable(''),
    label,
    iconOnly = false,
  }: { options: Opt[]; value?: string; label: string; iconOnly?: boolean } = $props()

  let buttons: HTMLButtonElement[] = $state([])
  let thumb = $state<{ left: number; width: number } | null>(null)
  // Re-measured when the choice, the options or their labels change (a language switch
  // widens "7d" into "7 天"); the first measurement places the pill without sliding.
  let placed = $state(false)
  let box: HTMLDivElement | undefined = $state()
  function measure() {
    const el = buttons[options.findIndex((o) => o.value === value)]
    thumb = el ? { left: el.offsetLeft, width: el.offsetWidth } : null
  }
  $effect(() => {
    void options
    void value
    measure()
    if (!placed) requestAnimationFrame(() => (placed = true))
  })
  // Late web fonts and window resizes change the buttons' widths after the first measure.
  $effect(() => {
    if (!box) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(box)
    void document.fonts?.ready.then(() => measure())
    return () => ro.disconnect()
  })
</script>

<div bind:this={box} class="relative inline-flex rounded-full bg-hover-2/70 p-0.5" role="radiogroup" aria-label={label}>
  {#if thumb}
    <span
      class="pointer-events-none absolute inset-y-0.5 rounded-full bg-surface shadow-btn {placed ? 'transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}"
      style="left:{thumb.left}px;width:{thumb.width}px"
      aria-hidden="true"
    ></span>
  {/if}
  {#each options as o, i (o.value)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="radio"
      aria-checked={value === o.value}
      aria-label={iconOnly ? o.label : undefined}
      title={iconOnly ? o.label : undefined}
      class="press relative inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full text-xs font-medium transition-colors {iconOnly ? 'w-7 justify-center' : 'px-3'}
        {value === o.value ? 'text-ink' : 'text-ink-3 hover:text-ink'} {value === o.value && !thumb ? 'bg-surface shadow-btn' : ''}"
      onclick={() => (value = o.value)}
    >
      {#if o.icon}<Icon name={o.icon} size={14} />{/if}
      {#if !iconOnly}{o.label}{/if}
    </button>
  {/each}
</div>

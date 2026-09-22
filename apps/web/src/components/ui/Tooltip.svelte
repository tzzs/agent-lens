<script lang="ts">
  // Hover/focus tooltip. Positioned `fixed` from the trigger's bounding rect, so it
  // is never clipped by a scrolling ancestor (table headers live inside an
  // overflow-auto wrapper). Opens above, flips below near the top edge, and is
  // clamped to the viewport horizontally. No positioning library.
  import type { Snippet } from 'svelte'
  let { text, children }: { text: string; children: Snippet } = $props()

  let trigger: HTMLSpanElement | undefined = $state()
  let tip: HTMLSpanElement | undefined = $state()
  let open = $state(false)
  let pos = $state({ x: 0, y: 0, below: false })
  let placed = $state(false)

  function show() {
    open = true
    placed = false
    requestAnimationFrame(place)
  }
  function hide() {
    open = false
  }
  function place() {
    if (!trigger || !tip) return
    const r = trigger.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    const below = r.top - h - 8 < 4
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))
    const y = below ? r.bottom + 6 : r.top - h - 6
    pos = { x, y, below }
    placed = true
  }
</script>

<span
  bind:this={trigger}
  class="inline-flex"
  role="presentation"
  onpointerenter={show}
  onpointerleave={hide}
  onfocusin={show}
  onfocusout={hide}
>
  {@render children()}
</span>
{#if open}
  <span
    bind:this={tip}
    role="tooltip"
    class="pointer-events-none fixed z-[60] w-max max-w-72 rounded-lg bg-tooltip px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-tooltip-fg shadow-overlay"
    style="left:{pos.x}px;top:{pos.y}px;visibility:{placed ? 'visible' : 'hidden'}"
  >{text}</span>
{/if}

<script lang="ts">
  // A headline number that counts to its value: from 0 when the card arrives, and from
  // the old value to the new one when live data moves it. Screen readers get the final
  // value only (the moving digits are aria-hidden), and reduced motion jumps straight there.
  import { Tween } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'

  let { value, format }: { value: number; format: (n: number) => string } = $props()

  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const shown = new Tween(0, { duration: reduced ? 0 : 900, easing: cubicOut })
  $effect(() => {
    shown.target = value
  })
  // Integers stay integers mid-flight, so "1,234" never flashes "1,233.6".
  const frame = $derived(Number.isInteger(value) ? Math.round(shown.current) : shown.current)
</script>

<span class="sr-only">{format(value)}</span>
<span aria-hidden="true">{format(frame)}</span>

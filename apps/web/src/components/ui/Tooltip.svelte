<script lang="ts">
  // CSS-only tooltip: shows on hover and on keyboard focus within the trigger.
  // No positioning library; it opens above and is clamped to a readable width.
  import type { Snippet } from 'svelte'
  let { text, align = 'center', children }: { text: string; align?: 'center' | 'start' | 'end'; children: Snippet } = $props()
  const pos = $derived(align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2')
</script>

<span class="group/tt relative inline-flex">
  {@render children()}
  <span
    role="tooltip"
    class="pointer-events-none invisible absolute bottom-full z-50 mb-1.5 w-max max-w-72 rounded-lg bg-tooltip px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-tooltip-fg opacity-0 shadow-overlay transition-opacity duration-100 group-hover/tt:visible group-hover/tt:opacity-100 group-focus-within/tt:visible group-focus-within/tt:opacity-100 {pos}"
  >{text}</span>
</span>

<script lang="ts">
  // Beautiful UI's loading state: a 3×3 pixel grid with a travelling shimmer plus
  // elapsed seconds. Some queries take tens of seconds on a large store; a
  // visible clock tells the user it is working rather than stuck.
  let { label = 'Loading', since = Date.now() }: { label?: string; since?: number } = $props()
  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 100)
    return () => clearInterval(t)
  })
  const elapsed = $derived(Math.max(0, (now - since) / 1000))
  const order = [0, 1, 2, 5, 8, 7, 6, 3, 4]
</script>

<div class="flex items-center gap-2.5 py-10 text-sm text-ink-2" role="status" aria-live="polite">
  <span class="grid grid-cols-3 gap-[2px]" aria-hidden="true">
    {#each order as o, i (i)}
      <span class="pixel h-[5px] w-[5px] rounded-[1px] bg-ink-3" style="animation-delay:{o * 90}ms"></span>
    {/each}
  </span>
  <span class="shimmer">{label}</span>
  <span class="nums text-xs text-ink-3">{elapsed.toFixed(1)}s</span>
</div>

<style>
  .pixel {
    animation: pixel 1.1s ease-in-out infinite;
    opacity: 0.25;
  }
  @keyframes pixel {
    0%, 100% { opacity: 0.25; }
    30% { opacity: 1; }
  }
  .shimmer {
    background: linear-gradient(90deg, var(--ink-2) 0%, var(--ink-2) 40%, var(--ink) 50%, var(--ink-2) 60%, var(--ink-2) 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
  }
</style>

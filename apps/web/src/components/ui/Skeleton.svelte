<script lang="ts">
  let { lines = 3, class: cls = '' }: { lines?: number; class?: string } = $props()
</script>

<div class="space-y-2 {cls}" aria-hidden="true">
  {#each Array(lines) as _, i (i)}
    <div class="h-3 animate-pulse rounded bg-hover-2" style="width:{i === lines - 1 ? 60 : 100 - i * 8}%"></div>
  {/each}
</div>

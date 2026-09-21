<script lang="ts">
  // Shared loading/error surface so every page fails the same honest way: an API
  // error shows the server's kind + message, not a silent empty table. Loading
  // shows elapsed time, because some cube queries take tens of seconds.
  import Loading from './ui/Loading.svelte'
  import Icon from './ui/Icon.svelte'

  let {
    status,
    error = null,
    kind = null,
    since = Date.now(),
    loadingText = 'Loading',
  }: { status: string; error?: string | null; kind?: string | null; since?: number; loadingText?: string } = $props()
</script>

{#if status === 'loading'}
  <Loading label={loadingText} {since} />
{:else if status === 'error'}
  <div class="my-4 flex gap-3 rounded-card bg-surface p-4 text-sm shadow-card" role="alert">
    <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-red-tint text-red"><Icon name="alert" size={14} /></span>
    <div class="min-w-0">
      <div class="font-semibold text-ink">Request failed{#if kind}<span class="ml-1.5 font-normal text-ink-3">· {kind}</span>{/if}</div>
      <p class="nums mt-1 break-words text-xs text-ink-2">{error}</p>
    </div>
  </div>
{/if}

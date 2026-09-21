<script lang="ts">
  // Shared loading/error surface so every page fails the same honest way: an API
  // error shows the server's kind + message, not a silent empty table.
  let {
    status,
    error = null,
    kind = null,
    loadingText = 'loading…',
  }: { status: string; error?: string | null; kind?: string | null; loadingText?: string } = $props()
</script>

{#if status === 'loading'}
  <div class="flex items-center gap-2 py-10 text-sm text-mist-400">
    <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-signal"></span>
    {loadingText}
  </div>
{:else if status === 'error'}
  <div class="my-4 rounded-md border border-danger/40 bg-danger/5 p-4 text-sm">
    <div class="font-semibold text-danger">request failed{kind ? ` · ${kind}` : ''}</div>
    <p class="nums mt-1 break-words text-mist-300">{error}</p>
  </div>
{/if}

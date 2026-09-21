<script lang="ts">
  // Monospace block with a copy button (Beautiful UI code block). Used for payload
  // text, metadata JSON and the server's `explain` basis strings.
  import Icon from './Icon.svelte'
  let {
    text,
    label = '',
    maxHeight = 288,
    wrap = true,
  }: { text: string; label?: string; maxHeight?: number; wrap?: boolean } = $props()

  let copied = $state(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      copied = true
      setTimeout(() => (copied = false), 1200)
    } catch {
      /* clipboard can be denied outside a secure context; the text stays selectable */
    }
  }
</script>

<div class="group relative overflow-hidden rounded-[10px] bg-inset ring-1 ring-line">
  {#if label}
    <div class="border-b border-line px-3 py-1.5 text-[11px] font-medium text-ink-3">{label}</div>
  {/if}
  <button
    type="button"
    class="absolute right-1.5 {label ? 'top-1' : 'top-1.5'} grid h-6 w-6 place-items-center rounded-md text-ink-3 opacity-0 transition hover:bg-hover-2 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
    onclick={copy}
    aria-label={copied ? 'Copied' : 'Copy'}
  >
    <Icon name={copied ? 'check' : 'copy'} size={13} />
  </button>
  <pre
    class="nums overflow-auto px-3 py-2 pr-9 text-xs leading-relaxed text-ink-2 {wrap ? 'whitespace-pre-wrap break-words' : ''}"
    style="max-height:{maxHeight}px">{text}</pre>
</div>

<script lang="ts">
  // One content-layer payload rendered inside a timeline node. The server caps a
  // payload at 20k chars and flags `truncated`; we surface that rather than
  // silently showing a partial blob as if complete.
  import { formatInt } from '../lib/format.ts'

  let { p }: { p: any } = $props()

  const kindColor: Record<string, string> = {
    user_message: '#7aa2f7',
    assistant_message: '#4fd1c5',
    tool_input: '#c586c0',
    tool_output: '#e5a15c',
    reasoning: '#8f9bff',
  }
  const color = $derived(kindColor[p.kind] ?? '#6b7385')
  let collapsed = $state(true)
</script>

<div class="rounded-md border border-line bg-ink-900">
  <button class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px]" onclick={() => (collapsed = !collapsed)}>
    <span class="font-medium uppercase tracking-wide" style="color:{color}">{p.kind}</span>
    {#if p.role}<span class="text-mist-500">{p.role}</span>{/if}
    {#if p.bytes != null}<span class="nums ml-auto text-mist-500">{formatInt(p.bytes)}B</span>{/if}
    {#if p.truncated}<span class="rounded bg-warn/15 px-1 py-0.5 text-[9px] text-warn">truncated</span>{/if}
  </button>
  {#if !collapsed}
    <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-2 text-[11px] leading-relaxed text-mist-200">{p.text}</pre>
  {/if}
</div>

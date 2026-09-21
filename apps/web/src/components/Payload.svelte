<script lang="ts">
  // One content-layer payload inside the inspector. The server caps a payload at
  // 20k chars and flags `truncated`; we surface that rather than silently showing
  // a partial blob as if complete.
  import type { PayloadView } from '../lib/api.ts'
  import { payloadColor } from '../lib/eventKinds.ts'
  import { formatInt } from '../lib/format.ts'
  import CodeBlock from './ui/CodeBlock.svelte'
  import Chip from './ui/Chip.svelte'
  import Icon from './ui/Icon.svelte'

  let { p }: { p: PayloadView } = $props()
  let open = $state(false)
</script>

<div class="rounded-[10px] ring-1 ring-line">
  <button type="button" class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs" aria-expanded={open} onclick={() => (open = !open)}>
    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} class="text-ink-3" />
    <Chip color={payloadColor(p.kind)}>{p.kind.replace('_', ' ')}</Chip>
    {#if p.role}<span class="text-ink-3">{p.role}</span>{/if}
    <span class="ml-auto flex items-center gap-1.5">
      {#if p.truncated}<Chip tone="orange" title="Stored text was capped at 20k characters">truncated</Chip>{/if}
      {#if p.bytes != null}<span class="nums text-ink-3">{formatInt(p.bytes)} B</span>{/if}
    </span>
  </button>
  {#if open}
    <div class="px-2 pb-2"><CodeBlock text={p.text} maxHeight={320} /></div>
  {/if}
</div>

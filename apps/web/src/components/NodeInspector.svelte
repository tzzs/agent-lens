<script lang="ts">
  // Detail for the selected waterfall event (Beautiful UI inspector card): the
  // metric facts first, then content-layer payloads and raw metadata. Keeping
  // detail out of the list is what lets the list use fixed-height rows.
  import type { TimelineNode } from '../lib/api.ts'
  import { eventKind } from '../lib/eventKinds.ts'
  import { formatCompact, formatDateTime, formatMs } from '../lib/format.ts'
  import Payload from './Payload.svelte'
  import CodeBlock from './ui/CodeBlock.svelte'
  import Chip from './ui/Chip.svelte'
  import Icon from './ui/Icon.svelte'

  let { node, contentAvailable, onClose }: { node: TimelineNode; contentAvailable: boolean; onClose: () => void } = $props()

  const kind = $derived(eventKind(node.type))
  const usage = $derived(
    node.usage
      ? [
          ['Input', node.usage.inputTokens],
          ['Output', node.usage.outputTokens],
          ['Cache read', node.usage.cacheReadTokens],
          ['Cache write', node.usage.cacheWriteTokens],
          ['Reasoning', node.usage.reasoningTokens],
        ]
      : [],
  )
  const facts = $derived(
    [
      ['Type', node.type],
      ['Time', formatDateTime(node.timestamp)],
      ['Duration', node.durationMs != null ? formatMs(node.durationMs) : null],
      ['Status', node.status],
      ['Model', node.model ? `${node.model.name}${node.model.provider ? ` · ${node.model.provider}` : ''}` : null],
      ['Capability', node.capability ? `${node.capability.type} · ${node.capability.name}` : null],
      ['Provider', node.capability?.provider ?? null],
      ['Request', node.requestId],
      ['Usage source', node.usageSource],
      ['Error', node.errorFingerprint],
      ['Event id', node.id],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '') as [string, string][],
  )
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-line-soft px-4 py-3">
    <Chip color={kind.color}>{kind.label}</Chip>
    <h2 class="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{node.capability?.name ?? node.subtype ?? node.type}</h2>
    <button type="button" class="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-hover-2 hover:text-ink" onclick={onClose} aria-label="Close details">
      <Icon name="x" size={14} />
    </button>
  </div>

  <div class="flex-1 space-y-4 overflow-y-auto p-4">
    <dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-xs">
      {#each facts as [k, v] (k)}
        <dt class="text-ink-3">{k}</dt>
        <dd class="nums min-w-0 break-all {k === 'Error' || (k === 'Status' && v === 'error') ? 'text-red' : 'text-ink-2'}">{v}</dd>
      {/each}
    </dl>

    {#if usage.length}
      <div>
        <h3 class="mb-1.5 text-xs font-medium text-ink-3">Tokens</h3>
        <div class="grid grid-cols-3 gap-1.5">
          {#each usage as [k, v] (k)}
            <div class="rounded-lg bg-inset px-2 py-1.5 ring-1 ring-line-soft">
              <div class="text-[11px] text-ink-3">{k}</div>
              <div class="nums text-[13px] {v ? 'text-ink' : 'text-ink-3'}">{formatCompact(Number(v))}</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if contentAvailable && node.payloads.length}
      <div class="space-y-2">
        <h3 class="text-xs font-medium text-ink-3">Content</h3>
        {#each node.payloads as p, i (i)}<Payload {p} />{/each}
      </div>
    {:else if !contentAvailable}
      <p class="rounded-lg bg-inset px-3 py-2 text-xs text-ink-3 ring-1 ring-line-soft">Content layer is off — metrics only for this event.</p>
    {/if}

    {#if node.metadata}
      <CodeBlock label="Metadata" text={JSON.stringify(node.metadata, null, 2)} maxHeight={260} />
    {/if}
  </div>
</div>

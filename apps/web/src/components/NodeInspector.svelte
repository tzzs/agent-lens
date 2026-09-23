<script lang="ts">
  // Detail for the selected waterfall event (Beautiful UI inspector card): the
  // metric facts first, then content-layer payloads and raw metadata. Keeping
  // detail out of the list is what lets the list use fixed-height rows.
  import type { PayloadView, TimelineNode } from '../lib/api.ts'
  import { eventKind } from '../lib/eventKinds.ts'
  import { formatCompact, formatDateTime, formatMs } from '../lib/format.ts'
  import { t } from '../lib/lang.js'
  import Payload from './Payload.svelte'
  import CodeBlock from './ui/CodeBlock.svelte'
  import Chip from './ui/Chip.svelte'
  import Icon from './ui/Icon.svelte'

  /**
   * `payloads` arrives separately from `node`: the timeline is fetched without content text
   * and the page loads it here when a row is opened. Undefined means "not fetched yet",
   * an empty array means "this node genuinely has no content".
   */
  let {
    node,
    contentAvailable,
    payloads,
    loadingPayloads = false,
    onClose,
  }: {
    node: TimelineNode
    contentAvailable: boolean
    payloads?: PayloadView[]
    loadingPayloads?: boolean
    onClose: () => void
  } = $props()

  const kind = $derived(eventKind(node.type))
  const usage = $derived(
    node.usage
      ? [
          [$t('viz.tokenInput'), node.usage.inputTokens],
          [$t('viz.tokenOutput'), node.usage.outputTokens],
          [$t('viz.tokenCacheRead'), node.usage.cacheReadTokens],
          [$t('viz.tokenCacheWrite'), node.usage.cacheWriteTokens],
          [$t('viz.tokenReasoning'), node.usage.reasoningTokens],
        ]
      : [],
  )
  // The labels translate; the values stay exactly what the server sent (an event
  // type, a status, an id). The third slot is a stable row id, so the red error
  // styling keys off what a row *means* and not off a label that changes language.
  const facts = $derived(
    [
      [$t('viz.fieldType'), node.type, 'type'],
      [$t('viz.fieldTime'), formatDateTime(node.timestamp), 'time'],
      [$t('viz.fieldDuration'), node.durationMs != null ? formatMs(node.durationMs) : null, 'duration'],
      [$t('viz.fieldStatus'), node.status, 'status'],
      [$t('viz.fieldModel'), node.model ? `${node.model.name}${node.model.provider ? ` · ${node.model.provider}` : ''}` : null, 'model'],
      [$t('viz.fieldCapability'), node.capability ? `${node.capability.type} · ${node.capability.name}` : null, 'capability'],
      [$t('viz.fieldProvider'), node.capability?.provider ?? null, 'provider'],
      [$t('viz.fieldRequest'), node.requestId, 'request'],
      [$t('viz.fieldUsageSource'), node.usageSource, 'usage-source'],
      [$t('viz.fieldError'), node.errorFingerprint, 'error'],
      [$t('viz.fieldEventId'), node.id, 'event-id'],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '') as [string, string, string][],
  )
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-line-soft px-4 py-3">
    <Chip color={kind.color}>{kind.label}</Chip>
    <h2 class="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{node.capability?.name ?? node.subtype ?? node.type}</h2>
    <button type="button" class="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-hover-2 hover:text-ink" onclick={onClose} aria-label={$t('viz.closeDetails')}>
      <Icon name="x" size={14} />
    </button>
  </div>

  <div class="flex-1 space-y-4 overflow-y-auto p-4">
    <dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-xs">
      {#each facts as [k, v, id] (id)}
        <dt class="text-ink-3">{k}</dt>
        <dd class="nums min-w-0 break-all {id === 'error' || (id === 'status' && v === 'error') ? 'text-red' : 'text-ink-2'}">{v}</dd>
      {/each}
    </dl>

    {#if usage.length}
      <div>
        <h3 class="mb-1.5 text-xs font-medium text-ink-3">{$t('viz.tokensHeading')}</h3>
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

    {#if !contentAvailable}
      <p class="rounded-lg bg-inset px-3 py-2 text-xs text-ink-3 ring-1 ring-line-soft">{$t('viz.contentOff')}</p>
    {:else if payloads === undefined}
      <p class="rounded-lg bg-inset px-3 py-2 text-xs text-ink-3 ring-1 ring-line-soft">
        {loadingPayloads || node.payloadCount ? $t('viz.loadingContent') : $t('viz.noContentLogged')}
      </p>
    {:else if payloads.length}
      <div class="space-y-2">
        <h3 class="text-xs font-medium text-ink-3">{$t('viz.contentHeading')}</h3>
        {#each payloads as p, i (i)}<Payload {p} />{/each}
      </div>
    {:else}
      <p class="rounded-lg bg-inset px-3 py-2 text-xs text-ink-3 ring-1 ring-line-soft">{$t('viz.noContentLogged')}</p>
    {/if}

    {#if node.metadata}
      <CodeBlock label={$t('viz.metadataLabel')} text={JSON.stringify(node.metadata, null, 2)} maxHeight={260} />
    {/if}
  </div>
</div>

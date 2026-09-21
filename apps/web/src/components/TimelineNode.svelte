<script lang="ts">
  // One waterfall node. Recursive: it renders its children (resolved through the
  // parentEventId map the page built) indented one level. This is the §10
  // priority-2 differentiator — message/tool/skill/mcp/hook/subagent/compact in
  // the source's own raw_seq order, nested by parent_event_id.
  import { formatCompact, formatMs, formatClock } from '../lib/format.ts'
  import Payload from './Payload.svelte'
  import TimelineNode from './TimelineNode.svelte'

  let {
    node,
    childrenMap,
    depth = 0,
    contentAvailable,
  }: { node: any; childrenMap: Map<string, any[]>; depth?: number; contentAvailable: boolean } = $props()

  let open = $state(false)
  const children = $derived(childrenMap.get(node.id) ?? [])

  const meta = $derived(
    (function (t: string) {
      if (t.startsWith('message.user')) return { c: '#7aa2f7', label: 'user' }
      if (t.startsWith('message.assistant')) return { c: '#4fd1c5', label: 'assistant' }
      if (t.startsWith('tool')) return { c: '#c586c0', label: t.replace('tool.', '') }
      if (t.startsWith('skill')) return { c: '#e5a15c', label: 'skill' }
      if (t.startsWith('mcp')) return { c: '#5cc8d6', label: 'mcp' }
      if (t.startsWith('plugin')) return { c: '#b48ead', label: 'plugin' }
      if (t.startsWith('connector')) return { c: '#88c0d0', label: 'connector' }
      if (t.startsWith('command')) return { c: '#ebcb8b', label: 'command' }
      if (t.startsWith('subagent')) return { c: '#a3be8c', label: 'subagent' }
      if (t.startsWith('hook')) return { c: '#f6c453', label: 'hook' }
      if (t.startsWith('generation')) return { c: '#8f9bff', label: 'gen' }
      if (t.startsWith('context.compact')) return { c: '#f2777a', label: 'compact' }
      if (t.startsWith('error')) return { c: '#f2777a', label: 'error' }
      if (t.startsWith('session')) return { c: '#6b7385', label: t.replace('session.', '') }
      return { c: '#6b7385', label: t || 'event' }
    })(node.type ?? ''),
  )

  const tokens = $derived(
    node.usage
      ? node.usage.inputTokens + node.usage.outputTokens + node.usage.cacheReadTokens + node.usage.cacheWriteTokens + node.usage.reasoningTokens
      : 0,
  )
  const hasDetail = $derived(
    (contentAvailable && node.payloads && node.payloads.length > 0) ||
      node.metadata ||
      node.usage ||
      node.errorFingerprint ||
      (node.usageSource && node.usageSource !== 'missing'),
  )
  const errored = $derived(node.status === 'error')
</script>

<div class="border-l-2" style="border-left-color:{depth > 0 ? 'var(--color-ink-700)' : 'transparent'};padding-left:{depth > 0 ? 14 : 0}px">
  <div class="flex items-start gap-2 py-1">
    <button
      class="mt-1 h-4 w-4 shrink-0 text-mist-500 {hasDetail ? 'cursor-pointer' : 'cursor-default'}"
      onclick={() => (open = !open)}
      disabled={!hasDetail}
      aria-label="toggle detail"
    >
      {#if hasDetail}{open ? '▾' : '▸'}{:else}<span class="text-ink-600">·</span>{/if}
    </button>

    <span
      class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style="color:{meta.c};background:{meta.c}22"
    >{meta.label}</span>

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        {#if node.capability}
          <span class="nums text-mist-100">{node.capability.name}</span>
          {#if node.capability.provider}<span class="text-[10px] text-mist-500">← {node.capability.provider}</span>{/if}
        {/if}
        {#if node.subtype}<span class="text-[10px] text-mist-500">{node.subtype}</span>{/if}
        {#if node.model}<span class="text-[10px] text-mist-500">· {node.model.name}</span>{/if}
        {#if !node.capability && !node.subtype && !node.model}
          <span class="text-mist-400">{node.type}</span>
        {/if}
      </div>
    </div>

    <div class="nums flex shrink-0 items-center gap-2 text-[11px]">
      {#if node.durationMs != null}<span class="text-mist-400">{formatMs(node.durationMs)}</span>{/if}
      {#if tokens > 0}<span class="text-mist-400">{formatCompact(tokens)}t</span>{/if}
      {#if errored}<span class="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">error</span>{/if}
      <span class="w-16 text-right text-mist-500">{formatClock(node.timestamp)}</span>
    </div>
  </div>

  {#if open && hasDetail}
    <div class="mb-2 ml-6 space-y-2 rounded-md border border-line bg-ink-950/50 p-3">
      <div class="nums flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mist-400">
        <span>type <span class="text-mist-100">{node.type}</span></span>
        {#if node.requestId}<span>request <span class="text-mist-100">{node.requestId}</span></span>{/if}
        {#if node.usage}
          <span>in {formatCompact(node.usage.inputTokens)}</span>
          <span>out {formatCompact(node.usage.outputTokens)}</span>
          <span>cache r {formatCompact(node.usage.cacheReadTokens)}</span>
          <span>cache w {formatCompact(node.usage.cacheWriteTokens)}</span>
          <span>reason {formatCompact(node.usage.reasoningTokens)}</span>
        {/if}
        <span>usage {node.usageSource}</span>
        <span>status {node.status}</span>
        {#if node.errorFingerprint}<span class="text-danger">err {node.errorFingerprint}</span>{/if}
      </div>

      {#if contentAvailable && node.payloads && node.payloads.length}
        {#each node.payloads as p (p.kind + (p.role ?? '') + p.text.slice(0, 8))}
          <Payload {p} />
        {/each}
      {:else if node.payloads && node.payloads.length === 0 && !contentAvailable}
        <p class="text-[11px] text-mist-500">content layer off — metrics only for this node.</p>
      {/if}

      {#if node.metadata}
        <details class="text-[11px]">
          <summary class="cursor-pointer text-mist-500">metadata</summary>
          <pre class="nums mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[10px] text-mist-400">{JSON.stringify(node.metadata, null, 2)}</pre>
        </details>
      {/if}
    </div>
  {/if}

  {#each children as child (child.id)}
    <TimelineNode node={child} {childrenMap} depth={depth + 1} {contentAvailable} />
  {/each}
</div>

<script lang="ts">
  // GET /api/sessions/:id — the waterfall, the product's differentiator (§10
  // priority 2). The parent_event_id forest is built once and flattened to the
  // *visible* rows only, then windowed by VirtualList, so a 13k-event session stays
  // instant. Detail opens in a side inspector. Degrades honestly to a metrics-only
  // timeline when the content layer is off, and surfaces 404 / 409 verbatim.
  import { api, type PayloadView, type TimelineNode } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { contentNote } from '../lib/notes.ts'
  import { t } from '../lib/lang.js'
  import { activeMetricInfo, formatCompact, formatInt, formatMs, formatDateTime, projectLabel, shortId } from '../lib/format.ts'
  import { eventGroups, eventKind, type EventGroup } from '../lib/eventKinds.ts'
  import { buildForest, parentIds, sessionSpan, visibleRows } from '../lib/timeline.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import FilterChips from '../components/ui/FilterChips.svelte'
  import VirtualList from '../components/ui/VirtualList.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'
  import TimelineRow from '../components/TimelineRow.svelte'
  import NodeInspector from '../components/NodeInspector.svelte'

  let { id }: { id: string } = $props()

  // `payloads=0`: the waterfall needs every node's metric facts (it builds the parent forest,
  // the span axis and the kind counts from them) but needs text for the one node the
  // inspector has open. Asking for the rest cost a 48 MB body and ~135k inflates per visit.
  const q = loader(() => api.session(id, { payloads: 0 }))
  $effect(() => {
    void id
    void live.lastTick
    q.run()
  })

  const d = $derived(q.state.data)
  const forest = $derived(d ? buildForest(d.nodes) : null)
  const span = $derived(d ? sessionSpan(d.nodes, d.session.firstTimestamp, d.session.lastTimestamp) : null)

  let expanded = $state<Set<string>>(new Set())
  let groups = $state<string[]>([])
  let search = $state('')
  let selectedId = $state<string | null>(null)

  const groupCounts = $derived.by(() => {
    const m = new Map<EventGroup, number>()
    for (const n of d?.nodes ?? []) {
      const g = eventKind(n.type).group
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  })
  const groupOpts = $derived(
    eventGroups().filter((g) => groupCounts.has(g.key)).map((g) => ({ key: g.key, label: g.label, count: groupCounts.get(g.key) })),
  )

  const matcher = $derived.by(() => {
    const needle = search.trim().toLowerCase()
    if (!groups.length && !needle) return undefined
    return (n: TimelineNode) =>
      (!groups.length || groups.includes(eventKind(n.type).group)) &&
      (!needle ||
        [n.type, n.subtype ?? '', n.capability?.name ?? '', n.model?.name ?? '', n.id].some((s) => s.toLowerCase().includes(needle)))
  })
  const rows = $derived(d && forest ? visibleRows(forest, d.nodes, expanded, matcher) : [])
  const selected = $derived(selectedId && d ? (d.nodes.find((n) => n.id === selectedId) ?? null) : null)

  // Payload text arrives per node, on open, and is kept across re-selections so scrolling
  // back into a row does not refetch it.
  let textById = $state<Record<string, PayloadView[]>>({})
  let loadingId: string | null = $state(null)
  /** Bumped per fetch so a slow response cannot paint a node the user has since left. */
  let loadSeq = 0
  async function loadPayloads(nodeId: string, attempt: number) {
    try {
      const r = await api.nodePayloads(id, nodeId)
      // A re-selection mid-flight must not write a stale node's text under the new one.
      if (attempt !== loadSeq) return
      textById = { ...textById, [nodeId]: r.payloads[nodeId] ?? [] }
    } catch {
      if (attempt !== loadSeq) return
      // A failed fetch leaves the row's metric facts intact; the inspector says it has no
      // text rather than pretending the content layer is empty.
      textById = { ...textById, [nodeId]: [] }
    } finally {
      if (attempt === loadSeq) loadingId = null
    }
  }
  $effect(() => {
    const n = selected
    if (!n || !n.payloadCount || textById[n.id] || loadingId === n.id) return
    loadingId = n.id
    loadPayloads(n.id, ++loadSeq)
  })

  function toggle(nodeId: string) {
    const next = new Set(expanded)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    expanded = next
  }
  const expandable = $derived(forest ? forest.children.size : 0)

  let list: VirtualList<(typeof rows)[number]> | undefined = $state()
  function onListKey(e: KeyboardEvent) {
    if (!rows.length) return
    const i = rows.findIndex((r) => r.node.id === selectedId)
    let next = i
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, i === -1 ? 0 : i - 1)
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0 && rows[i]!.childCount) {
      const open = expanded.has(rows[i]!.node.id)
      if ((e.key === 'ArrowRight') !== open) toggle(rows[i]!.node.id)
      e.preventDefault()
      return
    } else if (e.key === 'Escape') {
      selectedId = null
      return
    } else return
    e.preventDefault()
    selectedId = rows[next]!.node.id
    list?.scrollToIndex(next)
  }

  const axis = $derived(span ? [0, 0.5, 1].map((f) => formatMs(f * (span.end - span.start))) : [])
  let copied = $state(false)
  async function copyId() {
    try {
      await navigator.clipboard.writeText(d!.session.id)
      copied = true
      setTimeout(() => (copied = false), 1200)
    } catch { /* id stays visible in the title attribute */ }
  }
</script>

{#if q.state.status === 'error' && !d}
  <PageHeader title={$t('sessionDetail.unavailable')} back={{ href: '#/sessions', label: $t('sessionDetail.backSessions') }} />
  <Surface>
    <p class="text-sm text-ink-2">{q.state.error}</p>
    {#if q.state.kind === 'conflict' && q.state.details?.matches}
      <p class="mt-3 text-xs text-ink-3">{$t('sessionDetail.ambiguousMatches')}</p>
      <ul class="nums mt-2 space-y-1 text-[13px]">
        {#each q.state.details.matches as m (m)}
          <li><a class="text-accent hover:underline" href="#/sessions/{encodeURIComponent(m)}">{m}</a></li>
        {/each}
      </ul>
    {:else if q.state.kind === 'not_found'}
      <p class="mt-2 text-xs text-ink-3">{$t('sessionDetail.notFoundLead')} <span class="nums">{id}</span>{$t('sessionDetail.notFoundTail')}</p>
    {/if}
  </Surface>
{:else if !d}
  <PageHeader title={$t('sessionDetail.title')} back={{ href: '#/sessions', label: $t('sessionDetail.backSessions') }} />
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('sessionDetail.loadingTimeline')} />
{:else}
  <PageHeader
    title={d.session.title || $t('sessionDetail.untitled', { values: { agent: d.session.agentId } })}
    back={{ href: '#/sessions', label: $t('sessionDetail.backSessions') }}
    refreshing={q.state.refreshing}
  >
    {#snippet actions()}
      <button
        type="button"
        class="nums inline-flex h-7 items-center gap-1.5 rounded-full bg-surface px-3 text-xs text-ink-2 shadow-btn hover:bg-hover"
        title={$t('sessionDetail.copyIdTitle', { values: { id: d.session.id } })}
        onclick={copyId}
      >
        {shortId(d.session.id, 12)}<Icon name={copied ? 'check' : 'copy'} size={12} />
      </button>
    {/snippet}
  </PageHeader>

  <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
    {#each [
      [$t('sessionDetail.tileAgent'), `${d.session.agentId} · ${d.session.hostId}`, null],
      [$t('sessionDetail.tileProject'), projectLabel(d.session.project), d.session.project ?? ''],
      [$t('sessionDetail.tileStarted'), formatDateTime(d.session.firstTimestamp).slice(0, 16), null],
      [$t('sessionDetail.tileEvents'), formatInt(d.session.eventCount), null],
      [$t('sessionDetail.tileTokens'), formatCompact(Number(d.totals.tokens_total ?? 0)), null],
      // The metric is machine time; the wall clock it gets mistaken for is one hover away.
      [$t('sessionDetail.tileActive'), formatMs(Number(d.totals.duration ?? 0)),
        span === null ? activeMetricInfo() : $t('sessionDetail.activeWithSpan', { values: { metric: activeMetricInfo(), span: formatMs(span.end - span.start) } })],
    ] as [k, v, hint] (k)}
      <div class="min-w-0 rounded-[10px] bg-surface px-3 py-2 shadow-card">
        <div class="text-xs text-ink-3">{k}</div>
        <div class="nums truncate text-[13px] text-ink" title={hint ?? v}>{v}</div>
      </div>
    {/each}
  </div>

  {#if !d.contentAvailable}
    <div class="mb-4"><Alert tone="orange" title={$t('sessionDetail.metricsOnly')}>{contentNote(d.contentNoteCode)}</Alert></div>
  {/if}

  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <FilterChips label={$t('sessionDetail.filterByKind')} options={groupOpts} bind:selected={groups} multiple allLabel={$t('sessionDetail.allEvents')} />
    <div class="flex items-center gap-2">
      <label class="relative flex items-center">
        <span class="sr-only">{$t('sessionDetail.searchAria')}</span>
        <Icon name="search" size={14} class="pointer-events-none absolute left-2.5 text-ink-3" />
        <input
          type="search"
          bind:value={search}
          placeholder={$t('sessionDetail.searchPlaceholder')}
          class="h-8 w-56 max-w-full rounded-full bg-surface pl-8 pr-3 text-[13px] text-ink shadow-btn outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>
      {#if expandable && !matcher}
        <button
          type="button"
          class="h-8 whitespace-nowrap rounded-full bg-surface px-3 text-xs font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink"
          onclick={() => (expanded = expanded.size ? new Set() : parentIds(forest!))}
        >{expanded.size ? $t('sessionDetail.collapseAll') : $t('sessionDetail.expandAll')}</button>
      {/if}
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 {selected ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : ''}">
    <Surface padded={false}>
      <div class="tl-grid items-center border-b border-line px-3 py-2 text-xs font-medium text-ink-3">
        <span>{$t('sessionDetail.colEvent')} <span class="font-normal">{$t('sessionDetail.shownOf', { values: { n: formatInt(rows.length) } })}</span></span>
        <span class="tl-track nums flex justify-between font-normal">{#each axis as a, i (i)}<span>{a}</span>{/each}</span>
        <span class="text-right">{$t('sessionDetail.colDur')}</span>
        <span class="tl-tokens text-right">{$t('sessionDetail.colTokens')}</span>
        <span class="text-right">{$t('sessionDetail.colTime')}</span>
      </div>
      {#if rows.length === 0}
        <p class="py-12 text-center text-sm text-ink-3">{d.nodes.length ? $t('sessionDetail.noMatch') : $t('sessionDetail.noEvents')}</p>
      {:else}
        <VirtualList
          bind:this={list}
          items={rows}
          itemHeight={36}
          height="min(70vh, {Math.max(1, rows.length) * 36}px)"
          key={(r) => r.node.id}
          label={$t('sessionDetail.listAria')}
          role="tree"
          itemAttrs={(r) => ({ 'aria-level': r.depth + 1, 'aria-selected': r.node.id === selectedId, 'aria-expanded': r.childCount && !matcher ? expanded.has(r.node.id) : undefined })}
          onkeydown={onListKey}
        >
          {#snippet row(r)}
            <TimelineRow
              node={r.node}
              depth={r.depth}
              childCount={matcher ? 0 : r.childCount}
              expanded={expanded.has(r.node.id)}
              selected={r.node.id === selectedId}
              {span}
              onToggle={() => toggle(r.node.id)}
              onSelect={() => (selectedId = selectedId === r.node.id ? null : r.node.id)}
            />
          {/snippet}
        </VirtualList>
      {/if}
    </Surface>

    {#if selected}
      <aside class="xl:sticky xl:top-20 xl:h-[min(78vh,760px)]">
        <Surface padded={false} class="h-full overflow-hidden">
          <NodeInspector
            node={selected}
            contentAvailable={d.contentAvailable}
            payloads={textById[selected.id]}
            loadingPayloads={loadingId === selected.id}
            onClose={() => (selectedId = null)}
          />
        </Surface>
      </aside>
    {/if}
  </div>

  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
    <span class="flex items-center gap-1.5">{$t('sessionDetail.estCost')} <CostFigure value={d.totals.cost_api_equiv ?? null} basis="est" /> {$t('sessionDetail.keysHint')}</span>
    {#if forest && forest.orphans > 0}
      <span title={$t('sessionDetail.orphansTitle')}>
        {$t('sessionDetail.orphansNote', { values: { n: formatInt(forest.orphans) } })}
      </span>
    {/if}
  </div>
  <details class="mt-2 text-xs text-ink-3">
    <summary class="cursor-pointer hover:text-ink-2">{$t('sessionDetail.explainSummary')}</summary>
    <p class="nums mt-1.5 break-words">{d.explain}</p>
  </details>
{/if}

<script lang="ts">
  import { agentLabel, hostLabel } from '../lib/names.js'
  import { untrack } from 'svelte'
  import { api, type SessionRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams, rangeKey } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { route, setQuery } from '../lib/router.svelte.js'
  import { listOf } from '../lib/hashquery.ts'
  import { activeMetricInfo, formatCompact, formatInt, formatMs, relativeTime, projectLabel, shortId, spanMs } from '../lib/format.ts'
  import { SERIES } from '../lib/eventKinds.ts'
  import { t } from '../lib/lang.js'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable from '../components/ui/DataTable.svelte'
  import FilterChips from '../components/ui/FilterChips.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  // The chip selection, the search box and a model narrowing live in the hash
  // (`?agents=a,b&q=…&model=…&provider=…`), so a link from another page can arrive
  // pre-filtered and a refresh keeps the view. They are this page's own narrowing on
  // top of the header's global filter, never a change to it.
  let agentSel = $state<string[]>(listOf(route.query.agents))
  let search = $state(route.query.q ?? '')
  let model = $state(route.query.model ?? '')
  let provider = $state(route.query.provider ?? '')
  const onPage = () => route.path === '/sessions'
  // Hash -> state only on a hash change (Back, a link): the local values are read
  // untracked, or a chip click would be undone before it reached the hash.
  $effect(() => {
    if (!onPage()) return
    const fromUrl = listOf(route.query.agents)
    const q = route.query.q ?? ''
    const m = route.query.model ?? ''
    const p = route.query.provider ?? ''
    untrack(() => {
      if (fromUrl.join(',') !== agentSel.join(',')) agentSel = fromUrl
      if (q !== search.trim()) search = q
      if (m !== model) model = m
      if (p !== provider) provider = p
    })
  })
  // Guarded by the path: on the way to a session's page this component's last effects
  // would otherwise strip that page's own `q` from the new hash.
  $effect(() => {
    const patch = { agents: agentSel.join(','), q: search.trim(), model, provider }
    if (untrack(onPage)) setQuery(patch)
  })

  // The agent chips narrow on the server, so an agent whose sessions are older than the
  // loaded page is still found. Against a global agent the narrowing intersects: picking
  // another agent there honestly matches nothing rather than overriding the header.
  const agentParam = $derived.by(() => {
    if (!agentSel.length) return range.agent || undefined
    const sel = range.agent ? agentSel.filter((a) => a === range.agent) : agentSel
    return sel.length ? sel.join(',') : null
  })

  // Grows by PAGE on "Load more". The growth is pinned to the filter it was asked
  // under, so changing the window or a narrowing drops back to one page in the same
  // tick (one fetch, not a long tail the narrowed view no longer needs).
  const PAGE = 100
  const filterKey = $derived(`${rangeKey()}|${agentParam}|${model}|${provider}`)
  let grown = $state({ key: '', pages: 1 })
  const limit = $derived(grown.key === filterKey ? grown.pages * PAGE : PAGE)
  const loadMore = () => (grown = { key: filterKey, pages: limit / PAGE + 1 })
  const q = loader(() =>
    api.sessions({
      ...filterParams(),
      // An empty intersection still fetches under the global filter so the page has
      // its frame; `empty` then shows no rows.
      agent: agentParam === null ? range.agent || undefined : agentParam,
      model: model || undefined,
      provider: provider || undefined,
      limit,
    }),
  )
  // Chip options and counts come from the agent directory for the same window, so they
  // are the window's real session totals rather than a tally of the rows loaded so far.
  const agentsQ = loader(() => api.agents(filterParams()))

  $effect(() => {
    void rangeKey()
    void range.host
    void agentParam
    void model
    void provider
    void limit
    void live.lastTick
    q.run()
  })
  $effect(() => {
    void rangeKey()
    void range.agent
    void range.host
    void live.lastTick
    agentsQ.run()
  })

  const d = $derived(q.state.data)
  const empty = $derived(agentParam === null)
  const agentIds = $derived.by(() => {
    const listed = (agentsQ.state.data?.rows ?? []).filter((a) => Number(a.metrics.sessions ?? 0) > 0).map((a) => a.agentId)
    // A selection the window no longer lists (a stale link, another global agent) stays
    // visible so it can be cleared, instead of filtering invisibly.
    return [...new Set([...listed, ...agentSel])].sort()
  })
  const sessionsOf = (id: string) => Number(agentsQ.state.data?.rows.find((a) => a.agentId === id)?.metrics.sessions ?? 0)
  const agentColor = (id: string) => SERIES[Math.max(0, agentIds.indexOf(id)) % SERIES.length]!
  // Counts are per agent across the window; with a model narrowing they would overstate
  // the matching rows, so they are left off rather than shown wrong.
  const agentOpts = $derived(
    agentIds.map((id) => ({ key: id, label: agentLabel(id), dot: agentColor(id), count: model || provider ? undefined : sessionsOf(id) })),
  )
  const rows = $derived.by(() => {
    if (empty) return []
    const needle = search.trim().toLowerCase()
    return (d?.rows ?? []).filter(
      (r) => !needle || [r.title ?? '', r.sessionId, r.project, r.agentId, r.hostId].some((s) => s.toLowerCase().includes(needle)),
    )
  })
  const clearModel = () => {
    model = ''
    provider = ''
  }

  // Derived, not const: the column heads are the viewer's language, and a
  // re-render is what turns "Active" into "活跃时长" without a reload.
  const columns = $derived([
    { key: 'session', label: $t('sessions.colSession'), width: '31%' },
    { key: 'agent', label: $t('sessions.colAgent'), width: '14%' },
    { key: 'project', label: $t('sessions.colProject'), width: '14%' },
    { key: 'events', label: $t('sessions.colEvents'), align: 'right' as const, width: '8%' },
    { key: 'tokens', label: $t('sessions.colTokens'), align: 'right' as const, width: '8%' },
    { key: 'duration', label: $t('sessions.colActive'), align: 'right' as const, width: '8%', info: activeMetricInfo() },
    { key: 'cost', label: $t('sessions.colCost'), align: 'right' as const, width: '12%', info: $t('sessions.colCostInfo', { values: { na: $t('common.na') } }) },
    { key: 'last', label: $t('sessions.colLast'), align: 'right' as const, width: '9%' },
  ])
  const now = $derived(live.lastTick || Date.now())
</script>

<PageHeader title={$t('sessions.title')} description={$t('sessions.description')} refreshing={q.state.refreshing} />

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('sessions.loading')} />
{:else}
  {#if !d.content.available}
    <div class="mb-4"><Alert tone="neutral">{$t('sessions.contentOff')}</Alert></div>
  {/if}

  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <FilterChips label={$t('sessions.filterByAgent')} options={agentOpts} bind:selected={agentSel} multiple />
      {#if model || provider}
        <span class="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent-tint pl-3 pr-1 text-xs font-medium text-accent-ink">
          <span class="truncate" title={[provider, model].filter(Boolean).join(' / ')}>{$t('sessions.modelFilter', { values: { model: model || provider } })}</span>
          <button type="button" class="grid h-5 w-5 place-items-center rounded-full hover:bg-surface/70" aria-label={$t('sessions.clearModel')} onclick={clearModel}>
            <Icon name="x" size={12} />
          </button>
        </span>
      {/if}
    </div>
    <label class="relative flex items-center">
      <span class="sr-only">{$t('sessions.searchLabel')}</span>
      <Icon name="search" size={14} class="pointer-events-none absolute left-2.5 text-ink-3" />
      <input
        type="search"
        bind:value={search}
        placeholder={$t('sessions.searchPlaceholder')}
        class="h-8 w-64 max-w-full rounded-full bg-surface pl-8 pr-3 text-[13px] text-ink shadow-btn outline-none placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
      />
    </label>
  </div>

  <Surface padded={false}>
    <DataTable
      {columns}
      {rows}
      key={(r: SessionRow) => r.sessionId}
      caption={$t('sessions.title')}
      empty={d.rows.length || empty || model || provider ? $t('sessions.emptyFiltered') : $t('sessions.emptyWindow')}
    >
      {#snippet row(r: SessionRow)}
        {@const span = spanMs(r.firstTimestamp, r.lastTimestamp)}
        <td>
          <a href="#/sessions/{encodeURIComponent(r.sessionId)}" class="block truncate font-medium text-ink hover:text-accent" title={r.title ?? r.sessionId}>
            {r.title || $t('sessions.untitled', { values: { agent: r.agentId } })}
          </a>
          <div class="nums truncate text-xs text-ink-3" title={r.sessionId}>{shortId(r.sessionId, 12)}</div>
        </td>
        <td>
          <span class="inline-flex max-w-full items-center gap-1.5 text-ink-2" title="{r.agentId} · {r.hostId}">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background:{agentColor(r.agentId)}"></span>
            <span class="truncate">{agentLabel(r.agentId)}</span>
          </span>
          {#if r.hostId !== r.agentId}<div class="truncate text-xs text-ink-3">{hostLabel(r.hostId)}</div>{/if}
        </td>
        <td class="text-ink-2" title={r.project}><span class={projectLabel(r.project) !== r.project ? 'nums' : ''}>{projectLabel(r.project)}</span></td>
        <td class="nums text-right">{formatInt(r.events)}</td>
        <td class="nums text-right">{formatCompact(r.tokensTotal)}</td>
        <td class="nums text-right text-ink-2" title={r.durationMs > 0 ? activeMetricInfo() : $t('sessions.noDurations')}>
          {r.durationMs > 0 ? formatMs(r.durationMs) : $t('common.dash')}
          {#if span !== null}<div class="text-[11px] text-ink-3" title={$t('sessions.wallClockTitle')}>{formatMs(span)}</div>{/if}
        </td>
        <td class="text-right"><CostFigure value={r.costApiEquiv} basis="est" showLabel={false} /></td>
        <td class="nums text-right text-ink-3" title={r.lastTimestamp ? new Date(r.lastTimestamp).toISOString() : ''}>{relativeTime(r.lastTimestamp, now)}</td>
      {/snippet}
    </DataTable>
  </Surface>
  <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
    <p>{$t('sessions.showing', { values: { n: formatInt(rows.length), total: formatInt(empty ? 0 : d.totalSessions), tail: d.truncated && !empty ? $t('sessions.showingTailTruncated', { values: { n: formatInt(d.rows.length) } }) : '' } })}</p>
    {#if d.truncated && !empty}
      <button
        type="button"
        class="h-7 rounded-full bg-surface px-3 font-medium text-ink-2 shadow-btn hover:bg-hover hover:text-ink disabled:opacity-60"
        disabled={q.state.refreshing}
        onclick={loadMore}
      >{$t('sessions.loadMore', { values: { n: formatInt(PAGE) } })}</button>
    {/if}
  </div>
{/if}

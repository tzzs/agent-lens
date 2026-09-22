<script lang="ts">
  // GET /api/query — a thin UI over the single §7 cube (this page IS the cube; every
  // other page is a fixed slice of it). The returned `explain` is rendered verbatim
  // so the user always sees the basis behind the numbers (§7 "basis is visible").
  import type { MessageKey } from '@agentlens/i18n'
  import {
    api,
    CAPABILITY_TYPES,
    QUERY_METRICS,
    QUERY_DIMS,
    capabilityDimCell,
    isCapabilityNameDim,
    withCapabilityType,
    type Row,
  } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range } from '../lib/filter.svelte.js'
  import { options, live } from '../lib/live.svelte.js'
  import { formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import { t } from '../lib/lang.js'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable from '../components/ui/DataTable.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import CodeBlock from '../components/ui/CodeBlock.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  let metrics = $state<string[]>(['events', 'tokens_total', 'cost_api_equiv'])
  let dims = $state<string[]>(['agent'])
  let agent = $state('')
  let status = $state('')
  let order = $state('metric:events:desc')
  let limit = $state(50)
  let nonce = $state(0)

  // Capability-name dims (`tool`, `skill`, …) yield '' for every event of another
  // kind, so the page must restrict the row set to those kinds or the whole store
  // lands in one unnamed bucket and the explorer counts everything as the capability.
  const nameDims = $derived(dims.filter(isCapabilityNameDim))
  const querySpec = $derived(
    withCapabilityType(dims, {
      metrics: metrics.join(','),
      dims: dims.join(','),
      since: range.since,
      agent: agent || undefined,
      status: status || undefined,
      order,
      limit,
    }),
  )

  const q = loader(() => api.query(querySpec))

  // A caller-set capabilityType that contradicts the selected dim can match no row.
  // Running it would drop the restriction (an empty list is not a filter) and count
  // the whole store, so the page says "impossible" instead of fetching.
  const dimConflict = $derived(
    nameDims.length > 0 && Array.isArray(querySpec.capabilityType) && querySpec.capabilityType.length === 0,
  )

  // Debounced reload whenever the spec changes so a checkbox spam does not hammer the
  // cube; the live tick also refreshes the current view.
  $effect(() => {
    void metrics
    void dims
    void agent
    void status
    void order
    void limit
    void range.since
    void live.lastTick
    void nonce
    if (dimConflict) return
    const t = setTimeout(q.run, 150)
    return () => clearTimeout(t)
  })

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  }
  const isDim = (c: string) => (QUERY_DIMS as readonly string[]).includes(c)
  const costMetric = (c: string) => c === 'cost_api_equiv' || c === 'cost_reported'

  function cell(col: string, v: unknown) {
    if (v === null || v === undefined) return null
    if (isCapabilityNameDim(col)) return capabilityDimCell(col, v, nameDims)
    if (col === 'duration') return formatMs(Number(v))
    if (col.startsWith('tokens')) return formatCompact(Number(v))
    if (col === 'events' || col === 'sessions') return formatInt(Number(v))
    return String(v)
  }

  // Stale-while-revalidate: after the first answer the last good result stays up
  // while a new spec runs (or fails), so the table never flashes back to a spinner.
  const res = $derived(q.state.data)
  // The cube returns no rows without a dim — the aggregate then lives only in totals.
  const hasDim = $derived(res ? res.columns.some(isDim) : false)

  // The header's window, as a sentence of its own. `{since}` is the raw §7 value the
  // query sends (`30d`, `365d`) rather than the pill's label: the pill for the last
  // option reads `1y` in English while this line has always said `365d`, and the two
  // strings are also what the §14 tests quote.
  const windowText = $derived(range.since ? $t('usage.windowLast', { values: { since: range.since } }) : $t('usage.windowAll'))

  const resultNote = $derived(
    !res
      ? ''
      : nameDims.length
        ? $t('usage.rowsRestricted', {
            values: {
              dims: nameDims.join(', '),
              trunc: $t(res.truncated ? 'usage.truncatedByLimit' : 'usage.notTruncated'),
            },
          })
        : res.truncated
          ? $t('usage.truncatedNote')
          : '',
  )

  // Fixed px widths per column: the table grows past the card and scrolls sideways
  // instead of squeezing a wide spec until every header is an ellipsis.
  const TIME_DIMS = ['time', 'day', 'week', 'month']
  const MONO_DIMS = [...TIME_DIMS, 'session', 'thread']
  function colWidth(c: string): string {
    if (costMetric(c)) return '140px'
    if (TIME_DIMS.includes(c)) return '120px'
    if (isDim(c)) return c === 'session' || c === 'thread' ? '240px' : '200px'
    return `${Math.max(110, c.length * 7 + 36)}px`
  }
  /**
   * The cube's field names as the viewer's language reads them. English repeats the
   * wire name, so the gloss is a Chinese-only layer: the request, the `totals` keys
   * and the server's own explain all keep saying `tokens_total`. A field the vocab
   * lists do not know has no gloss and prints its raw name.
   */
  const vocabKeys: Record<string, MessageKey> = {
    events: 'usage.metrics.events',
    sessions: 'usage.metrics.sessions',
    duration: 'usage.metrics.duration',
    tokens_total: 'usage.metrics.tokensTotal',
    tokens_input: 'usage.metrics.tokensInput',
    tokens_output: 'usage.metrics.tokensOutput',
    tokens_cache_read: 'usage.metrics.tokensCacheRead',
    tokens_cache_write: 'usage.metrics.tokensCacheWrite',
    tokens_reasoning: 'usage.metrics.tokensReasoning',
    cost_api_equiv: 'usage.metrics.costApiEquiv',
    cost_reported: 'usage.metrics.costReported',
    time: 'usage.dims.time',
    day: 'usage.dims.day',
    week: 'usage.dims.week',
    month: 'usage.dims.month',
    agent: 'usage.dims.agent',
    host: 'usage.dims.host',
    project: 'usage.dims.project',
    session: 'usage.dims.session',
    thread: 'usage.dims.thread',
    model: 'usage.dims.model',
    provider: 'usage.dims.provider',
    capability_type: 'usage.dims.capabilityType',
    capability_name: 'usage.dims.capabilityName',
    tool: 'usage.dims.tool',
    skill: 'usage.dims.skill',
    mcp: 'usage.dims.mcp',
    plugin: 'usage.dims.plugin',
    connector: 'usage.dims.connector',
    command: 'usage.dims.command',
    subagent: 'usage.dims.subagent',
    hook: 'usage.dims.hook',
    status: 'usage.dims.status',
    usage_source: 'usage.dims.usageSource',
  }
  function vocab(c: string): string {
    const key = vocabKeys[c]
    return key ? $t(key) : c
  }
  /** A column header carries the raw field name once the label stops being it. */
  function colInfo(c: string): string | undefined {
    const label = vocab(c)
    return label === c ? undefined : c
  }
  const resultColumns = $derived(
    (res?.columns ?? []).map((c) => ({ key: c, label: vocab(c), align: isDim(c) ? ('left' as const) : ('right' as const), width: colWidth(c), info: colInfo(c) })),
  )

  function totalText(c: string) {
    const v = Number(res?.totals[c] ?? 0)
    if (c.startsWith('tokens')) return formatCompact(v)
    if (c === 'duration') return formatMs(v)
    return formatInt(v)
  }

  // Picker groups, built from the cube's own vocabulary so a new name always shows
  // up (under "Other") instead of silently going missing.
  type Group = { label: string; note?: string; names: string[] }
  function grouped(all: readonly string[], groups: Group[]): Group[] {
    const out = groups.map((g) => ({ ...g, names: g.names.filter((n) => all.includes(n)) }))
    const placed = new Set(out.flatMap((g) => g.names))
    out.push({ label: $t('usage.groupOther'), names: all.filter((n) => !placed.has(n)) })
    return out.filter((g) => g.names.length > 0)
  }
  const METRIC_GROUPS = $derived(
    grouped(QUERY_METRICS, [
      { label: $t('usage.groupActivity'), names: ['events', 'sessions', 'duration'] },
      { label: $t('usage.groupTokens'), names: QUERY_METRICS.filter((m) => m.startsWith('tokens')) },
      { label: $t('usage.groupCost'), names: ['cost_api_equiv', 'cost_reported'] },
    ]),
  )
  const DIM_GROUPS = $derived(
    grouped(QUERY_DIMS, [
      { label: $t('usage.groupTime'), names: TIME_DIMS },
      { label: $t('usage.groupScope'), names: ['agent', 'host', 'project', 'session', 'thread'] },
      { label: $t('usage.groupModel'), names: ['model', 'provider'] },
      { label: $t('usage.groupCapability'), names: ['capability_type', 'capability_name'] },
      { label: $t('usage.groupCapabilityName'), note: $t('usage.capabilityNameNote'), names: [...CAPABILITY_TYPES] },
    ]),
  )

  const pill = 'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors'
  const pillOff = 'bg-surface text-ink-2 shadow-btn hover:bg-hover hover:text-ink'
  const metricOn = 'bg-accent-tint text-accent-ink ring-1 ring-accent/40'
  const dimOn = 'bg-hover-2 text-ink ring-1 ring-line-strong'
  const fieldLabel = 'mb-1 block text-xs font-medium text-ink-3'
  const field = 'h-8 w-full rounded-lg bg-field px-2.5 text-[13px] text-ink shadow-btn outline-none placeholder:text-ink-3 focus-visible:outline-accent'
</script>

{#snippet picker(label: string, groups: Group[], selected: string[], onClass: string, onToggle: (name: string) => void)}
  <div class="space-y-3" role="group" aria-label={label}>
    {#each groups as g (g.label)}
      <div role="group" aria-label="{label}: {g.label}">
        <div class="mb-1.5 text-[11px] font-medium text-ink-3">{g.label}{#if g.note}<span class="font-normal"> · {g.note}</span>{/if}</div>
        <div class="flex flex-wrap gap-1.5">
          {#each g.names as n (n)}
            {@const on = selected.includes(n)}
            {@const nameLabel = vocab(n)}
            <button type="button" aria-pressed={on} class="{pill} {on ? onClass : pillOff}" onclick={() => onToggle(n)} title={nameLabel === n ? undefined : n}>
              {#if on}<Icon name="check" size={12} />{/if}{nameLabel}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet chevron()}
  <Icon name="chevronDown" size={14} class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
{/snippet}

<PageHeader
  title={$t('usage.explorerTitle')}
  description={$t('usage.pageDesc', { values: { window: windowText } })}
  info={$t('usage.pageInfo')}
  refreshing={q.state.refreshing || (q.state.status === 'loading' && !!res)}
/>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
  <div class="min-w-0 space-y-4">
    <Surface title={$t('usage.metricsTitle')} note={$t('usage.selectedCount', { values: { n: String(metrics.length) } })}>
      {@render picker($t('usage.metricsTitle'), METRIC_GROUPS, metrics, metricOn, (m) => (metrics = toggle(metrics, m)))}
    </Surface>

    <Surface title={$t('usage.dimsTitle')} note={$t('usage.selectedCount', { values: { n: String(dims.length) } })}>
      {@render picker($t('usage.dimsTitle'), DIM_GROUPS, dims, dimOn, (dm) => (dims = toggle(dims, dm)))}
    </Surface>

    <Surface title={$t('usage.filtersTitle')} info={$t('usage.filtersInfo')}>
      <div class="space-y-3">
        <div>
          <label for="usage-agent" class={fieldLabel}>{$t('comps.agent')}</label>
          <div class="relative">
            <select id="usage-agent" class="{field} appearance-none pr-8" bind:value={agent}>
              <option value="">{$t('comps.allAgents')}</option>
              {#each options.agents as a (a.agentId)}<option value={a.agentId}>{a.displayName || a.agentId}</option>{/each}
            </select>
            {@render chevron()}
          </div>
        </div>
        <div>
          <label for="usage-status" class={fieldLabel}>{$t('usage.statusLabel')}</label>
          <div class="relative">
            <select id="usage-status" class="{field} appearance-none pr-8" bind:value={status}>
              <option value="">{$t('usage.anyStatus')}</option>
              <option value="ok">{$t('usage.statusOk')}</option>
              <option value="error">{$t('usage.statusError')}</option>
              <option value="unknown">{$t('usage.statusUnknown')}</option>
            </select>
            {@render chevron()}
          </div>
        </div>
        <div>
          <label for="usage-order" class={fieldLabel}>{$t('usage.orderLabel')}</label>
          <input
            id="usage-order"
            class="{field} nums"
            bind:value={order}
            placeholder="metric:events:desc"
            spellcheck="false"
            autocomplete="off"
            aria-describedby="usage-order-hint"
          />
          <p id="usage-order-hint" class="mt-1 text-[11px] text-ink-3">
            <span class="nums">metric:&lt;name&gt;:desc</span> {$t('usage.orderOr')} <span class="nums">dim:&lt;name&gt;:asc</span>
          </p>
        </div>
        <div>
          <label for="usage-limit" class={fieldLabel}>{$t('usage.limitLabel')}</label>
          <input id="usage-limit" class="{field} nums" type="number" min="0" max="5000" bind:value={limit} aria-describedby="usage-limit-hint" />
          <p id="usage-limit-hint" class="mt-1 text-[11px] text-ink-3">{$t('usage.limitHint')}</p>
        </div>
      </div>
    </Surface>
  </div>

  <div class="min-w-0 space-y-4">
    {#if dimConflict}
      <Alert tone="orange" title={$t('usage.noMatchTitle')}>{$t('usage.noMatchBody')}</Alert>
    {:else if metrics.length === 0}
      <Alert tone="accent">{$t('usage.selectOneMetric')}</Alert>
    {:else if !res}
      <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('usage.loadingText')} />
    {:else}
      {#if q.state.status === 'error'}
        <Alert tone="red" title={$t('usage.failedTitle')}>{q.state.error} — {$t('usage.failedTail')}</Alert>
      {/if}

      <Surface
        padded={false}
        title={hasDim ? $t('usage.rowCount', { values: { n: formatInt(res.rows.length) } }) : $t('usage.totals')}
        note={resultNote}
        info={$t('usage.totalsInfo')}
      >
        <DataTable
          columns={resultColumns}
          rows={res.rows}
          key={(_r: Row, i: number) => String(i)}
          dense
          caption={$t('usage.caption')}
          empty={hasDim ? $t('usage.emptyNoRows') : $t('usage.emptyNoDim')}
        >
          {#snippet row(r: Row)}
            {#each res.columns as c (c)}
              {#if costMetric(c)}
                <td class="text-right"><CostFigure value={r[c] as number | null} basis={c === 'cost_reported' ? 'reported' : 'est'} /></td>
              {:else}
                {@const text = cell(c, r[c])}
                {#if isDim(c)}
                  <!-- '' in a capability-name dim is a disclosure ("(unnamed)"), not a name -->
                  <td
                    class="{MONO_DIMS.includes(c) ? 'nums' : ''} {text === null || (isCapabilityNameDim(c) && String(r[c] ?? '') === '') ? 'text-ink-3' : 'text-ink'}"
                    title={text ?? undefined}
                  >{text ?? '—'}</td>
                {:else}
                  <td class="nums text-right {text === null ? 'text-ink-3' : 'text-ink'}">{text ?? '—'}</td>
                {/if}
              {/if}
            {/each}
          {/snippet}
          {#snippet footer()}
            <tr>
              {#each res.columns as c, ci (c)}
                {#if isDim(c)}
                  <!-- dims come first; only the first carries the label, the rest have no total -->
                  <td class="font-medium text-ink-2">{ci === 0 ? $t('usage.totals') : ''}</td>
                {:else if costMetric(c)}
                  <td class="text-right"><CostFigure value={res.totals[c] ?? null} basis={c === 'cost_reported' ? 'reported' : 'est'} /></td>
                {:else}
                  <td class="nums text-right font-medium text-ink">{totalText(c)}</td>
                {/if}
              {/each}
            </tr>
          {/snippet}
        </DataTable>
      </Surface>

      <Surface title={$t('usage.howTitle')} info={$t('usage.howInfo')}>
        <CodeBlock text={res.explain} />
      </Surface>
    {/if}
  </div>
</div>

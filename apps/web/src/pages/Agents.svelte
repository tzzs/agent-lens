<script lang="ts">
  // GET /api/agents (§10 priority 5). Host is part of an agent's identity (§18
  // item 6), so every card carries its own host split instead of one merged line.
  // An agent known but idle in the window reads "Not recorded in this window",
  // never a row of zeros (§14). Per-agent cost is null-dominant server-side: one
  // unpriced model makes the figure n/a rather than a silent undercount.
  import { api, type AgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { activeMetricInfo, formatCompact, formatInt, formatMs } from '../lib/format.ts'
  import { SERIES, eventKind } from '../lib/eventKinds.ts'
  import { t } from '../lib/lang.js'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import InfoTip from '../components/ui/InfoTip.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.agents(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  // The server appends every known-but-idle agent, including the ones the header's
  // agent filter excluded. Those are hidden rather than mislabelled "not recorded".
  const agentFilter = $derived(d?.filter?.agent ?? [])
  const hostFilter = $derived(d?.filter?.host ?? [])
  const cards = $derived(
    (d?.rows ?? []).filter((a) => a.recorded || agentFilter.length === 0 || agentFilter.includes(a.agentId)),
  )
  const hiddenByFilter = $derived((d?.rows.length ?? 0) - cards.length)

  let open = $state<Record<string, boolean>>({})

  // Derived, not const: the mode names and their notes are the viewer's language.
  const BILLING: Record<string, { label: string; note: string }> = $derived({
    api: { label: $t('agents.billingApi'), note: $t('agents.billingApiNote') },
    subscription: { label: $t('agents.billingSubscription'), note: $t('agents.billingSubscriptionNote') },
    local: { label: $t('agents.billingLocal'), note: $t('agents.billingLocalNote') },
  })
  const billing = (mode: string) => BILLING[mode] ?? { label: mode, note: $t('agents.billingFallbackNote') }

  /** Capability type as one word; an unknown type keeps the id the server sent. */
  const WORDS: Record<string, string> = $derived({
    tool: $t('agents.wordTool'),
    skill: $t('agents.wordSkill'),
    mcp: $t('agents.wordMcp'),
    plugin: $t('agents.wordPlugin'),
    connector: $t('agents.wordConnector'),
    command: $t('agents.wordCommand'),
    subagent: $t('agents.wordSubagent'),
    hook: $t('agents.wordHook'),
  })
  const wordOf = (type: string) => WORDS[type] ?? type

  const num = (v: number | null | undefined) => Number(v ?? 0)
  /** Exact below a million; compact above so a 4-up stat strip never overflows. The title keeps the exact figure. */
  const count = (n: number) => (n >= 1e6 ? formatCompact(n) : formatInt(n))
  /** A count in words: English picks its own plural, the figure arrives pre-grouped. */
  const pluralOf = (key: 'agents.hostsCount' | 'agents.capabilitiesCount' | 'agents.modelsCount' | 'agents.errorsCount', n: number) =>
    $t(key, { values: { n, s: formatInt(n) } })
  const share = (part: number, total: number) => {
    if (total <= 0) return '—'
    const pct = (part / total) * 100
    return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
  }
  const hostColor = (j: number) => SERIES[j % SERIES.length]!
  const subtitle = (a: AgentRow) => {
    const id = a.displayName && a.displayName !== a.agentId ? a.agentId : ''
    const hosts =
      a.hosts.length === 1
        ? $t('agents.hostOne', { values: { host: a.hosts[0]!.host } })
        : a.hosts.length > 1
          ? pluralOf('agents.hostsCount', a.hosts.length)
          : ''
    return [id, hosts].filter(Boolean).join(' · ')
  }
  const capTitle = (c: AgentRow['capabilities'][number]) =>
    $t('agents.capEvents', {
      values: { n: c.events, s: formatInt(c.events), type: wordOf(c.type) },
    }) + (c.errors ? $t('agents.capErrorTail', { values: { n: formatInt(c.errors) } }) : '')
</script>

<PageHeader
  title={$t('agents.title')}
  description={$t('agents.pageDesc')}
  info={$t('agents.pageInfo')}
  refreshing={q.state.refreshing}
/>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('agents.loading')} />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title={$t('states.refreshFailed')}>{q.state.error} — {$t('states.showingLastNumbers')}</Alert></div>
  {/if}

  {#if cards.length === 0}
    <Surface>
      <p class="py-8 text-center text-[13px] text-ink-3">
        {d.rows.length ? $t('agents.noMatch') : $t('agents.noneDetected')}
      </p>
    </Surface>
  {:else}
    <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {#each cards as a, i (a.agentId)}
        {@const name = a.displayName || a.agentId}
        {@const mode = billing(a.billingMode)}
        {#if a.recorded}
          {@const isOpen = !!open[a.agentId]}
          {@const hostEvents = a.hosts.reduce((s, h) => s + h.events, 0)}
          {@const duration = num(a.metrics.duration)}
          <Surface title={name} subtitle={subtitle(a)} padded={false}>
            {#snippet actions()}
              <Chip title={$t('agents.billingTitle', { values: { note: mode.note } })}>{mode.label}</Chip>
            {/snippet}

            <div class="px-4 py-3.5">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">{$t('agents.sessions')}</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title={$t('agents.sessionsTitle', { values: { n: num(a.metrics.sessions), s: formatInt(num(a.metrics.sessions)) } })}>{count(num(a.metrics.sessions))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">{$t('agents.events')}</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title={$t('agents.eventsTitle', { values: { n: num(a.metrics.events), s: formatInt(num(a.metrics.events)) } })}>{count(num(a.metrics.events))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">{$t('agents.tokens')}</dt>
                  <dd class="nums mt-0.5 text-lg font-semibold text-ink" title={$t('agents.tokensTitle', { values: { n: num(a.metrics.tokens_total), s: formatInt(num(a.metrics.tokens_total)) } })}>{formatCompact(num(a.metrics.tokens_total))}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs text-ink-3">{$t('agents.estCost')}</dt>
                  <dd class="mt-0.5 text-lg font-semibold"><CostFigure value={a.metrics.cost_api_equiv ?? null} basis="est" showLabel={false} /></dd>
                </div>
                {#if a.metrics.credits !== null && a.metrics.credits !== undefined}
                  <div class="min-w-0">
                    <dt class="text-xs text-ink-3">{$t('agents.credits')}</dt>
                    <dd class="nums mt-0.5 text-lg font-semibold text-ink" title={$t('agents.creditsTitle')}>{formatCompact(num(a.metrics.credits))}</dd>
                  </div>
                {/if}
              </dl>
              <p class="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
                {$t('agents.active')}
                <span class="nums text-ink-2" title={duration > 0 ? undefined : $t('agents.noDurations')}>{duration > 0 ? formatMs(duration) : '—'}</span>
                <InfoTip text={activeMetricInfo()} />
              </p>
            </div>

            <button
              type="button"
              class="flex w-full items-center gap-1.5 border-t border-line-soft px-4 py-2.5 text-left text-xs transition-colors hover:bg-hover {isOpen ? '' : 'rounded-b-card'}"
              aria-expanded={isOpen}
              aria-controls="agent-detail-{i}"
              onclick={() => (open[a.agentId] = !open[a.agentId])}
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={13} class="text-ink-3" />
              <span class="font-medium text-ink-2">{$t('agents.breakdown')}</span>
              <span class="ml-auto truncate text-ink-3">
                {pluralOf('agents.hostsCount', a.hosts.length)} · {pluralOf('agents.capabilitiesCount', a.capabilities.length)} · {pluralOf('agents.modelsCount', a.models.length)}
              </span>
            </button>

            {#if isOpen}
              <div id="agent-detail-{i}" class="space-y-5 rounded-b-card border-t border-line-soft bg-inset px-4 py-4">
                {#if a.hosts.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">{$t('agents.hostsHeading')}</h4>
                    {#if a.hosts.length > 1}
                      <div class="mb-2 flex h-1.5 gap-px overflow-hidden rounded-full bg-hover-2" aria-hidden="true">
                        {#each a.hosts as h, j (h.host)}
                          <span class="h-full" style="width:{hostEvents ? (h.events / hostEvents) * 100 : 0}%;background:{hostColor(j)}"></span>
                        {/each}
                      </div>
                    {/if}
                    <table class="w-full table-fixed text-[13px]">
                      <caption class="sr-only">{$t('agents.hostsCaption', { values: { name } })}</caption>
                      <thead>
                        <tr class="text-[11px] text-ink-3">
                          <th scope="col" class="pb-1 text-left font-medium">{$t('agents.colHost')}</th>
                          <th scope="col" class="w-20 pb-1 text-right font-medium">{$t('agents.sessions')}</th>
                          <th scope="col" class="w-24 pb-1 text-right font-medium">{$t('agents.events')}</th>
                          <th scope="col" class="w-14 pb-1 text-right font-medium" title={$t('agents.shareInfo')}>{$t('agents.colShare')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each a.hosts as h, j (h.host)}
                          <tr class="border-t border-line-soft">
                            <td class="py-1.5 pr-3">
                              <span class="flex min-w-0 items-center gap-2">
                                {#if a.hosts.length > 1}
                                  <span class="h-2 w-2 shrink-0 rounded-[3px]" style="background:{hostColor(j)}" aria-hidden="true"></span>
                                {/if}
                                <span class="truncate text-ink" title={h.host}>{h.host}</span>
                              </span>
                            </td>
                            <td class="nums py-1.5 text-right text-ink-2">{formatInt(h.sessions)}</td>
                            <td class="nums py-1.5 text-right text-ink-2">{formatInt(h.events)}</td>
                            <td class="nums py-1.5 text-right text-ink-3">{share(h.events, hostEvents)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </section>
                {/if}

                {#if a.capabilities.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">{$t('agents.capabilitiesHeading')}</h4>
                    <ul class="flex flex-wrap gap-1.5">
                      {#each a.capabilities as c (c.type)}
                        <li class="min-w-0">
                          <Chip title={capTitle(c)}>
                            <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style="background:{eventKind(c.type).color}" aria-hidden="true"></span>{wordOf(c.type)}
                            <span class="nums text-ink-3">{formatInt(c.events)}</span>
                            {#if c.errors}<span class="nums text-red">· {pluralOf('agents.errorsCount', c.errors)}</span>{/if}
                          </Chip>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/if}

                {#if a.models.length}
                  <section>
                    <h4 class="mb-2 text-xs font-medium text-ink-2">{$t('agents.modelsHeading')}</h4>
                    <table class="w-full table-fixed text-[13px]">
                      <caption class="sr-only">{$t('agents.modelsCaption', { values: { name } })}</caption>
                      <thead>
                        <tr class="text-[11px] text-ink-3">
                          <th scope="col" class="pb-1 text-left font-medium">{$t('agents.colModel')}</th>
                          <th scope="col" class="w-20 pb-1 text-right font-medium">{$t('agents.tokens')}</th>
                          <th scope="col" class="w-24 pb-1 text-right font-medium">{$t('agents.estCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each a.models as m (m.model)}
                          <tr class="border-t border-line-soft">
                            <td class="nums truncate py-1.5 pr-3 text-ink" title={m.model}>{m.model}</td>
                            <td class="nums py-1.5 text-right text-ink-2" title={$t('agents.tokensTitle', { values: { n: m.tokensTotal, s: formatInt(m.tokensTotal) } })}>{formatCompact(m.tokensTotal)}</td>
                            <td class="py-1.5 text-right"><CostFigure value={m.costApiEquiv} basis="est" showLabel={false} /></td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </section>
                {/if}

                <a href="#/sessions" class="inline-flex text-[13px] font-medium text-accent-ink hover:underline">{$t('agents.viewSessions')}</a>
              </div>
            {/if}
          </Surface>
        {:else}
          <section class="min-w-0 rounded-card bg-inset px-4 py-3.5 ring-1 ring-line">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-[13px] font-semibold text-ink-2">{name}</h3>
                {#if a.displayName && a.displayName !== a.agentId}<p class="nums mt-0.5 truncate text-xs text-ink-3">{a.agentId}</p>{/if}
              </div>
              <Chip title={$t('agents.billingTitle', { values: { note: mode.note } })}>{mode.label}</Chip>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip dashed title={$t('agents.notRecordedTitle')}>{$t('agents.notRecorded')}</Chip>
              {#if hostFilter.length}<span class="text-xs text-ink-3">{$t('agents.hostFilterLine', { values: { hosts: hostFilter.join(', ') } })}</span>{/if}
            </div>
          </section>
        {/if}
      {/each}
    </div>
  {/if}

  {#if hiddenByFilter > 0}
    <p class="mt-3 text-xs text-ink-3">{$t('agents.hiddenByFilter', { values: { n: hiddenByFilter, s: formatInt(hiddenByFilter) } })}</p>
  {/if}
{/if}

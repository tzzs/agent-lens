<script lang="ts">
  // Settings: adapters / pricing / data sources / privacy (§10 nav). This page reads
  // no statistics of its own — it surfaces the server's self-report from /api/health
  // and /api/doctor, including the privacy-relevant facts (content layer on/off,
  // loopback-only bind, DB path) so a user can confirm the local-first guarantees.
  // Sections render as soon as their own route answers: /api/health is instant,
  // /api/doctor scans every usage row. The theme is the one setting stored in this
  // browser; the one thing written back to the server is the §8 billing declaration.
  import { api, BILLING_MODES, type BillingAgentRow, type BillingMode, type DoctorAgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { theme, setTheme } from '../lib/theme.svelte.js'
  import { agentNote, costBasis } from '../lib/notes.ts'
  import { t } from '../lib/lang.js'
  import { formatDateTime, formatInt } from '../lib/format.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import DataTable from '../components/ui/DataTable.svelte'
  import Segmented from '../components/ui/Segmented.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import StatePanel from '../components/StatePanel.svelte'

  const health = loader(() => api.health())
  const doctor = loader(() => api.doctor())
  const billing = loader(() => api.billingSettings())
  $effect(() => {
    void live.lastTick
    health.run()
    doctor.run()
    billing.run()
  })

  const h = $derived(health.state.data)
  const doc = $derived(doctor.state.data)
  const b = $derived(billing.state.data)

  // Before either route has answered there is nothing to show: one panel, naming
  // whichever request failed. After that, each section waits only for its own route.
  const failed = $derived(health.state.status === 'error' ? health.state : doctor.state.status === 'error' ? doctor.state : null)
  // A failed re-run keeps the last good values on screen, so say so.
  const refreshError = $derived(
    (h && health.state.status === 'error' ? health.state.error : null) ?? (doc && doctor.state.status === 'error' ? doctor.state.error : null),
  )

  // The theme control reads the shared preference and writes through setTheme — no
  // local copy. A local $state mirrored by an $effect fights every other writer (the
  // sidebar's switch): two such mirrors ping-pong until Svelte aborts the update.
  const pickTheme = (v: string) => setTheme(v === 'light' || v === 'dark' ? v : 'system')

  // Derived, not const: the pill labels are the viewer's language.
  const THEME_OPTIONS = $derived([
    { value: 'system', label: $t('settings.themeSystem'), icon: 'monitor' as const },
    { value: 'light', label: $t('settings.themeLight'), icon: 'sun' as const },
    { value: 'dark', label: $t('settings.themeDark'), icon: 'moon' as const },
  ])

  // The §8 declaration editor. The select is uncontrolled — the row's value comes from
  // the server and a write re-reads it, so no local copy can drift from what the cube
  // actually folded (and a refused value snaps back instead of lying on screen).
  const MODE_LABEL: Record<BillingMode, string> = $derived({
    api: $t('settings.modeApi'),
    subscription: $t('settings.modeSubscription'),
    local: $t('settings.modeLocal'),
  })
  const agentLabel = (a: BillingAgentRow): string => a.displayName || a.agentId
  let saving = $state<Record<string, boolean>>({})
  /** The write's own reply, kept as its parts so the wording is the viewer's. */
  let billingNote = $state<{ agent: string; mode: string; cleared: boolean } | null>(null)
  let billingError = $state<string | null>(null)

  async function declare(agentId: string, value: string): Promise<void> {
    const mode = value === '' ? null : (value as BillingMode)
    saving[agentId] = true
    billingNote = null
    billingError = null
    try {
      const res = await api.setBilling({ agent: agentId, mode })
      billingNote = { agent: res.agent, mode: res.mode, cleared: mode === null }
    } catch (err) {
      billingError = err instanceof Error ? err.message : String(err)
    } finally {
      delete saving[agentId]
      void billing.run()
    }
  }

  const STATUS_LABEL: Record<DoctorAgentRow['status'], string> = $derived({
    ok: $t('settings.statusOk'),
    'ingested-only': $t('settings.statusIngestedOnly'),
    'not-detected': $t('settings.statusNotDetected'),
    error: $t('settings.statusError'),
  })
  const STATUS_TONE: Record<DoctorAgentRow['status'], 'neutral' | 'green' | 'red'> = {
    ok: 'green',
    'ingested-only': 'neutral',
    'not-detected': 'neutral',
    error: 'red',
  }
  const adapterColumns = $derived([
    { key: 'agent', label: $t('settings.colAgent'), width: '22%' },
    { key: 'version', label: $t('settings.colVersion'), width: '16%' },
    { key: 'root', label: $t('settings.colRoot'), width: '34%' },
    { key: 'sources', label: $t('settings.colSources'), align: 'right' as const, width: '10%' },
    { key: 'status', label: $t('settings.colStatus'), width: '18%' },
  ])

  const dlRow = 'flex items-baseline justify-between gap-4 border-b border-line-soft py-2 last:border-0'
</script>

<PageHeader
  title={$t('settings.title')}
  description={$t('settings.pageDesc')}
  info={$t('settings.pageInfo')}
  refreshing={health.state.refreshing || doctor.state.refreshing}
/>

{#if refreshError}
  <div class="mb-4"><Alert tone="red" title={$t('states.refreshFailed')}>{refreshError} — {$t('states.showingLast')}</Alert></div>
{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
  {#if !h && !doc}
    <div class="lg:col-span-2">
      <StatePanel
        status={failed ? 'error' : 'loading'}
        error={failed?.error}
        kind={failed?.kind}
        since={Math.min(health.state.since, doctor.state.since)}
        loadingText={$t('settings.loadingServerReport')}
      />
    </div>
  {:else}
    {#if h}
      <Surface title={$t('settings.server')}>
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.serverName')}</dt><dd class="nums min-w-0 truncate text-ink" title={h.server}>{h.server}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.status')}</dt>
            <dd><Chip tone={h.status === 'ok' ? 'green' : 'orange'}>{h.status === 'ok' ? $t('settings.statusOk') : h.status}</Chip></dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.serverClock')}</dt><dd class="nums text-ink">{formatDateTime(h.now)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.dbPath')}</dt>
            <dd class="min-w-0 break-all text-right {h.dbPath ? 'nums text-ink' : 'text-ink-2'}">{h.dbPath ?? $t('settings.inMemory')}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.migrationsApplied')}</dt><dd class="nums text-ink">{formatInt(h.migrationsApplied)}</dd></div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.eventsStored')}</dt><dd class="nums text-ink">{formatInt(h.events)}</dd></div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.sessions')}</dt><dd class="nums text-ink">{formatInt(h.sessions)}</dd></div>
        </dl>
      </Surface>

      <Surface title={$t('settings.privacyTitle')}>
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.loopbackBind')}</dt>
            <dd>{#if h.loopbackOnly}<Chip tone="green">{$t('settings.loopbackYes')}</Chip>{:else}<Chip tone="red">{$t('settings.loopbackNo')}</Chip>{/if}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.contentLayer')}</dt>
            <dd>
              {#if h.contentAvailable}
                <Chip tone="orange">{$t('settings.contentOn', { values: { n: formatInt(h.payloads) } })}</Chip>
              {:else}
                <Chip tone="green">{$t('settings.contentOff')}</Chip>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-2">
          {$t('settings.privacyLead')}
          <span class="nums text-ink">--content</span>{$t('settings.privacyTail')}
        </p>
      </Surface>
    {:else}
      <div class="lg:col-span-2">
        <StatePanel status={health.state.status} error={health.state.error} kind={health.state.kind} since={health.state.since} loadingText={$t('settings.loadingAsking')} />
      </div>
    {/if}

    {#if doc}
      <Surface
        title={$t('settings.adapters')}
        subtitle={doc.adaptersInstalled ? '' : $t('settings.noAdapters')}
        info={$t('settings.adaptersInfo')}
        padded={false}
        class="lg:col-span-2"
      >
        <DataTable columns={adapterColumns} rows={doc.agents} key={(a: DoctorAgentRow) => a.id} caption={$t('settings.adaptersCaption')} empty={$t('settings.adaptersEmpty')}>
          {#snippet row(a: DoctorAgentRow)}
            <td><span class="font-medium text-ink" title={a.id}>{a.displayName || a.id}</span></td>
            <td class="nums text-ink-2" title={a.detectedVersion ?? undefined}>{a.detectedVersion ?? '—'}</td>
            <td class="nums text-ink-2" title={a.dataRoot ?? undefined}>{a.dataRoot ?? '—'}</td>
            <td class="nums text-right text-ink">{formatInt(a.sources)}</td>
            <td>
              <Chip tone={STATUS_TONE[a.status]} dashed={a.status === 'not-detected'} title={a.noteCode ? agentNote(a.noteCode, a.noteDetail) : ''}>{STATUS_LABEL[a.status] ?? a.status}</Chip>
            </td>
          {/snippet}
        </DataTable>
      </Surface>

      <Surface title={$t('settings.pricing')} info={$t('settings.pricingInfo')}>
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.priceTable')}</dt>
            <dd>{#if doc.pricing.pricingConfigured}<Chip tone="green">{$t('settings.priceConfigured')}</Chip>{:else}<Chip tone="orange">{$t('settings.priceNotInjected')}</Chip>{/if}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.modelsPriced')}</dt>
            <dd class="nums text-ink">{doc.pricing.modelsPriced === null ? '—' : formatInt(doc.pricing.modelsPriced)}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.modelsSeen')}</dt><dd class="nums text-ink">{formatInt(doc.pricing.modelsSeen)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.missingAPrice')}</dt>
            <dd class="min-w-0 break-words text-right">
              {#if !doc.pricing.pricingConfigured}
                <span class="text-orange">{$t('settings.allUnpriced')}</span>
              {:else if doc.pricing.missing.length}
                <span class="nums text-orange">{doc.pricing.missing.map((m) => m.model).join(', ')}</span>
              {:else}
                <span class="text-ink">{$t('settings.none')}</span>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-3">{costBasis(doc.cost.basisCode)}</p>
      </Surface>

      <Surface
        title={$t('settings.billing')}
        info={$t('settings.billingInfo')}
      >
        {#if billingError}
          <div class="mb-3"><Alert tone="red" title={$t('settings.declRejected')}>{billingError}</Alert></div>
        {/if}
        {#if billingNote}
          <div class="mb-3"><Alert tone="accent" title={$t('settings.saved')}>{$t('settings.savedNote', { values: { agent: billingNote.agent, mode: billingNote.mode } })}{billingNote.cleared ? ` ${$t('settings.clearedTail')}` : ''}</Alert></div>
        {/if}
        {#if b}
          <ul class="text-[13px]">
            {#each b.agents as a (a.agentId)}
              <li class="flex items-center justify-between gap-3 border-b border-line-soft py-2 last:border-0">
                <div class="min-w-0">
                  <span class="font-medium text-ink" title={a.agentId}>{agentLabel(a)}</span>
                  <span class="ml-2 text-xs text-ink-3">{a.declared ? $t('settings.declared') : $t('settings.defaultMode')}</span>
                </div>
                <select
                  class="h-7 shrink-0 rounded-full bg-hover-2/70 px-3 text-xs text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                  aria-label={$t('settings.billingModeAria', { values: { agent: a.agentId } })}
                  value={a.billingMode}
                  disabled={saving[a.agentId] === true}
                  onchange={(e) => void declare(a.agentId, e.currentTarget.value)}
                >
                  {#each BILLING_MODES as m (m)}
                    <option value={m}>{MODE_LABEL[m]}</option>
                  {/each}
                  <option value="">{$t('settings.notDeclared')}</option>
                </select>
              </li>
            {/each}
          </ul>
          {#if !b.agents.length}
            <p class="py-1 text-xs leading-relaxed text-ink-3">{$t('settings.noAgentsYet')}</p>
          {/if}
          <p class="mt-3 text-xs leading-relaxed text-ink-3">
            {$t('settings.savedInLead')} <span class="nums text-ink-2">{b.configFile}</span>{$t('settings.savedInMid')} <span class="nums text-ink-2">agl</span> {$t('settings.savedInTail')}
          </p>
        {:else}
          <StatePanel
            status={billing.state.status}
            error={billing.state.error}
            kind={billing.state.kind}
            since={billing.state.since}
            loadingText={$t('settings.loadingBilling')}
          />
          {#if billing.state.kind === 'not_implemented'}
            <p class="mt-3 text-xs leading-relaxed text-ink-3">
              {$t('settings.noDbLead')}
              <span class="nums text-ink-2">agl pricing billing set &lt;agent&gt; &lt;mode&gt;</span> {$t('settings.noDbTail')}
            </p>
          {/if}
        {/if}
      </Surface>

      <Surface title={$t('settings.dataSources')} info={$t('settings.dataSourcesInfo')}>
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.sourcesKnown')}</dt><dd class="nums text-ink">{formatInt(doc.coverage.sourcesKnown)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.unreachable')}</dt>
            <dd class="nums {doc.coverage.unreachable.length ? 'text-orange' : 'text-ink'}">{formatInt(doc.coverage.unreachable.length)}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">{$t('settings.dirsEmptied')}</dt>
            <dd class="nums {doc.coverage.emptyDirs.length ? 'text-orange' : 'text-ink'}">{formatInt(doc.coverage.emptyDirs.length)}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">{$t('settings.eventlessSessions')}</dt><dd class="nums text-ink">{formatInt(doc.coverage.eventlessSessions)}</dd></div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-3">{$t('banner.limits')}</p>
      </Surface>
    {:else}
      <div class="lg:col-span-2">
        <StatePanel status={doctor.state.status} error={doctor.state.error} kind={doctor.state.kind} since={doctor.state.since} loadingText={$t('settings.loadingDoctor')} />
      </div>
    {/if}
  {/if}

  <Surface title={$t('settings.appearance')}>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="min-w-0 text-xs text-ink-3">
        {$t('settings.browserOnly')}{#if theme.pref === 'system'} {$t('settings.systemFollow', { values: { resolved: theme.resolved === 'dark' ? $t('settings.resolvedDark') : $t('settings.resolvedLight') } })}{/if}
      </p>
      <Segmented
        label={$t('settings.colorTheme')}
        bind:value={() => theme.pref, pickTheme}
        options={THEME_OPTIONS}
      />
    </div>
  </Surface>
</div>

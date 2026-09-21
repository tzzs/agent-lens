<script lang="ts">
  // Settings: adapters / pricing / data sources / privacy (§10 nav). This page reads
  // no statistics of its own — it surfaces the server's self-report from /api/health
  // and /api/doctor, including the privacy-relevant facts (content layer on/off,
  // loopback-only bind, DB path) so a user can confirm the local-first guarantees.
  // Sections render as soon as their own route answers: /api/health is instant,
  // /api/doctor scans every usage row. The theme is the one setting stored here, and
  // it lives in this browser only.
  import { api, type DoctorAgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { theme, setTheme } from '../lib/theme.svelte.js'
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
  $effect(() => {
    void live.lastTick
    health.run()
    doctor.run()
  })

  const h = $derived(health.state.data)
  const doc = $derived(doctor.state.data)

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

  const STATUS_LABEL: Record<DoctorAgentRow['status'], string> = {
    ok: 'OK',
    'ingested-only': 'Ingested only',
    'not-detected': 'Not detected',
    error: 'Error',
  }
  const STATUS_TONE: Record<DoctorAgentRow['status'], 'neutral' | 'green' | 'red'> = {
    ok: 'green',
    'ingested-only': 'neutral',
    'not-detected': 'neutral',
    error: 'red',
  }
  const adapterColumns = [
    { key: 'agent', label: 'Agent', width: '22%' },
    { key: 'version', label: 'Version', width: '16%' },
    { key: 'root', label: 'Data root', width: '34%' },
    { key: 'sources', label: 'Sources', align: 'right' as const, width: '10%' },
    { key: 'status', label: 'Status', width: '18%' },
  ]

  const dlRow = 'flex items-baseline justify-between gap-4 border-b border-line-soft py-2 last:border-0'
</script>

<PageHeader
  title="Settings"
  description="Adapters, pricing, data sources and privacy, as reported by the running server."
  info="Nothing here is computed in the browser: it is the server's own report from /api/health and /api/doctor."
  refreshing={health.state.refreshing || doctor.state.refreshing}
/>

{#if refreshError}
  <div class="mb-4"><Alert tone="red" title="Refresh failed.">{refreshError} — showing the last values the server reported.</Alert></div>
{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
  {#if !h && !doc}
    <div class="lg:col-span-2">
      <StatePanel
        status={failed ? 'error' : 'loading'}
        error={failed?.error}
        kind={failed?.kind}
        since={Math.min(health.state.since, doctor.state.since)}
        loadingText="Reading the server's report"
      />
    </div>
  {:else}
    {#if h}
      <Surface title="Server">
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Name</dt><dd class="nums min-w-0 truncate text-ink" title={h.server}>{h.server}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Status</dt>
            <dd><Chip tone={h.status === 'ok' ? 'green' : 'orange'}>{h.status === 'ok' ? 'OK' : h.status}</Chip></dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Server clock</dt><dd class="nums text-ink">{formatDateTime(h.now)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Database path</dt>
            <dd class="min-w-0 break-all text-right {h.dbPath ? 'nums text-ink' : 'text-ink-2'}">{h.dbPath ?? 'In-memory (not persisted)'}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Migrations applied</dt><dd class="nums text-ink">{formatInt(h.migrationsApplied)}</dd></div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Events stored</dt><dd class="nums text-ink">{formatInt(h.events)}</dd></div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Sessions</dt><dd class="nums text-ink">{formatInt(h.sessions)}</dd></div>
        </dl>
      </Surface>

      <Surface title="Privacy & local-first">
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Loopback-only bind</dt>
            <dd>{#if h.loopbackOnly}<Chip tone="green">Yes · same-origin only</Chip>{:else}<Chip tone="red">No</Chip>{/if}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Content layer</dt>
            <dd>
              {#if h.contentAvailable}
                <Chip tone="orange">On · {formatInt(h.payloads)} payloads stored</Chip>
              {:else}
                <Chip tone="green">Off · metrics only</Chip>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-2">
          AgentLens reads private local agent logs and serves them without authentication, so the server binds to loopback
          only and this dashboard never requests anything beyond its own origin — no telemetry, no CDN, and its fonts ship
          inside the app. The content layer is off by default and stays off unless a scan opts in with
          <span class="nums text-ink">--content</span>: message and tool text is the only private content it ever copies
          into this database. Every statistic works without it.
        </p>
      </Surface>
    {:else}
      <div class="lg:col-span-2">
        <StatePanel status={health.state.status} error={health.state.error} kind={health.state.kind} since={health.state.since} loadingText="Asking the server" />
      </div>
    {/if}

    {#if doc}
      <Surface
        title="Adapters"
        subtitle={doc.adaptersInstalled ? '' : 'No adapters installed in this build — rows come from ingested history'}
        info="The CLI owns adapter wiring (§5.4). Detection is read-only; hover a status for its note."
        padded={false}
        class="lg:col-span-2"
      >
        <DataTable columns={adapterColumns} rows={doc.agents} key={(a: DoctorAgentRow) => a.id} caption="Adapters" empty="No agents detected or ingested yet">
          {#snippet row(a: DoctorAgentRow)}
            <td><span class="font-medium text-ink" title={a.id}>{a.displayName || a.id}</span></td>
            <td class="nums text-ink-2" title={a.detectedVersion ?? undefined}>{a.detectedVersion ?? '—'}</td>
            <td class="nums text-ink-2" title={a.dataRoot ?? undefined}>{a.dataRoot ?? '—'}</td>
            <td class="nums text-right text-ink">{formatInt(a.sources)}</td>
            <td>
              <Chip tone={STATUS_TONE[a.status]} dashed={a.status === 'not-detected'} title={a.note ?? ''}>{STATUS_LABEL[a.status] ?? a.status}</Chip>
            </td>
          {/snippet}
        </DataTable>
      </Surface>

      <Surface title="Pricing" info="Costs use the injected price table. An unknown price renders as n/a, never $0 (§8).">
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Price table</dt>
            <dd>{#if doc.pricing.pricingConfigured}<Chip tone="green">Configured</Chip>{:else}<Chip tone="orange">Not injected</Chip>{/if}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Models priced</dt>
            <dd class="nums text-ink">{doc.pricing.modelsPriced === null ? '—' : formatInt(doc.pricing.modelsPriced)}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Models seen</dt><dd class="nums text-ink">{formatInt(doc.pricing.modelsSeen)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Missing a price</dt>
            <dd class="min-w-0 break-words text-right">
              {#if !doc.pricing.pricingConfigured}
                <span class="text-orange">All — cost is n/a</span>
              {:else if doc.pricing.missing.length}
                <span class="nums text-orange">{doc.pricing.missing.map((m) => m.model).join(', ')}</span>
              {:else}
                <span class="text-ink">None</span>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-3">{doc.cost.basis}</p>
      </Surface>

      <Surface title="Data sources" info="Presence checks over the sources the collector has ingested — nothing here is a statistic.">
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Sources known</dt><dd class="nums text-ink">{formatInt(doc.coverage.sourcesKnown)}</dd></div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Unreachable</dt>
            <dd class="nums {doc.coverage.unreachable.length ? 'text-orange' : 'text-ink'}">{formatInt(doc.coverage.unreachable.length)}</dd>
          </div>
          <div class={dlRow}>
            <dt class="shrink-0 text-ink-3">Dirs emptied by retention</dt>
            <dd class="nums {doc.coverage.emptyDirs.length ? 'text-orange' : 'text-ink'}">{formatInt(doc.coverage.emptyDirs.length)}</dd>
          </div>
          <div class={dlRow}><dt class="shrink-0 text-ink-3">Sessions without events</dt><dd class="nums text-ink">{formatInt(doc.coverage.eventlessSessions)}</dd></div>
        </dl>
        <p class="mt-3 text-xs leading-relaxed text-ink-3">{doc.coverage.limits}</p>
      </Surface>
    {:else}
      <div class="lg:col-span-2">
        <StatePanel status={doctor.state.status} error={doctor.state.error} kind={doctor.state.kind} since={doctor.state.since} loadingText="Checking adapters, pricing and sources" />
      </div>
    {/if}
  {/if}

  <Surface title="Appearance">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="min-w-0 text-xs text-ink-3">
        Saved in this browser only.{#if theme.pref === 'system'} System follows your OS — currently {theme.resolved}.{/if}
      </p>
      <Segmented
        label="Color theme"
        bind:value={() => theme.pref, pickTheme}
        options={[
          { value: 'system', label: 'System', icon: 'monitor' },
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
        ]}
      />
    </div>
  </Surface>
</div>

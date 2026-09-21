<script lang="ts">
  // Settings: adapters / pricing / data sources / privacy (§10 nav). This page reads
  // no statistics of its own — it surfaces the server's self-report from /api/health
  // and /api/doctor, including the privacy-relevant facts (content layer on/off,
  // loopback-only bind, DB path) so a user can confirm the local-first guarantees.
  import { api } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatDateTime, formatInt } from '../lib/format.ts'
  import Card from '../components/Card.svelte'
  import StatePanel from '../components/StatePanel.svelte'

  const health = loader(() => api.health())
  const doctor = loader(() => api.doctor())
  $effect(() => {
    void live.lastTick
    health.run()
    doctor.run()
  })

  const h = $derived(health.state.status === 'ready' ? health.state.data : null)
  const doc = $derived(doctor.state.status === 'ready' ? doctor.state.data : null)

  const stat = 'flex items-center justify-between border-b border-line/40 py-1.5 text-xs last:border-0'
</script>

<div class="mb-4">
  <h1 class="text-lg font-semibold">Settings</h1>
  <p class="text-xs text-mist-500">adapters · pricing · data sources · privacy — all read from the running server</p>
</div>

{#if health.state.status !== 'ready' || doctor.state.status !== 'ready'}
  <StatePanel status={(health.state.status === 'error' || doctor.state.status === 'error') ? 'error' : 'loading'}
    error={health.state.error ?? doctor.state.error} kind={health.state.kind ?? doctor.state.kind} />
{:else}
  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Card title="Server">
      <div class={stat}><span class="text-mist-500">name</span><span class="nums text-mist-200">{h.server}</span></div>
      <div class={stat}><span class="text-mist-500">status</span><span class="text-ok">{h.status}</span></div>
      <div class={stat}><span class="text-mist-500">server clock</span><span class="nums text-mist-200">{formatDateTime(h.now)}</span></div>
      <div class={stat}><span class="text-mist-500">database path</span><span class="nums text-mist-200">{h.dbPath ?? '(in-memory)'}</span></div>
      <div class={stat}><span class="text-mist-500">migrations applied</span><span class="nums text-mist-200">{formatInt(h.migrationsApplied)}</span></div>
      <div class={stat}><span class="text-mist-500">events / sessions</span><span class="nums text-mist-200">{formatInt(h.events)} / {formatInt(h.sessions)}</span></div>
    </Card>

    <Card title="Privacy & local-first">
      <div class={stat}>
        <span class="text-mist-500">loopback-only bind</span>
        <span class={h.loopbackOnly ? 'text-ok' : 'text-danger'}>{h.loopbackOnly ? 'yes · same-origin only' : 'NO'}</span>
      </div>
      <div class={stat}>
        <span class="text-mist-500">content layer (--no-content)</span>
        <span class={h.contentAvailable ? 'text-warn' : 'text-ok'}>{h.contentAvailable ? `on · ${formatInt(h.payloads)} payloads stored` : 'off · metrics only'}</span>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-mist-500">
        AgentLens reads private local agent logs and serves them without auth, so the server binds loopback
        only and this UI makes no request beyond its own origin — no telemetry, no external fonts, no CDN.
        Turning the content layer off ({`--no-content`}) keeps every statistic but stops storing message/tool text.
      </p>
    </Card>

    <Card title="Adapters / agents" subtitle={doc.adaptersInstalled ? '' : 'no adapters installed — the CLI owns adapter wiring (§5.4)'} padded={false}>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-line text-[10px] uppercase tracking-wide text-mist-500">
            <tr><th class="px-4 py-1.5 font-medium">agent</th><th class="px-4 py-1.5 font-medium">version</th><th class="px-4 py-1.5 font-medium">data root</th><th class="px-4 py-1.5 text-right font-medium">sources</th><th class="px-4 py-1.5 font-medium">status</th></tr>
          </thead>
          <tbody>
            {#each doc.agents as a (a.id)}
              <tr class="border-b border-line/40">
                <td class="px-4 py-1.5 text-mist-100">{a.displayName || a.id}</td>
                <td class="nums px-4 py-1.5 text-mist-400">{a.detectedVersion ?? '—'}</td>
                <td class="nums px-4 py-1.5 text-mist-400">{a.dataRoot ?? '—'}</td>
                <td class="nums px-4 py-1.5 text-right">{formatInt(a.sources)}</td>
                <td class="px-4 py-1.5 {a.status === 'error' ? 'text-danger' : a.status === 'not-detected' ? 'text-mist-500' : 'text-mist-300'}">{a.status}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>

    <div class="space-y-4">
      <Card title="Pricing">
        <div class={stat}><span class="text-mist-500">price table</span><span class={doc.pricing.pricingConfigured ? 'text-ok' : 'text-warn'}>{doc.pricing.pricingConfigured ? 'configured' : 'not injected'}</span></div>
        <div class={stat}><span class="text-mist-500">models priced</span><span class="nums text-mist-200">{doc.pricing.modelsPriced === null ? '—' : formatInt(doc.pricing.modelsPriced)}</span></div>
        <div class={stat}><span class="text-mist-500">models seen</span><span class="nums text-mist-200">{formatInt(doc.pricing.modelsSeen)}</span></div>
        <div class={stat}><span class="text-mist-500">missing price</span><span class="nums {doc.pricing.missing.length ? 'text-warn' : 'text-mist-200'}">{doc.pricing.missing.length ? doc.pricing.missing.map((m: any) => m.model).join(', ') : 'none'}</span></div>
        <p class="mt-2 text-[10px] text-mist-500">{doc.cost.basis}</p>
      </Card>

      <Card title="Data sources">
        <div class={stat}><span class="text-mist-500">sources known</span><span class="nums text-mist-200">{formatInt(doc.coverage.sourcesKnown)}</span></div>
        <div class={stat}><span class="text-mist-500">unreachable</span><span class="nums {doc.coverage.unreachable.length ? 'text-warn' : 'text-mist-200'}">{formatInt(doc.coverage.unreachable.length)}</span></div>
        <div class={stat}><span class="text-mist-500">empty dirs (retention)</span><span class="nums {doc.coverage.emptyDirs.length ? 'text-warn' : 'text-mist-200'}">{formatInt(doc.coverage.emptyDirs.length)}</span></div>
        <div class={stat}><span class="text-mist-500">eventless sessions</span><span class="nums text-mist-200">{formatInt(doc.coverage.eventlessSessions)}</span></div>
        <p class="mt-2 text-[10px] leading-relaxed text-mist-500">{doc.coverage.limits}</p>
      </Card>
    </div>
  </div>
{/if}

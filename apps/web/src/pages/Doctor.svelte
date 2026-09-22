<script lang="ts">
  // GET /api/doctor (§11) — the trust report. Every block maps to the CLI's output so
  // the two ends can't disagree; the dedup line reuses event-model's fold, so the
  // "inflation avoided" number is the same one the dashboard's tokens rest on.
  // Parsing, usage quality, coverage and pricing read the whole store; capabilities
  // and cost follow the header's window (the route applies the filter to those only).
  import { api, type DoctorAgentRow } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { formatCompact, formatDateTime, formatInt } from '../lib/format.ts'
  import Surface from '../components/ui/Surface.svelte'
  import PageHeader from '../components/ui/PageHeader.svelte'
  import InsightCard from '../components/ui/InsightCard.svelte'
  import Alert from '../components/ui/Alert.svelte'
  import Chip from '../components/ui/Chip.svelte'
  import Icon from '../components/ui/Icon.svelte'
  import StatePanel from '../components/StatePanel.svelte'
  import CostFigure from '../components/CostFigure.svelte'

  const q = loader(() => api.doctor(filterParams()))
  $effect(() => {
    void range.since
    void range.agent
    void range.host
    void live.lastTick
    q.run()
  })
  const d = $derived(q.state.data)

  /*
   * §11's deeper doctor fields, declared locally: `lib/api.ts` is a frozen hand-copy of the
   * wire types, so widening the report here is the only way to show what `agl doctor` already
   * prints. Each one mirrors a CLI line, and the numbers come from the same storage-side
   * checks the CLI calls, so the two ends cannot disagree (§14).
   */
  type FoldMode = 'request_max' | 'per_record_sum' | 'last_call_sum'
  interface Policy {
    mode: FoldMode
    subagentsIncluded: boolean
  }
  interface PerAgentQuality {
    agentId: string
    events: number
    reported: number
    estimated: number
    missing: number
    noRequestId: number
    noRequestIdWithUsage: number
    usageRows: number
    naive: number
    folded: number
    modelFolded: number
    globalFolded: number
    groups: number
    policy: Policy
    policySource: 'persisted' | 'default'
    declared: Policy | null
    agrees: boolean
  }
  interface DoctorDepth {
    parsing: { parserDrift?: { checked: number; drifted: number; unmapped: number; unscanned: number; stale: { agentId: string; parserVersion: number; sources: number }[] } }
    usageQuality: { modes?: FoldMode[]; perAgent?: PerAgentQuality[] }
    subagents?: { agentId: string; total: number; orphan: number; orphanPct: number }[]
    guessedTimestamps?: { agentId: string; events: number; guessed: number; guessedPct: number; fromIngestClock: number; fromFileMtime: number }[]
    retention?: { gone: number; rotated: number; active: number }
    /** §11/§19: storage's own sentence about the materialised stage 1, printed verbatim (§14). */
    stageOneFold?: { ok: boolean; text: string }
  }
  const depth = $derived(d as unknown as DoctorDepth | undefined)
  const perAgent = $derived(depth?.usageQuality.perAgent ?? [])
  const foldModes = $derived(depth?.usageQuality.modes ?? [])
  const drift = $derived(depth?.parsing.parserDrift ?? null)
  const subagents = $derived(depth?.subagents ?? [])
  const guessedTimestamps = $derived(depth?.guessedTimestamps ?? [])
  const retention = $derived(depth?.retention ?? null)
  const stageOne = $derived(depth?.stageOneFold ?? null)
  const share = (n: number, total: number): string => (total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`)
  /** The CLI's own wording for the fold rule, so both reports say the same thing (§14). */
  function foldSentence(a: PerAgentQuality): string {
    return a.policy.mode === 'request_max'
      ? `request_id dedup ${a.naive > a.folded ? 'active' : 'not needed'}: raw sum ${formatCompact(a.naive)} → ` +
        `${formatCompact(a.folded)} tokens · ${formatInt(a.groups)} folded groups from ${formatInt(a.usageRows)} usage rows`
      : `no request_id dedup: raw sum ${formatCompact(a.naive)} = ${formatCompact(a.folded)} · ` +
        `${formatInt(a.usageRows)} usage rows summed once each`
  }
  const foldTone = (a: PerAgentQuality): 'green' | 'neutral' => (a.policy.mode === 'request_max' && a.naive > a.folded ? 'green' : 'neutral')

  // Agent status in words, never a bare glyph or colour.
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

  const agentsOk = $derived(d ? d.agents.filter((a) => a.status === 'ok').length : 0)
  // "1 error · 2 ingested only" for the summary tile; empty when every agent is OK.
  const agentIssues = $derived(
    d
      ? (['error', 'not-detected', 'ingested-only'] as const)
          .map((s) => [s, d.agents.filter((a) => a.status === s).length] as const)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${formatInt(n)} ${STATUS_LABEL[s].toLowerCase()}`)
          .join(' · ')
      : '',
  )

  const figure = 'nums text-[22px] font-semibold tracking-tight'
  const dlRow = 'flex items-baseline justify-between gap-4 border-b border-line-soft py-1.5 last:border-0'
</script>

<PageHeader
  title="Doctor"
  description="Can you trust these numbers? Parsing, coverage, pricing and permissions checks."
  info="The same report agl doctor prints (§11). Parsing, usage quality, coverage and pricing cover the whole store; capabilities and cost follow the selected window."
  refreshing={q.state.refreshing}
>
  {#snippet actions()}
    {#if d}<span class="nums text-xs text-ink-3" title={new Date(d.generatedAt).toISOString()}>Generated {formatDateTime(d.generatedAt)}</span>{/if}
  {/snippet}
</PageHeader>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText="Running diagnostics" />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title="Refresh failed.">{q.state.error} — showing the last good report.</Alert></div>
  {/if}

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <InsightCard label="Agents" info="OK means an adapter in this build detected the agent on this machine. Ingested-only agents keep their history but have no adapter here.">
      <div class="flex items-baseline gap-1.5">
        <span class={figure}>{formatInt(agentsOk)}</span>
        <span class="text-[13px] text-ink-3">of <span class="nums">{formatInt(d.agents.length)}</span> OK</span>
      </div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">{agentIssues || (d.agents.length ? 'Every agent detected' : 'No agents known yet')}</p>
      {/snippet}
    </InsightCard>

    <InsightCard label="Parse errors" info="Raw records that failed to parse, as a share of everything read, across the whole store.">
      <div class="{figure} {d.parsing.parseErrors ? 'text-orange' : ''}">{d.parsing.parseErrorPct.toFixed(2)}%</div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">
          <span class="nums">{formatInt(d.parsing.parseErrors)}</span> failed · <span class="nums">{formatInt(d.parsing.events)}</span> events parsed
        </p>
      {/snippet}
    </InsightCard>

    <InsightCard label="Dedup inflation avoided" info="Each agent's tokens are folded under the policy persisted with its own rows (§18 row 2) — request_max folds per request_id, the others never deduplicate. This is how much a raw per-record sum would have over-counted.">
      <div class={figure}>{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</div>
      {#snippet detail()}
        {#if d.usageQuality.dedupActive}
          <p class="text-xs text-ink-3">
            Raw <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> → <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> tokens after each agent's own fold
          </p>
        {:else}
          <p class="text-xs text-ink-3">No request_id duplication observed</p>
        {/if}
      {/snippet}
    </InsightCard>

    <InsightCard label="Models missing a price" info="A model without a price shows its cost as n/a — never $0 (§8).">
      {#if d.pricing.pricingConfigured}
        <div class="{figure} {d.pricing.missing.length ? 'text-orange' : ''}">{formatInt(d.pricing.missing.length)}</div>
      {:else}
        <div class="text-[22px] font-semibold tracking-tight text-orange">All</div>
      {/if}
      {#snippet detail()}
        {#if !d.pricing.pricingConfigured}
          <p class="text-xs text-ink-3">No price table injected — all cost is n/a</p>
        {:else if d.pricing.missing.length}
          <p class="text-xs text-ink-3">Of <span class="nums">{formatInt(d.pricing.modelsSeen)}</span> models seen — their cost is n/a</p>
        {:else}
          <p class="text-xs text-ink-3">Every model seen has a price</p>
        {/if}
      {/snippet}
    </InsightCard>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Surface
      title="Agents"
      subtitle={d.adaptersInstalled ? '' : 'No adapters installed in this build'}
      info="Detection is read-only. An agent without an adapter in this build still shows its ingested history."
      padded={false}
    >
      {#if d.agents.length}
        <ul>
          {#each d.agents as a (a.id)}
            <li class="flex items-start gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-[13px] font-medium text-ink" title={a.id}>{a.displayName || a.id}</span>
                  <Chip tone={STATUS_TONE[a.status]} dashed={a.status === 'not-detected'}>{STATUS_LABEL[a.status] ?? a.status}</Chip>
                </div>
                <div class="nums mt-0.5 truncate text-xs text-ink-3" title="{a.detectedVersion ?? '—'} · {a.dataRoot ?? '—'}">
                  {a.detectedVersion ?? '—'} · {a.dataRoot ?? '—'}
                </div>
                {#if a.note}<p class="mt-1 text-xs {a.status === 'error' ? 'text-red' : 'text-ink-2'}">{a.note}</p>{/if}
              </div>
              <div class="shrink-0 text-right text-xs leading-5 text-ink-3">
                <div><span class="nums text-[13px] text-ink">{formatInt(a.events)}</span> events</div>
                <div><span class="nums text-ink-2">{formatInt(a.sources)}</span> sources</div>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-4 py-8 text-center text-[13px] text-ink-3">No agents detected or ingested yet.</p>
      {/if}
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Parsing" info="Across the whole store, not only the selected window.">
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">Events parsed</dt><dd class="nums text-ink">{formatInt(d.parsing.events)}</dd></div>
          <div class={dlRow}>
            <dt class="text-ink-3">Parse errors</dt>
            <dd class="nums {d.parsing.parseErrors ? 'text-orange' : 'text-ink'}">
              {formatInt(d.parsing.parseErrors)} <span class="text-ink-3">({d.parsing.parseErrorPct.toFixed(2)}%)</span>
            </dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">Unknown event types</dt><dd class="nums text-ink">{formatInt(d.parsing.unknownTypes)}</dd></div>
        </dl>
        {#if drift}
          {#if drift.checked === 0}
            <p class="mt-3 text-xs text-ink-3">
              Parser-version drift can't be evaluated — <span class="nums">{formatInt(drift.unmapped)}</span> source(s) belong to
              agents with no adapter in this build, <span class="nums">{formatInt(drift.unscanned)}</span> carry no version yet.
            </p>
          {:else if drift.drifted > 0}
            <p class="mt-3 text-xs text-orange">
              <span class="nums">{formatInt(drift.drifted)}</span> of <span class="nums">{formatInt(drift.checked)}</span> sources
              carry a stale parser_version — the next scan re-reads them in full (§5.3).
            </p>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              {#each drift.stale as s, i (i)}
                <Chip mono title="{s.agentId}: {formatInt(s.sources)} source(s) stored by parser v{formatInt(s.parserVersion)}">{s.agentId} v{formatInt(s.parserVersion)}</Chip>
              {/each}
            </div>
          {:else}
            <p class="mt-3 text-xs text-ink-2">
              <Chip tone="green">Parser current</Chip> <span class="nums">{formatInt(drift.checked)}</span> source(s) match their
              adapter's parser version{drift.unscanned ? ` · ${formatInt(drift.unscanned)} not yet scanned` : ''}.
            </p>
          {/if}
          {#if drift.unmapped > 0 && drift.checked > 0}
            <p class="mt-1.5 text-xs text-ink-3"><span class="nums">{formatInt(drift.unmapped)}</span> further source(s) belong to agents with no adapter here — drift unknowable for them.</p>
          {/if}
        {/if}
      </Surface>

      <Surface
        title="Usage quality"
        subtitle="Events by where their token usage came from"
        info="Reported: the agent logged its own usage. Estimated: usage was derived. Missing: none recorded. Across the whole store."
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">Reported by the agent</dt><dd class="nums text-ink">{formatInt(d.usageQuality.reported)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Estimated</dt><dd class="nums text-ink">{formatInt(d.usageQuality.estimated)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Missing</dt><dd class="nums text-ink">{formatInt(d.usageQuality.missing)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">Without a request_id</dt><dd class="nums text-ink">{formatInt(d.usageQuality.withoutRequestId)}</dd></div>
        </dl>
        {#if d.usageQuality.dedupActive}
          <p class="mt-3 flex items-start gap-2 rounded-lg bg-green-tint px-3 py-2 text-[13px] text-green">
            <Icon name="check" size={14} class="mt-0.5" />
            <span>
              request_id dedup active: raw <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> →
              <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> tokens
              (<span class="nums">{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</span> inflation avoided)
            </span>
          </p>
        {:else}
          <p class="mt-3 text-xs text-ink-3">No request_id duplication observed in this data.</p>
        {/if}
        {#if foldModes.length > 1}
          <div class="mt-3">
            <Alert tone="orange" title="Mixed folds in one database —">
              <span class="nums">{foldModes.join(', ')}</span>: every figure below is that agent's own fold. No global rule was
              applied, and none would be correct (§18 row 2).
            </Alert>
          </div>
        {/if}
        {#if perAgent.length}
          <ul class="mt-3 divide-y divide-line-soft border-t border-line-soft">
            {#each perAgent as a (a.agentId)}
              <li class="py-2">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-[13px] font-medium text-ink" title={a.agentId}>{a.agentId}</span>
                  <Chip tone={foldTone(a)} title="The fold persisted with this agent's stored rows">{a.policy.mode}</Chip>
                  <Chip tone="neutral" dashed={!a.policy.subagentsIncluded}>
                    {a.policy.subagentsIncluded ? 'subagents counted' : 'subagents excluded'}
                  </Chip>
                  {#if a.policySource === 'default'}
                    <Chip tone="orange" title="No policy was persisted for this agent, so the cube's most conservative default applied">defaulted</Chip>
                  {/if}
                </div>
                <div class="nums mt-0.5 text-xs text-ink-3">
                  reported {share(a.reported, a.events)} · estimated {share(a.estimated, a.events)} · missing {share(a.missing, a.events)}
                  {#if a.noRequestId > 0}
                    · <span title="Records the per-request fallback key had to cover, counted individually">{formatInt(a.noRequestId)} without a request_id{a.noRequestIdWithUsage > 0 ? ` (${formatInt(a.noRequestIdWithUsage)} with usage)` : ''}</span>
                  {/if}
                </div>
                <div class="mt-0.5 text-xs {a.agrees ? 'text-ink-2' : 'text-red'}">{foldSentence(a)}</div>
                {#if !a.agrees}
                  <p class="mt-1 text-xs text-red">
                    Cube and event-model disagree for this agent (<span class="nums">{formatCompact(a.folded)}</span> vs
                    <span class="nums">{formatCompact(a.modelFolded)}</span>) — one path is wrong, so every token and cost figure for
                    it is untrustworthy until they match.
                  </p>
                {/if}
                {#if a.policy.mode !== 'request_max' && a.globalFolded !== a.folded}
                  <p class="mt-1 text-xs text-orange">
                    This agent declares {a.policy.mode}: one global request_max would have reported
                    <span class="nums">{formatCompact(a.globalFolded)}</span> instead of <span class="nums">{formatCompact(a.folded)}</span> (§18 row 2).
                  </p>
                {/if}
                {#if a.declared && (a.declared.mode !== a.policy.mode || a.declared.subagentsIncluded !== a.policy.subagentsIncluded)}
                  <p class="mt-1 text-xs text-orange">
                    Its installed adapter now declares <span class="nums">{a.declared.mode}</span>{a.declared.subagentsIncluded ? '' : ' with subagents excluded'},
                    but the stored rows are folded <span class="nums">{a.policy.mode}</span>{a.policy.subagentsIncluded ? '' : ' with subagents excluded'} —
                    the figures describe the rows, not the next scan.
                  </p>
                {/if}
                {#if !a.declared}
                  <p class="mt-1 text-xs text-ink-3">No adapter in this build declares a policy for it — nothing above is a claim about the next scan.</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Surface>
    </div>

    <Surface
      title="Coverage"
      info="Upstream tools can delete old session files while their folder stays, so a scan can look complete while being partial. These are presence checks, not statistics."
    >
      <div class="space-y-3">
        {#if d.coverage.banner}
          <Alert tone="orange" title="Incomplete history.">{d.coverage.banner}</Alert>
        {:else if d.coverage.incomplete}
          <Alert tone="orange" title="History may be incomplete.">
            {formatInt(d.coverage.unreachable.length)} ingested source{d.coverage.unreachable.length === 1 ? '' : 's'} can't be read right now.
          </Alert>
        {:else}
          <p class="flex items-center gap-2 text-[13px] text-ink-2"><Chip tone="green">Complete</Chip>History looks complete for ingested sources.</p>
        {/if}

        {#if d.coverage.emptyDirs.length}
          <div>
            <h4 class="mb-1 text-xs font-medium text-ink-3">Source dirs whose session files are gone</h4>
            <ul class="max-h-40 overflow-y-auto text-xs">
              {#each d.coverage.emptyDirs as e (e.dir)}
                <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                  <span class="nums min-w-0 truncate text-ink-2" title={e.dir}>{e.dir}</span>
                  <span class="shrink-0 text-ink-3"><span class="nums">{formatInt(e.missingSources)}</span> missing · {e.agentIds.join(', ')}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if d.coverage.projectDirsWithoutSessions.length}
          <div>
            <h4 class="mb-1.5 text-xs font-medium text-ink-3">Project dirs with no sessions left</h4>
            <div class="flex flex-wrap gap-1.5">
              {#each d.coverage.projectDirsWithoutSessions as p, i (i)}
                <Chip mono title={p.root}>{p.project}</Chip>
              {/each}
            </div>
          </div>
        {/if}

        {#if retention}
          <div class="border-t border-line-soft pt-3">
            {#if retention.gone + retention.rotated > 0}
              <p class="text-xs text-orange">
                <span class="nums">{formatInt(retention.gone + retention.rotated)}</span> known source(s) no longer readable
                (gone <span class="nums">{formatInt(retention.gone)}</span> · rotated
                <span class="nums">{formatInt(retention.rotated)}</span>) — the events already ingested from them stay, nothing new
                can arrive.
              </p>
            {/if}
            <p class="{retention.gone + retention.rotated > 0 ? 'mt-1 ' : ''}text-xs text-ink-3">
              <span class="nums">{formatInt(retention.active)}</span> source(s) read to their end · coverage stops where upstream
              retention stops (§4.4 row 4).
            </p>
          </div>
        {/if}

        <p class="border-t border-line-soft pt-3 text-xs text-ink-3">{d.coverage.limits}</p>
      </div>
    </Surface>

    <Surface
      title="Subagent links"
      info="§4.4 row 8: a subagent event is attached to the nearest preceding parent call by time, with no foreign key behind it, so some links cannot be resolved."
    >
      {#if subagents.length === 0}
        <p class="text-[13px] text-ink-3">No subagent events ingested — the link heuristic is untested on this data.</p>
      {:else}
        <dl class="text-[13px]">
          {#each subagents as s (s.agentId)}
            <div class={dlRow}>
              <dt class="min-w-0 truncate text-ink-2" title={s.agentId}>{s.agentId}</dt>
              <dd class="nums shrink-0 {s.orphan > 0 ? 'text-orange' : 'text-ink'}">
                {formatInt(s.orphan)} of {formatInt(s.total)} unlinked <span class="text-ink-3">({s.orphanPct.toFixed(1)}%)</span>
              </dd>
            </div>
          {/each}
        </dl>
        {#if subagents.some((s) => s.orphan > 0)}
          <p class="mt-3 text-xs text-ink-3">
            Their tokens and cost ARE counted; only the timeline's tree placement is unknown.
          </p>
        {/if}
      {/if}
    </Surface>

    <Surface
      title="Materialised stage 1"
      info="§19: the per-request fold is stored in its own table so the cube stops folding every event on each read. No foreign key ties that table to `events`, so whether it still agrees is a fact worth printing."
    >
      {#if stageOne}
        <p class="text-[13px] {stageOne.ok ? 'text-ink' : 'text-orange'}">{stageOne.text}</p>
        {#if !stageOne.ok}
          <p class="mt-2 text-xs text-ink-3">
            The figures stay right either way: a table that drifted or was folded under another
            policy is declined, and the read folds from <code>events</code> again — this costs speed, not correctness.
          </p>
        {/if}
      {:else}
        <p class="text-[13px] text-ink-3">This server build reported no stage-1 health.</p>
      {/if}
    </Surface>

    <Surface
      title="Invented timestamps"
      info="§5.2: an event whose source stated no time gets one anyway — the source file's last write, or the instant the scan ran. The rows are real activity; only their date is a stand-in."
    >
      {#if guessedTimestamps.length === 0}
        <p class="text-[13px] text-ink-3">Every ingested event carries a timestamp its source stated (§5.2).</p>
      {:else}
        <dl class="text-[13px]">
          {#each guessedTimestamps as g (g.agentId)}
            <div class={dlRow}>
              <dt class="min-w-0 truncate text-ink-2" title={g.agentId}>{g.agentId}</dt>
              <dd class="nums shrink-0 text-orange">
                {formatInt(g.guessed)} of {formatInt(g.events)} guessed
                <span class="text-ink-3">({share(g.guessed, g.events)})</span>
              </dd>
            </div>
          {/each}
        </dl>
        <p class="mt-3 text-xs text-ink-3">
          Time-windowed numbers — <span class="nums">--since</span>, this page's window — include these rows whatever their real
          date is. <span class="nums">{formatInt(guessedTimestamps.reduce((n, g) => n + g.fromIngestClock, 0))}</span> are dated by
          the scan clock, which bounds nothing;
          <span class="nums">{formatInt(guessedTimestamps.reduce((n, g) => n + g.fromFileMtime, 0))}</span> by the source file's
          last write, which does (§19).
        </p>
      {/if}
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Capabilities" subtitle="In the selected window">
        {#if d.capabilities.length === 0}
          <p class="text-[13px] text-ink-3">No capability events in this window.</p>
        {:else}
          <dl class="text-[13px]">
            {#each d.capabilities as c (c.type)}
              <div class={dlRow}>
                <dt class="text-ink-2">{c.type}</dt>
                <dd class="nums text-ink">
                  {formatInt(c.events)}{#if c.errors}<span class="text-red"> · {formatInt(c.errors)} errors</span>{/if}
                </dd>
              </div>
            {/each}
          </dl>
        {/if}
        <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">
          Catalog: {d.catalog.available ? `${formatInt(d.catalog.installed)} installed · ${formatInt(d.catalog.neverUsed)} never used` : d.catalog.note}
        </p>
      </Surface>

      <Surface title="Pricing" info="Costs use the injected price table. A model without a price shows cost as n/a — never $0 (§8)." class="flex-1">
        {#if d.pricing.pricingConfigured}
          <dl class="text-[13px]">
            <div class={dlRow}>
              <dt class="text-ink-3">Models priced</dt>
              <dd class="nums text-ink">{d.pricing.modelsPriced === null ? '—' : formatInt(d.pricing.modelsPriced)}</dd>
            </div>
            <div class={dlRow}><dt class="text-ink-3">Models seen</dt><dd class="nums text-ink">{formatInt(d.pricing.modelsSeen)}</dd></div>
          </dl>
          {#if d.pricing.missing.length}
            <div class="mt-3">
              <Alert tone="orange" title="{formatInt(d.pricing.missing.length)} missing a price — cost n/a:">
                <span class="nums">{d.pricing.missing.map((m) => m.model).join(', ')}</span>
              </Alert>
            </div>
          {/if}
        {:else}
          <Alert tone="orange" title="No price table injected —">all cost is n/a, never shown as $0.</Alert>
        {/if}
      </Surface>
    </div>

    <Surface title="Cost" subtitle="In the selected window">
      <dl class="text-[13px]">
        <div class={dlRow}>
          <dt class="text-ink-3">Actual, reported where known</dt>
          <dd><CostFigure value={d.cost.totalUsd} basis="actual" partial={d.cost.totalPartial} /></dd>
        </div>
        <div class={dlRow}>
          <dt class="text-ink-3">API-equivalent estimate</dt>
          <dd><CostFigure value={d.cost.apiEquivalentUsd} basis="est" partial={d.cost.apiEquivalentPartial} /></dd>
        </div>
        {#if d.cost.reportedUsd !== null}
          <div class={dlRow}>
            <dt class="text-ink-3">Reported by agents</dt>
            <dd><CostFigure value={d.cost.reportedUsd} basis="reported" /></dd>
          </div>
        {/if}
      </dl>
      {#if d.cost.unpricedAgents.length}
        <p class="mt-3 text-xs text-orange">No price for {d.cost.unpricedAgents.join(', ')} — the totals above are a floor.</p>
      {/if}
      <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">{d.cost.basis}</p>
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title="Permissions" info="Whether this process can read each detected agent's data root.">
        {#if d.permissions.length}
          <ul>
            {#each d.permissions as p, i (i)}
              <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                <span class="nums min-w-0 truncate text-xs text-ink-2" title={p.path}>{p.path}</span>
                {#if p.readable}<Chip tone="green">Readable</Chip>{:else}<Chip tone="red">Unreadable</Chip>{/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-[13px] text-ink-3">Nothing to report — no agent data roots were detected.</p>
        {/if}
      </Surface>

      <Surface
        title="Content layer"
        info="An optional copy of message and tool text, made only when a scan runs with --content. Statistics never depend on it."
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="text-ink-3">Status</dt>
            <dd>{#if d.content.available}<Chip tone="orange">On</Chip>{:else}<Chip tone="green">Off · metrics only</Chip>{/if}</dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">Payloads stored</dt><dd class="nums text-ink">{formatInt(d.content.payloads)}</dd></div>
        </dl>
        <p class="mt-3 text-xs text-ink-3">{d.content.note}</p>
      </Surface>
    </div>
  </div>
{/if}

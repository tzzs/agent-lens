<script lang="ts">
  // GET /api/doctor (§11) — the trust report. Every block maps to the CLI's output so
  // the two ends can't disagree; the dedup line reuses event-model's fold, so the
  // "inflation avoided" number is the same one the dashboard's tokens rest on.
  // Parsing, usage quality, coverage and pricing read the whole store; capabilities
  // and cost follow the header's window (the route applies the filter to those only).
  import { api, type DoctorAgentRow, type StageOneCode } from '../lib/api.ts'
  import { loader } from '../lib/pagestate.svelte.js'
  import { range, filterParams } from '../lib/filter.svelte.js'
  import { live } from '../lib/live.svelte.js'
  import { agentNote, catalogNote, contentNote, costBasis, stageOneNote } from '../lib/notes.ts'
  import { t } from '../lib/lang.js'
  import { coverageText } from '../lib/banners.ts'
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
    /** §11/§19: the stage-1 verdict and its counts; the sentence is the viewer's. */
    stageOneFold?: { ok: boolean; code: StageOneCode; rows: number; members: number; events: number }
  }
  const depth = $derived(d as unknown as DoctorDepth | undefined)
  const perAgent = $derived(depth?.usageQuality.perAgent ?? [])
  const foldModes = $derived(depth?.usageQuality.modes ?? [])
  const drift = $derived(depth?.parsing.parserDrift ?? null)
  const subagents = $derived(depth?.subagents ?? [])
  const guessedTimestamps = $derived(depth?.guessedTimestamps ?? [])
  const retention = $derived(depth?.retention ?? null)
  // The §14 coverage banner, worded here from the same structured fields the
  // overview header uses — the server's `coverage.banner` is one English sentence.
  const coverageLine = $derived(d ? coverageText(d.coverage) : '')
  const stageOne = $derived(depth?.stageOneFold ?? null)
  const share = (n: number, total: number): string => (total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`)
  /** The CLI's own wording for the fold rule, so both reports say the same thing (§14). */
  function foldSentence(a: PerAgentQuality): string {
    return a.policy.mode === 'request_max'
      ? $t('doctor.foldActive', {
          values: {
            state: $t(a.naive > a.folded ? 'doctor.dedupStateActive' : 'doctor.dedupStateNotNeeded'),
            naive: formatCompact(a.naive),
            folded: formatCompact(a.folded),
            groups: formatInt(a.groups),
            rows: formatInt(a.usageRows),
          },
        })
      : $t('doctor.foldNone', {
          values: {
            naive: formatCompact(a.naive),
            folded: formatCompact(a.folded),
            rows: formatInt(a.usageRows),
          },
        })
  }
  const foldTone = (a: PerAgentQuality): 'green' | 'neutral' => (a.policy.mode === 'request_max' && a.naive > a.folded ? 'green' : 'neutral')

  // Agent status in words, never a bare glyph or colour.
  const STATUS_LABEL: Record<DoctorAgentRow['status'], string> = $derived({
    ok: $t('doctor.statusOk'),
    'ingested-only': $t('doctor.statusIngestedOnly'),
    'not-detected': $t('doctor.statusNotDetected'),
    error: $t('doctor.statusError'),
  })
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
  title={$t('doctor.title')}
  description={$t('doctor.pageDesc')}
  info={$t('doctor.pageInfo')}
  refreshing={q.state.refreshing}
>
  {#snippet actions()}
    {#if d}<span class="nums text-xs text-ink-3" title={new Date(d.generatedAt).toISOString()}>{$t('doctor.generated', { values: { at: formatDateTime(d.generatedAt) } })}</span>{/if}
  {/snippet}
</PageHeader>

{#if !d}
  <StatePanel status={q.state.status} error={q.state.error} kind={q.state.kind} since={q.state.since} loadingText={$t('doctor.loading')} />
{:else}
  {#if q.state.status === 'error'}
    <div class="mb-4"><Alert tone="red" title={$t('states.refreshFailed')}>{q.state.error} — {$t('doctor.showingLastReport')}</Alert></div>
  {/if}

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <InsightCard label={$t('doctor.agentsTile')} info={$t('doctor.agentsTileInfo')}>
      <div class="flex items-baseline gap-1.5">
        <span class={figure}>{formatInt(agentsOk)}</span>
        <span class="text-[13px] text-ink-3">{$t('doctor.agentsOf')} <span class="nums">{formatInt(d.agents.length)}</span> {$t('doctor.agentsOfTail')}</span>
      </div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">{agentIssues || (d.agents.length ? $t('doctor.everyAgentDetected') : $t('doctor.noAgentsKnown'))}</p>
      {/snippet}
    </InsightCard>

    <InsightCard label={$t('doctor.parseErrorsTile')} info={$t('doctor.parseErrorsTileInfo')}>
      <div class="{figure} {d.parsing.parseErrors ? 'text-orange' : ''}">{d.parsing.parseErrorPct.toFixed(2)}%</div>
      {#snippet detail()}
        <p class="text-xs text-ink-3">
          <span class="nums">{formatInt(d.parsing.parseErrors)}</span> {$t('doctor.failedMid')} <span class="nums">{formatInt(d.parsing.events)}</span> {$t('doctor.eventsParsedTail')}
        </p>
      {/snippet}
    </InsightCard>

    <InsightCard label={$t('doctor.dedupTile')} info={$t('doctor.dedupTileInfo')}>
      <div class={figure}>{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</div>
      {#snippet detail()}
        {#if d.usageQuality.dedupActive}
          <p class="text-xs text-ink-3">
            {$t('doctor.rawLead')} <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> → <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> {$t('doctor.tokensAfterFold')}
          </p>
        {:else}
          <p class="text-xs text-ink-3">{$t('doctor.noDuplication')}</p>
        {/if}
      {/snippet}
    </InsightCard>

    <InsightCard label={$t('doctor.missingPriceTile')} info={$t('doctor.missingPriceTileInfo')}>
      {#if d.pricing.pricingConfigured}
        <div class="{figure} {d.pricing.missing.length ? 'text-orange' : ''}">{formatInt(d.pricing.missing.length)}</div>
      {:else}
        <div class="text-[22px] font-semibold tracking-tight text-orange">{$t('doctor.allModels')}</div>
      {/if}
      {#snippet detail()}
        {#if !d.pricing.pricingConfigured}
          <p class="text-xs text-ink-3">{$t('doctor.noPriceTableDetail')}</p>
        {:else if d.pricing.missing.length}
          <p class="text-xs text-ink-3">{$t('doctor.modelsSeenLead')} <span class="nums">{formatInt(d.pricing.modelsSeen)}</span> {$t('doctor.modelsSeenTail')}</p>
        {:else}
          <p class="text-xs text-ink-3">{$t('doctor.everyModelPriced')}</p>
        {/if}
      {/snippet}
    </InsightCard>
  </div>

  <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <Surface
      title={$t('doctor.agentsSurface')}
      subtitle={d.adaptersInstalled ? '' : $t('doctor.noAdapters')}
      info={$t('doctor.agentsSurfaceInfo')}
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
                {#if a.noteCode}<p class="mt-1 text-xs {a.status === 'error' ? 'text-red' : 'text-ink-2'}">{agentNote(a.noteCode, a.noteDetail)}</p>{/if}
              </div>
              <div class="shrink-0 text-right text-xs leading-5 text-ink-3">
                <div><span class="nums text-[13px] text-ink">{formatInt(a.events)}</span> {$t('doctor.eventsUnit')}</div>
                <div><span class="nums text-ink-2">{formatInt(a.sources)}</span> {$t('doctor.sourcesUnit')}</div>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-4 py-8 text-center text-[13px] text-ink-3">{$t('doctor.noAgentsAtAll')}</p>
      {/if}
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title={$t('doctor.parsing')} info={$t('doctor.parsingInfo')}>
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.eventsParsed')}</dt><dd class="nums text-ink">{formatInt(d.parsing.events)}</dd></div>
          <div class={dlRow}>
            <dt class="text-ink-3">{$t('doctor.parseErrors')}</dt>
            <dd class="nums {d.parsing.parseErrors ? 'text-orange' : 'text-ink'}">
              {formatInt(d.parsing.parseErrors)} <span class="text-ink-3">({d.parsing.parseErrorPct.toFixed(2)}%)</span>
            </dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.unknownTypes')}</dt><dd class="nums text-ink">{formatInt(d.parsing.unknownTypes)}</dd></div>
        </dl>
        {#if drift}
          {#if drift.checked === 0}
            <p class="mt-3 text-xs text-ink-3">
              {$t('doctor.driftNoEval')} <span class="nums">{formatInt(drift.unmapped)}</span> {$t('doctor.driftNoEvalMid')}
              <span class="nums">{formatInt(drift.unscanned)}</span> {$t('doctor.driftNoEvalTail')}
            </p>
          {:else if drift.drifted > 0}
            <p class="mt-3 text-xs text-orange">
              <span class="nums">{formatInt(drift.drifted)}</span> {$t('doctor.driftStaleOf')} <span class="nums">{formatInt(drift.checked)}</span> {$t('doctor.driftStaleTail')}
            </p>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              {#each drift.stale as s, i (i)}
                <Chip mono title={$t('doctor.staleChipTitle', { values: { agent: s.agentId, sources: formatInt(s.sources), version: `v${formatInt(s.parserVersion)}` } })}>{s.agentId} v{formatInt(s.parserVersion)}</Chip>
              {/each}
            </div>
          {:else}
            <p class="mt-3 text-xs text-ink-2">
              <Chip tone="green">{$t('doctor.parserCurrent')}</Chip> <span class="nums">{formatInt(drift.checked)}</span> {$t('doctor.sourcesMatch', { values: { extra: drift.unscanned ? $t('doctor.unscannedTail', { values: { n: formatInt(drift.unscanned) } }) : '' } })}
            </p>
          {/if}
          {#if drift.unmapped > 0 && drift.checked > 0}
            <p class="mt-1.5 text-xs text-ink-3"><span class="nums">{formatInt(drift.unmapped)}</span> {$t('doctor.furtherUnmapped')}</p>
          {/if}
        {/if}
      </Surface>

      <Surface
        title={$t('doctor.usageQuality')}
        subtitle={$t('doctor.usageQualitySubtitle')}
        info={$t('doctor.usageQualityInfo')}
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.reportedByAgent')}</dt><dd class="nums text-ink">{formatInt(d.usageQuality.reported)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.estimated')}</dt><dd class="nums text-ink">{formatInt(d.usageQuality.estimated)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.missing')}</dt><dd class="nums text-ink">{formatInt(d.usageQuality.missing)}</dd></div>
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.withoutRequestId')}</dt><dd class="nums text-ink">{formatInt(d.usageQuality.withoutRequestId)}</dd></div>
        </dl>
        {#if d.usageQuality.dedupActive}
          <p class="mt-3 flex items-start gap-2 rounded-lg bg-green-tint px-3 py-2 text-[13px] text-green">
            <Icon name="check" size={14} class="mt-0.5" />
            <span>
              {$t('doctor.dedupActiveLead')} <span class="nums">{formatCompact(d.usageQuality.naiveTokens)}</span> →
              <span class="nums">{formatCompact(d.usageQuality.dedupedTokens)}</span> {$t('doctor.tokensWord')}
              (<span class="nums">{d.usageQuality.inflationAvoidedPct.toFixed(1)}%</span> {$t('doctor.inflationAvoided')})
            </span>
          </p>
        {:else}
          <p class="mt-3 text-xs text-ink-3">{$t('doctor.noDupInData')}</p>
        {/if}
        {#if foldModes.length > 1}
          <div class="mt-3">
            <Alert tone="orange" title={$t('doctor.mixedFoldsTitle')}>
              <span class="nums">{foldModes.join(', ')}</span>{$t('doctor.mixedFoldsBody')}
            </Alert>
          </div>
        {/if}
        {#if perAgent.length}
          <ul class="mt-3 divide-y divide-line-soft border-t border-line-soft">
            {#each perAgent as a (a.agentId)}
              <li class="py-2">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-[13px] font-medium text-ink" title={a.agentId}>{a.agentId}</span>
                  <Chip tone={foldTone(a)} title={$t('doctor.foldChipTitle')}>{a.policy.mode}</Chip>
                  <Chip tone="neutral" dashed={!a.policy.subagentsIncluded}>
                    {a.policy.subagentsIncluded ? $t('doctor.subagentsCounted') : $t('doctor.subagentsExcluded')}
                  </Chip>
                  {#if a.policySource === 'default'}
                    <Chip tone="orange" title={$t('doctor.defaultedTitle')}>{$t('doctor.defaulted')}</Chip>
                  {/if}
                </div>
                <div class="nums mt-0.5 text-xs text-ink-3">
                  {$t('doctor.usageShares', { values: { r: share(a.reported, a.events), e: share(a.estimated, a.events), m: share(a.missing, a.events) } })}
                  {#if a.noRequestId > 0}
                    · <span title={$t('doctor.withoutRequestIdTip')}>{$t('doctor.withoutRequestIdN', { values: { n: formatInt(a.noRequestId), extra: a.noRequestIdWithUsage > 0 ? $t('doctor.withUsageN', { values: { n: formatInt(a.noRequestIdWithUsage) } }) : '' } })}</span>
                  {/if}
                </div>
                <div class="mt-0.5 text-xs {a.agrees ? 'text-ink-2' : 'text-red'}">{foldSentence(a)}</div>
                {#if !a.agrees}
                  <p class="mt-1 text-xs text-red">
                    {$t('doctor.disagreeLead')}<span class="nums">{formatCompact(a.folded)}</span> {$t('doctor.disagreeVs')} <span class="nums">{formatCompact(a.modelFolded)}</span>{$t('doctor.disagreeTail')}
                  </p>
                {/if}
                {#if a.policy.mode !== 'request_max' && a.globalFolded !== a.folded}
                  <p class="mt-1 text-xs text-orange">
                    {$t('doctor.declaresLead')} {a.policy.mode}{$t('doctor.declaresMid')}
                    <span class="nums">{formatCompact(a.globalFolded)}</span> {$t('doctor.insteadOf')} <span class="nums">{formatCompact(a.folded)}</span>{$t('doctor.declaresEnd')}
                  </p>
                {/if}
                {#if a.declared && (a.declared.mode !== a.policy.mode || a.declared.subagentsIncluded !== a.policy.subagentsIncluded)}
                  <p class="mt-1 text-xs text-orange">
                    {$t('doctor.itsAdapterNow')} <span class="nums">{a.declared.mode}</span>{a.declared.subagentsIncluded ? '' : ` ${$t('doctor.exclSubagents')}`}{$t('doctor.butRowsFolded')} <span class="nums">{a.policy.mode}</span>{a.policy.subagentsIncluded ? '' : ` ${$t('doctor.exclSubagents')}`} {$t('doctor.rowsNotNextScan')}
                  </p>
                {/if}
                {#if !a.declared}
                  <p class="mt-1 text-xs text-ink-3">{$t('doctor.noPolicyForIt')}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Surface>
    </div>

    <Surface
      title={$t('doctor.coverage')}
      info={$t('doctor.coverageInfo')}
    >
      <div class="space-y-3">
        {#if coverageLine}
          <Alert tone="orange" title={$t('banner.coverageTitle')}>{coverageLine}</Alert>
        {:else if d.coverage.incomplete}
          <Alert tone="orange" title={$t('doctor.historyMaybeIncomplete')}>
            {$t('doctor.unreachableNow', { values: { n: formatInt(d.coverage.unreachable.length) } })}
          </Alert>
        {:else}
          <p class="flex items-center gap-2 text-[13px] text-ink-2"><Chip tone="green">{$t('doctor.complete')}</Chip>{$t('doctor.historyLooksComplete')}</p>
        {/if}

        {#if d.coverage.emptyDirs.length}
          <div>
            <h4 class="mb-1 text-xs font-medium text-ink-3">{$t('doctor.emptyDirsHeading')}</h4>
            <ul class="max-h-40 overflow-y-auto text-xs">
              {#each d.coverage.emptyDirs as e (e.dir)}
                <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                  <span class="nums min-w-0 truncate text-ink-2" title={e.dir}>{e.dir}</span>
                  <span class="shrink-0 text-ink-3"><span class="nums">{formatInt(e.missingSources)}</span> {$t('doctor.missingWord')} · {e.agentIds.join(', ')}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if d.coverage.projectDirsWithoutSessions.length}
          <div>
            <h4 class="mb-1.5 text-xs font-medium text-ink-3">{$t('doctor.projectDirsHeading')}</h4>
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
                <span class="nums">{formatInt(retention.gone + retention.rotated)}</span> {$t('doctor.retentionUnreadable')}{$t('doctor.retentionGone')} <span class="nums">{formatInt(retention.gone)}</span> · {$t('doctor.retentionRotated')}
                <span class="nums">{formatInt(retention.rotated)}</span>{$t('doctor.retentionUnreadableTail')}
              </p>
            {/if}
            <p class="{retention.gone + retention.rotated > 0 ? 'mt-1 ' : ''}text-xs text-ink-3">
              <span class="nums">{formatInt(retention.active)}</span> {$t('doctor.retentionActiveTail')}
            </p>
          </div>
        {/if}

        <p class="border-t border-line-soft pt-3 text-xs text-ink-3">{$t('banner.limits')}</p>
      </div>
    </Surface>

    <Surface
      title={$t('doctor.subagentLinks')}
      info={$t('doctor.subagentLinksInfo')}
    >
      {#if subagents.length === 0}
        <p class="text-[13px] text-ink-3">{$t('doctor.noSubagentEvents')}</p>
      {:else}
        <dl class="text-[13px]">
          {#each subagents as s (s.agentId)}
            <div class={dlRow}>
              <dt class="min-w-0 truncate text-ink-2" title={s.agentId}>{s.agentId}</dt>
              <dd class="nums shrink-0 {s.orphan > 0 ? 'text-orange' : 'text-ink'}">
                {$t('doctor.orphanOf', { values: { orphan: formatInt(s.orphan), total: formatInt(s.total) } })} <span class="text-ink-3">({s.orphanPct.toFixed(1)}%)</span>
              </dd>
            </div>
          {/each}
        </dl>
        {#if subagents.some((s) => s.orphan > 0)}
          <p class="mt-3 text-xs text-ink-3">
            {$t('doctor.orphansCounted')}
          </p>
        {/if}
      {/if}
    </Surface>

    <Surface
      title={$t('doctor.stageOneTitle')}
      info={$t('doctor.stageOneInfo')}
    >
      {#if stageOne}
        <p class="text-[13px] {stageOne.ok ? 'text-ink' : 'text-orange'}">{stageOneNote(stageOne.code, stageOne)}</p>
        {#if !stageOne.ok}
          <p class="mt-2 text-xs text-ink-3">
            {$t('doctor.stageOneDeclinedLead')}<code>events</code>{$t('doctor.stageOneDeclinedTail')}
          </p>
        {/if}
      {:else}
        <p class="text-[13px] text-ink-3">{$t('doctor.stageOneNoReport')}</p>
      {/if}
    </Surface>

    <Surface
      title={$t('doctor.inventedTimestamps')}
      info={$t('doctor.inventedTimestampsInfo')}
    >
      {#if guessedTimestamps.length === 0}
        <p class="text-[13px] text-ink-3">{$t('doctor.allTsStated')}</p>
      {:else}
        <dl class="text-[13px]">
          {#each guessedTimestamps as g (g.agentId)}
            <div class={dlRow}>
              <dt class="min-w-0 truncate text-ink-2" title={g.agentId}>{g.agentId}</dt>
              <dd class="nums shrink-0 text-orange">
                {$t('doctor.guessedOf', { values: { g: formatInt(g.guessed), e: formatInt(g.events) } })}
                <span class="text-ink-3">({share(g.guessed, g.events)})</span>
              </dd>
            </div>
          {/each}
        </dl>
        <p class="mt-3 text-xs text-ink-3">
          {$t('doctor.tsWindowLead')} <span class="nums">--since</span>{$t('doctor.tsWindowMid')} <span class="nums">{formatInt(guessedTimestamps.reduce((n, g) => n + g.fromIngestClock, 0))}</span> {$t('doctor.tsScanClock')}
          <span class="nums">{formatInt(guessedTimestamps.reduce((n, g) => n + g.fromFileMtime, 0))}</span> {$t('doctor.tsFileMtime')}
        </p>
      {/if}
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title={$t('doctor.capabilities')} subtitle={$t('doctor.inSelectedWindow')}>
        {#if d.capabilities.length === 0}
          <p class="text-[13px] text-ink-3">{$t('doctor.noCapabilityEvents')}</p>
        {:else}
          <dl class="text-[13px]">
            {#each d.capabilities as c (c.type)}
              <div class={dlRow}>
                <dt class="text-ink-2">{c.type}</dt>
                <dd class="nums text-ink">
                  {formatInt(c.events)}{#if c.errors}<span class="text-red"> · {formatInt(c.errors)} {$t('doctor.errorsWord')}</span>{/if}
                </dd>
              </div>
            {/each}
          </dl>
        {/if}
        <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">
          {$t('doctor.catalogLabel')} {catalogNote(d.catalog.noteCode, { installed: d.catalog.installed, neverUsed: d.catalog.neverUsed, detail: d.catalog.noteDetail })}
        </p>
      </Surface>

      <Surface title={$t('doctor.pricing')} info={$t('doctor.pricingInfo')} class="flex-1">
        {#if d.pricing.pricingConfigured}
          <dl class="text-[13px]">
            <div class={dlRow}>
              <dt class="text-ink-3">{$t('doctor.modelsPriced')}</dt>
              <dd class="nums text-ink">{d.pricing.modelsPriced === null ? '—' : formatInt(d.pricing.modelsPriced)}</dd>
            </div>
            <div class={dlRow}><dt class="text-ink-3">{$t('doctor.modelsSeen')}</dt><dd class="nums text-ink">{formatInt(d.pricing.modelsSeen)}</dd></div>
          </dl>
          {#if d.pricing.missing.length}
            <div class="mt-3">
              <Alert tone="orange" title={$t('doctor.missingPriceAlert', { values: { n: formatInt(d.pricing.missing.length) } })}>
                <span class="nums">{d.pricing.missing.map((m) => m.model).join(', ')}</span>
              </Alert>
            </div>
          {/if}
        {:else}
          <Alert tone="orange" title={$t('doctor.noPriceTableTitle')}>{$t('doctor.allCostNa')}</Alert>
        {/if}
      </Surface>
    </div>

    <Surface title={$t('doctor.cost')} subtitle={$t('doctor.inSelectedWindow')}>
      <dl class="text-[13px]">
        <div class={dlRow}>
          <dt class="text-ink-3">{$t('doctor.costActual')}</dt>
          <dd><CostFigure value={d.cost.totalUsd} basis="actual" partial={d.cost.totalPartial} /></dd>
        </div>
        <div class={dlRow}>
          <dt class="text-ink-3">{$t('doctor.costApiEquiv')}</dt>
          <dd><CostFigure value={d.cost.apiEquivalentUsd} basis="est" partial={d.cost.apiEquivalentPartial} /></dd>
        </div>
        {#if d.cost.reportedUsd !== null}
          <div class={dlRow}>
            <dt class="text-ink-3">{$t('doctor.costReportedBy')}</dt>
            <dd><CostFigure value={d.cost.reportedUsd} basis="reported" /></dd>
          </div>
        {/if}
      </dl>
      {#if d.cost.unpricedAgents.length}
        <p class="mt-3 text-xs text-orange">{$t('doctor.noPriceFor', { values: { agents: d.cost.unpricedAgents.join(', ') } })}</p>
      {/if}
      <p class="mt-3 border-t border-line-soft pt-3 text-xs text-ink-3">{costBasis(d.cost.basisCode)}</p>
    </Surface>

    <div class="flex min-w-0 flex-col gap-4">
      <Surface title={$t('doctor.permissions')} info={$t('doctor.permissionsInfo')}>
        {#if d.permissions.length}
          <ul>
            {#each d.permissions as p, i (i)}
              <li class="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
                <span class="nums min-w-0 truncate text-xs text-ink-2" title={p.path}>{p.path}</span>
                {#if p.readable}<Chip tone="green">{$t('doctor.readable')}</Chip>{:else}<Chip tone="red">{$t('doctor.unreadable')}</Chip>{/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-[13px] text-ink-3">{$t('doctor.noPermissions')}</p>
        {/if}
      </Surface>

      <Surface
        title={$t('doctor.contentLayer')}
        info={$t('doctor.contentLayerInfo')}
        class="flex-1"
      >
        <dl class="text-[13px]">
          <div class={dlRow}>
            <dt class="text-ink-3">{$t('doctor.status')}</dt>
            <dd>{#if d.content.available}<Chip tone="orange">{$t('doctor.contentOn')}</Chip>{:else}<Chip tone="green">{$t('doctor.contentOff')}</Chip>{/if}</dd>
          </div>
          <div class={dlRow}><dt class="text-ink-3">{$t('doctor.payloadsStored')}</dt><dd class="nums text-ink">{formatInt(d.content.payloads)}</dd></div>
        </dl>
        <p class="mt-3 text-xs text-ink-3">{contentNote(d.content.noteCode)}</p>
      </Surface>
    </div>
  </div>
{/if}
